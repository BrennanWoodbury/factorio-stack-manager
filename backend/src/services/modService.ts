import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ServerRow } from '../db/models.js';
import type { DB } from '../db/index.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { getFactorioAccount } from './factorioAccount.js';
import { serverFiles, type ModEntry } from './serverFiles.js';
import {
  KNOWN_BUNDLED_MODS,
  parseDependencies,
  type ImageProfileService,
  type ModDependency,
} from './imageProfile.js';
import { gameSeries, installedFromInfo, type InstalledMod } from './modCompat.js';

const MOD_PORTAL_BASE = 'https://mods.factorio.com';

/**
 * Reports which mod a multi-mod download is on, so a background job can show
 * progress instead of the UI just waiting.
 */
export interface ModProgress {
  (p: { current: string | null; completed: number; total: number }): void;
}

/**
 * A mod zip's manifest, or undefined when it isn't one. Mod zips contain
 * `<name>_<version>/info.json`, so the shallowest info.json is the mod's own —
 * a mod that bundles another mod's zip must not be misread as that mod.
 */
function readModZipInfo(data: Buffer): InstalledMod | undefined {
  const zip = new AdmZip(data);
  const infoEntry = zip
    .getEntries()
    .filter((e) => e.entryName.endsWith('/info.json') || e.entryName === 'info.json')
    .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0];
  if (!infoEntry) throw new Error('no info.json inside zip');
  return installedFromInfo(JSON.parse(infoEntry.getData().toString('utf8')));
}

interface ModRelease {
  version: string;
  download_url: string;
  file_name: string;
  /** `factorio_version` is the game series the release was built for, e.g. "2.0". */
  info_json?: { factorio_version?: string };
}
interface ModInfoResponse {
  name: string;
  releases?: ModRelease[];
}

/** Trimmed mod catalog entry we cache and search over. */
export interface CatalogEntry {
  name: string;
  title: string;
  owner: string;
  summary: string;
  downloadsCount: number;
  category: string;
  latestVersion?: string;
  factorioVersion?: string;
}

/** Shape of a result in the portal's `/api/mods?page_size=max` listing. */
interface PortalListEntry {
  name: string;
  title: string;
  owner: string;
  summary: string;
  downloads_count: number;
  category?: string;
  latest_release?: { version?: string; info_json?: { factorio_version?: string } };
}

/** Shape of the portal's `/api/mods/<name>/full` response (the parts we read). */
interface PortalFullEntry {
  name: string;
  title?: string;
  releases?: {
    version: string;
    info_json?: { dependencies?: unknown; factorio_version?: string };
  }[];
}

/** A dependency the user is being asked to add, with catalog metadata for display. */
export interface ResolvedDependency {
  name: string;
  title: string;
  summary: string;
  downloadsCount: number;
  /** Version constraint as the mod author wrote it, e.g. ">= 0.14.0". Display only. */
  constraint?: string;
  /** The mod that pulled this in — the requested mod, or a dependency of it. */
  via: string;
  /** Optional deps only: `+` means the game enables it by default. */
  defaultEnabled?: boolean;
  /** Optional deps only: `(?)` hidden optional. */
  hidden?: boolean;
  /** Incompatible deps only: whether the conflicting mod is already in the list. */
  installed?: boolean;
}

/** What adding a mod would pull in, for the approve/cancel dialog. */
export interface DependencyResolution {
  name: string;
  title: string;
  /** Hard dependencies that are not installed yet — added on approve. */
  required: ResolvedDependency[];
  /** Optional dependencies of the requested mod — added only if ticked. */
  optional: ResolvedDependency[];
  /** `!` conflicts found anywhere in the required closure. Advisory only. */
  incompatible: ResolvedDependency[];
  /** Hard dependencies already covered: installed, or shipped with the game. */
  satisfied: string[];
  /** Hard dependencies with no mod portal entry — cannot be added automatically. */
  missing: string[];
  /** True when the closure hit MAX_DEPENDENCY_NODES and may be incomplete. */
  truncated: boolean;
}

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MOD_DETAIL_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Safety valve on the transitive walk: one `/full` request per node, so a
 * pathological graph would otherwise hammer the portal. Overhaul mods sit around
 * 20 nodes; 100 leaves plenty of headroom.
 */
const MAX_DEPENDENCY_NODES = 100;

/**
 * Mods that ship with the game data and must NOT be downloaded from the mod
 * portal: `base` (always) and the official expansion mods, which come bundled
 * with the DLC. They can be enabled in mod-list.json but the manager never tries
 * to fetch them (that would fail — they aren't standard portal downloads). The
 * server uses the copies present in its own game data.
 *
 * Deliberately the cross-version superset rather than a per-image list: whether a
 * name is portal-fetchable can't depend on which image a given server runs.
 */
const BUNDLED_MODS = KNOWN_BUNDLED_MODS;

/**
 * Mod management via the Factorio Mod Portal API.
 *
 * Why the API rather than the image's UPDATE_MODS_ON_START:
 *  - We can validate a mod name and surface "no such mod / download failed" to the
 *    UI *before* the container starts, instead of discovering it from a crash loop
 *    in container logs.
 *  - We control ordering and can remove stale versions deterministically.
 * Tradeoff: more code here, and we must handle Mod Portal auth ourselves (the
 * per-server portal username/token). Dependency resolution is intentionally out
 * of scope for the MVP — enabling a mod downloads that mod's latest release only.
 */
export class ModService {
  /**
   * The DB supplies the single global Factorio.com account used for downloads.
   *
   * `imageProfiles` is what makes downloads game-version aware. It is optional so
   * unit tests can construct a portal-only service; when absent, or when the
   * server's image isn't pulled yet, release selection falls back to "newest" and
   * the pre-start check in modCompat is what catches an unloadable mod.
   */
  constructor(
    private readonly db: DB,
    private readonly imageProfiles?: ImageProfileService,
  ) {}

  /**
   * The Factorio series a server runs ("2.0"), or undefined when it can't be known
   * without pulling a ~600 MB image — never worth blocking a mod download on.
   */
  private async seriesFor(server: ServerRow): Promise<string | undefined> {
    if (!this.imageProfiles) return undefined;
    try {
      const profile = await this.imageProfiles.peekServer(server);
      return profile ? gameSeries(profile.gameVersion) || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  // Cached full mod catalog. The portal has no keyword-search endpoint, so we
  // fetch the whole listing (~13MB, one request) and filter/rank in-memory,
  // refreshing at most every CATALOG_TTL_MS. An in-flight promise dedupes
  // concurrent refreshes.
  private catalog: CatalogEntry[] = [];
  private catalogFetchedAt = 0;
  private catalogInFlight?: Promise<CatalogEntry[]>;

  // Per-mod dependency lists from the `/full` endpoint. `deps: undefined` caches a
  // 404 so a missing dependency isn't re-requested on every resolve.
  private depsCache = new Map<string, { at: number; deps: ModDependency[] | undefined }>();

  private async ensureCatalog(force = false): Promise<CatalogEntry[]> {
    const fresh = Date.now() - this.catalogFetchedAt < CATALOG_TTL_MS;
    if (!force && fresh && this.catalog.length > 0) return this.catalog;
    if (this.catalogInFlight) return this.catalogInFlight;

    this.catalogInFlight = (async () => {
      let res: Response;
      try {
        res = await fetch(`${MOD_PORTAL_BASE}/api/mods?page_size=max`, {
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new AppError(`Mod portal unreachable: ${(err as Error).message}`, 502, 'MOD_PORTAL');
      }
      if (!res.ok) throw new AppError(`Mod portal HTTP ${res.status}`, 502, 'MOD_PORTAL');
      const body = (await res.json()) as { results?: PortalListEntry[] };
      this.catalog = (body.results ?? [])
        // Drop the portal's reserved/placeholder stubs and the mods that ship with
        // the game (never portal-fetchable). NOT filtered by category: `internal`
        // is a real portal category for library/asset mods and holds flib, stdlib,
        // and the Space Exploration graphics parts other mods hard-depend on.
        .filter(
          (r) =>
            r.title &&
            r.title !== '[placeholder]' &&
            r.title !== '[reserved]' &&
            !BUNDLED_MODS.has(r.name),
        )
        .map((r) => ({
          name: r.name,
          title: r.title,
          owner: r.owner,
          summary: r.summary ?? '',
          downloadsCount: r.downloads_count ?? 0,
          category: r.category ?? '',
          latestVersion: r.latest_release?.version,
          factorioVersion: r.latest_release?.info_json?.factorio_version,
        }));
      this.catalogFetchedAt = Date.now();
      return this.catalog;
    })();

    try {
      return await this.catalogInFlight;
    } finally {
      this.catalogInFlight = undefined;
    }
  }

  /**
   * Search the mod catalog by keyword. Matches against name/title/owner, ranks
   * exact-name and prefix matches first, then by download count. Returns at most
   * `limit` trimmed entries.
   */
  async search(query: string, limit = 25): Promise<CatalogEntry[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const catalog = await this.ensureCatalog();
    const scored: { entry: CatalogEntry; rank: number }[] = [];
    for (const entry of catalog) {
      const name = entry.name.toLowerCase();
      const title = entry.title.toLowerCase();
      const owner = entry.owner.toLowerCase();
      let rank: number;
      if (name === q || title === q) rank = 0;
      else if (name.startsWith(q) || title.startsWith(q)) rank = 1;
      else if (name.includes(q) || title.includes(q)) rank = 2;
      else if (owner.includes(q) || entry.summary.toLowerCase().includes(q)) rank = 3;
      else continue;
      scored.push({ entry, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || b.entry.downloadsCount - a.entry.downloadsCount);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /* ---------------------------------------------------------------- *
   * Dependency resolution
   * ---------------------------------------------------------------- */

  /**
   * Dependencies declared by a mod's newest release, or undefined when the portal
   * has no such mod. Cached per name — a single resolve visits each node once,
   * but overhaul packs share dependencies heavily across resolves.
   *
   * The listing endpoint's `info_json` carries only `factorio_version`, so this
   * has to be the per-mod `/full` endpoint.
   */
  private async dependenciesOf(name: string): Promise<ModDependency[] | undefined> {
    const hit = this.depsCache.get(name);
    if (hit && Date.now() - hit.at < MOD_DETAIL_TTL_MS) return hit.deps;

    let res: Response;
    try {
      res = await fetch(`${MOD_PORTAL_BASE}/api/mods/${encodeURIComponent(name)}/full`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AppError(`Mod portal unreachable: ${(err as Error).message}`, 502, 'MOD_PORTAL');
    }
    if (res.status === 404) {
      this.depsCache.set(name, { at: Date.now(), deps: undefined });
      return undefined;
    }
    if (!res.ok) throw new AppError(`Mod portal HTTP ${res.status}`, 502, 'MOD_PORTAL');
    const info = (await res.json()) as PortalFullEntry;
    // Releases come oldest-first, same as the download path assumes.
    const latest = info.releases?.[info.releases.length - 1];
    const deps = parseDependencies(latest?.info_json?.dependencies);
    this.depsCache.set(name, { at: Date.now(), deps });
    return deps;
  }

  /**
   * Work out everything adding `name` would pull in, for the approve/cancel
   * dialog. Walks hard dependencies transitively; optional dependencies are
   * reported for the requested mod only, since an optional's optionals are not
   * something the user asked about.
   *
   * Mods already in `installed` are treated as satisfied and are not walked into:
   * whatever they needed was resolved when they were added, and re-walking them
   * would fill the dialog with things the user never touched.
   *
   * Nothing here enforces version constraints — the download path always takes a
   * mod's latest release, so constraints are surfaced as text for the user to judge.
   */
  async resolveDependencies(
    name: string,
    installed: readonly string[] = [],
  ): Promise<DependencyResolution> {
    const rootDeps = await this.dependenciesOf(name);
    if (!rootDeps) throw new ValidationError(`Mod "${name}" not found on the mod portal`);

    const catalog = await this.ensureCatalog();
    const meta = new Map(catalog.map((e) => [e.name, e]));
    const have = new Set(installed);
    const covered = (dep: string) => have.has(dep) || BUNDLED_MODS.has(dep);

    const describe = (dep: ModDependency, via: string): ResolvedDependency => {
      const entry = meta.get(dep.name);
      return {
        name: dep.name,
        title: entry?.title ?? dep.name,
        summary: entry?.summary ?? '',
        downloadsCount: entry?.downloadsCount ?? 0,
        constraint: dep.constraint,
        via,
      };
    };

    const required = new Map<string, ResolvedDependency>();
    const incompatible = new Map<string, ResolvedDependency>();
    const satisfied = new Set<string>();
    const missing = new Set<string>();
    const visited = new Set<string>([name]);
    let truncated = false;

    // Breadth-first so `via` names the shallowest mod that pulled a dep in, and
    // so each level's portal lookups go out in parallel.
    let frontier: { deps: ModDependency[]; via: string }[] = [{ deps: rootDeps, via: name }];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const { deps, via } of frontier) {
        for (const dep of deps) {
          if (dep.kind === 'incompatible') {
            if (!incompatible.has(dep.name)) {
              incompatible.set(dep.name, { ...describe(dep, via), installed: have.has(dep.name) });
            }
            continue;
          }
          if (dep.kind === 'optional') continue; // collected from the root separately
          if (covered(dep.name)) {
            satisfied.add(dep.name);
            continue;
          }
          if (visited.has(dep.name)) continue;
          visited.add(dep.name);
          if (!meta.has(dep.name)) {
            // Not in the catalog: renamed, unlisted, or a typo in the manifest.
            missing.add(dep.name);
            continue;
          }
          required.set(dep.name, describe(dep, via));
          if (visited.size > MAX_DEPENDENCY_NODES) {
            truncated = true;
            continue;
          }
          next.push(dep.name);
        }
      }
      const fetched = await Promise.all(
        next.map(async (dep) => ({ deps: (await this.dependenciesOf(dep)) ?? [], via: dep })),
      );
      frontier = fetched.filter((f) => f.deps.length > 0);
    }

    const optional = rootDeps
      .filter((d) => d.kind === 'optional' && !covered(d.name) && meta.has(d.name))
      .map((d) => ({
        ...describe(d, name),
        defaultEnabled: d.defaultEnabled,
        hidden: d.hidden,
      }));

    const byDownloads = (a: ResolvedDependency, b: ResolvedDependency) =>
      b.downloadsCount - a.downloadsCount;

    return {
      name,
      title: meta.get(name)?.title ?? name,
      required: [...required.values()].sort(byDownloads),
      optional: optional.sort(byDownloads),
      incompatible: [...incompatible.values()].sort(byDownloads),
      satisfied: [...satisfied].sort(),
      missing: [...missing].sort(),
      truncated,
    };
  }

  /** Fetch a mod's full release list from the portal. */
  private async releases(name: string): Promise<ModRelease[]> {
    let res: Response;
    try {
      res = await fetch(`${MOD_PORTAL_BASE}/api/mods/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AppError(`Mod portal unreachable: ${(err as Error).message}`, 502, 'MOD_PORTAL');
    }
    if (res.status === 404) throw new ValidationError(`Mod "${name}" not found on the mod portal`);
    if (!res.ok) throw new AppError(`Mod portal HTTP ${res.status}`, 502, 'MOD_PORTAL');
    const info = (await res.json()) as ModInfoResponse;
    const releases = info.releases ?? [];
    if (releases.length === 0) throw new ValidationError(`Mod "${name}" has no releases`);
    return releases;
  }

  /**
   * A mod's newest release, restricted to ones built for `gameSeries` ("2.0") when
   * given.
   *
   * "Newest" alone is wrong far more often than it looks: of the 22k mods on the
   * portal, only ~3k have a 2.1 latest release, and 17 of the 100 most-downloaded
   * mods have a latest release that isn't 2.1. Installing one of those produces a
   * container that exits(1) on startup and restarts forever, so refusing here with
   * a message naming the version is strictly better than letting it through.
   */
  async latestRelease(name: string, gameSeries?: string): Promise<ModRelease> {
    const releases = await this.releases(name);
    if (!gameSeries) return releases[releases.length - 1];
    const compatible = releases.filter(
      // A release with no declared version is taken as usable rather than skipped.
      (r) => !r.info_json?.factorio_version || r.info_json.factorio_version === gameSeries,
    );
    if (compatible.length === 0) {
      const latest = releases[releases.length - 1];
      throw new ValidationError(
        `Mod "${name}" has no release for Factorio ${gameSeries} ` +
          `(newest is ${latest.version} for ${latest.info_json?.factorio_version ?? 'an unknown version'}).`,
      );
    }
    return compatible[compatible.length - 1];
  }

  /**
   * A specific pinned version, or the newest compatible one when unpinned. A pin
   * that names a release built for another Factorio series is refused rather than
   * honoured — the pin cannot be satisfied on this server whatever we download.
   */
  async getRelease(name: string, version?: string, gameSeries?: string): Promise<ModRelease> {
    if (!version) return this.latestRelease(name, gameSeries);
    const releases = await this.releases(name);
    const match = releases.find((r) => r.version === version);
    if (!match) throw new ValidationError(`Mod "${name}" has no release ${version}`);
    const declared = match.info_json?.factorio_version;
    if (gameSeries && declared && declared !== gameSeries) {
      throw new ValidationError(
        `Mod "${name}" is pinned to ${version}, which is built for Factorio ${declared}, ` +
          `not ${gameSeries}.`,
      );
    }
    return match;
  }

  /**
   * Download a mod release into the server's mods dir. `version` pins a specific
   * release; omit for latest. Returns the downloaded version.
   */
  async downloadMod(server: ServerRow, name: string, version?: string): Promise<string> {
    const account = getFactorioAccount(this.db);
    if (!account.username || !account.token) {
      throw new ValidationError(
        'A Factorio.com account is required to download mods; set it in global settings',
      );
    }
    const release = await this.getRelease(name, version, await this.seriesFor(server));
    const url =
      `${MOD_PORTAL_BASE}${release.download_url}` +
      `?username=${encodeURIComponent(account.username)}` +
      `&token=${encodeURIComponent(account.token)}`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new AppError(`Mod download failed: ${(err as Error).message}`, 502, 'MOD_PORTAL');
    }
    if (res.status === 403) {
      throw new ValidationError('Mod portal rejected credentials (check username/token)');
    }
    if (!res.ok) throw new AppError(`Mod download HTTP ${res.status}`, 502, 'MOD_PORTAL');

    const modsDir = serverFiles.modsDir(server.id);
    fs.mkdirSync(modsDir, { recursive: true });
    // Remove any previously-downloaded versions of this mod to avoid conflicts.
    for (const f of fs.existsSync(modsDir) ? fs.readdirSync(modsDir) : []) {
      if (f.endsWith('.zip') && f.startsWith(`${name}_`)) fs.rmSync(path.join(modsDir, f));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(modsDir, release.file_name), buf);
    return release.version;
  }

  /**
   * Apply a desired mod list: write mod-list.json and download the zip for every
   * enabled non-base mod. Returns per-mod results so the caller/UI can report
   * partial failures without aborting the whole operation.
   */
  async applyModList(
    server: ServerRow,
    entries: ModEntry[],
    onProgress?: ModProgress,
  ): Promise<{ downloaded: { name: string; version: string }[]; errors: { name: string; error: string }[] }> {
    this.setModList(server.id, entries);
    return this.downloadList(server, entries, onProgress);
  }

  /** Write mod-list.json without touching the zips. */
  setModList(serverId: string, entries: ModEntry[]): void {
    serverFiles.writeModList(serverId, entries);
  }

  /**
   * Download the zip for every enabled non-base entry, reporting progress as it
   * goes. Split out from `applyModList` so a caller can write the list inside the
   * request (fast, and what the UI wants back immediately) and run the downloads
   * as a background job.
   */
  async downloadList(
    server: ServerRow,
    entries: ModEntry[],
    onProgress?: ModProgress,
  ): Promise<{ downloaded: { name: string; version: string }[]; errors: { name: string; error: string }[] }> {
    const wanted = entries.filter((e) => e.enabled && !BUNDLED_MODS.has(e.name));
    const downloaded: { name: string; version: string }[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const [i, entry] of wanted.entries()) {
      onProgress?.({ current: entry.name, completed: i, total: wanted.length });
      try {
        const version = await this.downloadMod(server, entry.name, entry.version);
        downloaded.push({ name: entry.name, version });
      } catch (err) {
        errors.push({ name: entry.name, error: (err as Error).message });
      }
    }
    onProgress?.({ current: null, completed: wanted.length, total: wanted.length });
    return { downloaded, errors };
  }

  /**
   * Manifests of every mod zip in a server's mods dir. Unreadable zips are skipped
   * rather than thrown on: a corrupt file shows up as its mod being "not
   * downloaded", which is both true and actionable, instead of failing the whole
   * pre-start check.
   */
  installedMods(serverId: string): InstalledMod[] {
    const dir = serverFiles.modsDir(serverId);
    if (!fs.existsSync(dir)) return [];
    const out: InstalledMod[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.zip')) continue;
      try {
        const info = readModZipInfo(fs.readFileSync(path.join(dir, file)));
        if (info) out.push(info);
      } catch {
        /* not a readable mod zip — treated as absent */
      }
    }
    return out;
  }

  /**
   * Enabled mods with no zip on disk, in list order. Bundled mods never count —
   * they ship in the image and are not portal downloads.
   */
  missingMods(serverId: string, entries: ModEntry[] = this.getModList(serverId)): string[] {
    const installed = new Set(this.installedMods(serverId).map((m) => m.name));
    return entries
      .filter((e) => e.enabled && !BUNDLED_MODS.has(e.name) && !installed.has(e.name))
      .map((e) => e.name);
  }

  /**
   * Download whatever a server has enabled but doesn't have on disk.
   *
   * This is what makes a mod list self-healing: applying a pack writes the list
   * before the downloads run, so any failure used to leave the list enabled with
   * no zips and no way back except a manual re-save. Returns the failures rather
   * than throwing, so the caller can report every one instead of the first.
   */
  async downloadMissing(server: ServerRow): Promise<{ name: string; error: string }[]> {
    const failures: { name: string; error: string }[] = [];
    const entries = this.getModList(server.id);
    const byName = new Map(entries.map((e) => [e.name, e]));
    for (const name of this.missingMods(server.id, entries)) {
      try {
        await this.downloadMod(server, name, byName.get(name)?.version);
      } catch (err) {
        failures.push({ name, error: (err as Error).message });
      }
    }
    return failures;
  }

  getModList(serverId: string): ModEntry[] {
    return serverFiles.readModList(serverId);
  }

  /**
   * Install a mod from an uploaded .zip. Reads the real name+version from the
   * zip's info.json (rather than trusting the filename), stores it as
   * `<name>_<version>.zip`, removes older versions of the same mod, and adds it
   * to mod-list.json enabled.
   */
  uploadModZip(serverId: string, data: Buffer): { name: string; version: string } {
    let name: string;
    let version: string;
    try {
      const info = readModZipInfo(data);
      if (!info) throw new Error('info.json missing name/version');
      name = info.name;
      version = info.version;
    } catch (err) {
      throw new ValidationError(`Not a valid Factorio mod zip: ${(err as Error).message}`);
    }

    const modsDir = serverFiles.modsDir(serverId);
    fs.mkdirSync(modsDir, { recursive: true });
    for (const f of fs.readdirSync(modsDir)) {
      if (f.endsWith('.zip') && f.startsWith(`${name}_`)) fs.rmSync(path.join(modsDir, f));
    }
    fs.writeFileSync(path.join(modsDir, `${name}_${version}.zip`), data);

    const list = serverFiles.readModList(serverId);
    if (!list.some((m) => m.name === name)) list.push({ name, enabled: true });
    serverFiles.writeModList(serverId, list);
    return { name, version };
  }

  /** Reset a server's mods to just `base` and delete all downloaded zips. */
  deleteAllMods(serverId: string): void {
    const modsDir = serverFiles.modsDir(serverId);
    if (fs.existsSync(modsDir)) {
      for (const f of fs.readdirSync(modsDir)) {
        if (f.endsWith('.zip')) fs.rmSync(path.join(modsDir, f));
      }
    }
    serverFiles.writeModList(serverId, [{ name: 'base', enabled: true }]);
  }

  /** Re-download the latest release of every enabled non-base mod. */
  async updateAll(
    server: ServerRow,
    onProgress?: ModProgress,
  ): Promise<{ updated: { name: string; version: string }[]; errors: { name: string; error: string }[] }> {
    const updated: { name: string; version: string }[] = [];
    const errors: { name: string; error: string }[] = [];
    const wanted = serverFiles
      .readModList(server.id)
      .filter((e) => e.enabled && !BUNDLED_MODS.has(e.name));
    for (const [i, entry] of wanted.entries()) {
      onProgress?.({ current: entry.name, completed: i, total: wanted.length });
      try {
        // Force latest: ignore any pin.
        const version = await this.downloadMod(server, entry.name);
        updated.push({ name: entry.name, version });
      } catch (err) {
        errors.push({ name: entry.name, error: (err as Error).message });
      }
    }
    onProgress?.({ current: null, completed: wanted.length, total: wanted.length });
    return { updated, errors };
  }

  /** Export a shareable manifest of a server's mod list (names + enabled flags). */
  exportManifest(serverId: string): { mods: ModEntry[] } {
    return { mods: serverFiles.readModList(serverId) };
  }
}
