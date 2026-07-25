import fs from 'node:fs';
import path from 'node:path';
import type { IconCache } from './iconCache.js';
import { localInstallMatches } from './factorioAssets.js';
import { getLogger } from '../lib/logger.js';

const defaultLog = getLogger('icons');

/**
 * Decides *whether* and *from where* to populate the icon cache for the Factorio
 * versions currently in use.
 *
 * Sources are tried in cost order, which matters a great deal here: the icons are
 * ~9 MB inside a ~4.6 GB install, so the download path must never run
 * speculatively.
 *
 *   1. cache hit          - free
 *   2. local install      - free, but only on an exact version match
 *   3. Download API       - multi-GB, so only for a version with no cache
 *
 * Everything is injected rather than reached for directly, so the policy above is
 * testable without Docker, without credentials and without a multi-gigabyte
 * download.
 */

export type IconSource = 'cached' | 'local-install' | 'download';

export interface VersionRequest {
  /** Resolved Factorio version, e.g. `2.0.77`. */
  version: string;
  /** Mod set, when known. Vanilla collapses to the bare version as the key. */
  mods?: string[];
}

export interface SyncOutcome {
  version: string;
  key?: string;
  source: IconSource | 'skipped' | 'failed';
  copied?: number;
  missing?: number;
  reason?: string;
}

export interface IconSyncDeps {
  cache: IconCache;
  /** Versions in use right now — from each server's resolved image tag. */
  resolveVersions: () => Promise<VersionRequest[]>;
  /** Path to a local Factorio install, if the operator configured one. */
  localInstallDir?: string;
  /** Produce `data.raw` for a version. Runs the headless one-shot with --dump-data. */
  dumpDataRaw: (version: string) => Promise<unknown>;
  /**
   * Fetch + unpack a build, returning the path to its `data` dir. Omit to disable
   * the download path entirely (icons then come only from a local install).
   */
  fetchInstall?: (version: string) => Promise<string>;
  log?: (msg: string) => void;
}

export class IconSync {
  constructor(private readonly deps: IconSyncDeps) {}

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => defaultLog.info(m)))(msg);
  }

  /** Cache key a request would use, if a cache for it already exists. */
  private existingKeyFor(req: VersionRequest): string | undefined {
    const { cache } = this.deps;
    // A vanilla key is exactly the version; a modded one is `<version>-<hash>`.
    // We cannot know the hash before reading a dump, so match on the prefix.
    return cache.list().find((k) => k === req.version || k.startsWith(`${req.version}-`));
  }

  /**
   * Ensure every in-use version has icons. Failures are logged and reported, never
   * thrown: missing icons degrade the UI (a placeholder instead of a picture) but
   * must never stop the manager from starting or a scan from running.
   */
  async syncAll(): Promise<SyncOutcome[]> {
    this.deps.cache.cleanTemp();

    let requests: VersionRequest[];
    try {
      requests = await this.deps.resolveVersions();
    } catch (err) {
      this.log(`could not resolve versions in use: ${(err as Error).message}`);
      return [];
    }

    const seen = new Set<string>();
    const outcomes: SyncOutcome[] = [];
    for (const req of requests) {
      if (seen.has(req.version)) continue;
      seen.add(req.version);
      outcomes.push(await this.ensure(req));
    }

    // Keep only what is in use, plus always at least one cache to render with.
    const keep = new Set(outcomes.map((o) => o.key).filter((k): k is string => Boolean(k)));
    const pruned = this.deps.cache.prune(keep);
    if (pruned.length > 0) this.log(`pruned unused icon caches: ${pruned.join(', ')}`);

    return outcomes;
  }

  /** Ensure icons exist for one version, choosing the cheapest viable source. */
  async ensure(req: VersionRequest): Promise<SyncOutcome> {
    const existing = this.existingKeyFor(req);
    if (existing) {
      return { version: req.version, key: existing, source: 'cached' };
    }

    let dataRaw: unknown;
    try {
      dataRaw = await this.deps.dumpDataRaw(req.version);
    } catch (err) {
      const reason = `could not dump prototypes: ${(err as Error).message}`;
      this.log(`${req.version}: ${reason}`);
      return { version: req.version, source: 'failed', reason };
    }

    // 2. A local install, but only on an exact version match. Icon paths move
    //    between mods across releases, so a near-miss silently loses icons.
    if (localInstallMatches(this.deps.localInstallDir, req.version)) {
      const dataDir = path.join(this.deps.localInstallDir as string, 'data');
      try {
        const res = this.deps.cache.build({
          dataRaw,
          dataDir,
          version: req.version,
          mods: req.mods,
        });
        this.log(
          `${req.version}: built from local install (${res.copied} icons, ${(res.bytes / 1048576).toFixed(1)} MB)`,
        );
        return {
          version: req.version,
          key: res.key,
          source: 'local-install',
          copied: res.copied,
          missing: res.missing.length,
        };
      } catch (err) {
        this.log(`${req.version}: local install unusable (${(err as Error).message}), trying download`);
      }
    }

    // 3. The expensive path.
    if (!this.deps.fetchInstall) {
      const reason = 'no local install for this version and downloading is disabled';
      this.log(`${req.version}: ${reason}`);
      return { version: req.version, source: 'skipped', reason };
    }

    try {
      this.log(`${req.version}: downloading game assets (this is a multi-GB one-off)`);
      const dataDir = await this.deps.fetchInstall(req.version);
      const res = this.deps.cache.build({ dataRaw, dataDir, version: req.version, mods: req.mods });
      this.log(`${req.version}: built from download (${res.copied} icons)`);
      return {
        version: req.version,
        key: res.key,
        source: 'download',
        copied: res.copied,
        missing: res.missing.length,
      };
    } catch (err) {
      const reason = (err as Error).message;
      this.log(`${req.version}: download failed (${reason})`);
      return { version: req.version, source: 'failed', reason };
    }
  }
}

/**
 * Startup + nightly icon sync.
 *
 * Runs once shortly after boot and then daily. Deliberately fire-and-forget: the
 * manager must serve requests immediately, and a missing icon is a placeholder,
 * not an error. Mirrors the BackupJob/DraftPruneJob shape.
 */
export class IconSyncJob {
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private running = false;
  private readonly intervalMs = 24 * 60 * 60 * 1000;
  /** Small delay so boot is never blocked behind a dump or a copy. */
  private readonly startupDelayMs = 10_000;

  constructor(private readonly sync: IconSync) {}

  start(): void {
    if (this.timer) return;
    this.startupTimer = setTimeout(() => void this.runOnce(), this.startupDelayMs);
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    defaultLog.info('sync scheduled (startup + nightly)');
  }

  /** Guarded so a slow build can never overlap the next tick. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sync.syncAll();
    } catch (err) {
      defaultLog.warn(`sync failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
  }
}

/** True when a directory looks like a Factorio install (`data/base/info.json`). */
export function looksLikeInstall(dir: string | undefined): boolean {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'data', 'base', 'info.json'));
}
