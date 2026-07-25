import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ServerRow } from '../db/models.js';
import type { DB } from '../db/index.js';
import { AppError, ValidationError } from '../lib/errors.js';
import { getFactorioAccount } from './factorioAccount.js';
import { serverFiles, type ModEntry } from './serverFiles.js';
import { KNOWN_BUNDLED_MODS } from './imageProfile.js';

const MOD_PORTAL_BASE = 'https://mods.factorio.com';

interface ModRelease {
  version: string;
  download_url: string;
  file_name: string;
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

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h

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
  /** Needs the DB to read the single global Factorio.com account for downloads. */
  constructor(private readonly db: DB) {}

  // Cached full mod catalog. The portal has no keyword-search endpoint, so we
  // fetch the whole listing (~13MB, one request) and filter/rank in-memory,
  // refreshing at most every CATALOG_TTL_MS. An in-flight promise dedupes
  // concurrent refreshes.
  private catalog: CatalogEntry[] = [];
  private catalogFetchedAt = 0;
  private catalogInFlight?: Promise<CatalogEntry[]>;

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

  /** Look up a mod's latest release on the portal. */
  async latestRelease(name: string): Promise<ModRelease> {
    const releases = await this.releases(name);
    return releases[releases.length - 1];
  }

  /** Look up a specific pinned version, or the latest if `version` is undefined. */
  async getRelease(name: string, version?: string): Promise<ModRelease> {
    if (!version) return this.latestRelease(name);
    const releases = await this.releases(name);
    const match = releases.find((r) => r.version === version);
    if (!match) throw new ValidationError(`Mod "${name}" has no release ${version}`);
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
    const release = await this.getRelease(name, version);
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
  ): Promise<{ downloaded: { name: string; version: string }[]; errors: { name: string; error: string }[] }> {
    serverFiles.writeModList(server.id, entries);
    const downloaded: { name: string; version: string }[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const entry of entries) {
      if (!entry.enabled || BUNDLED_MODS.has(entry.name)) continue;
      try {
        const version = await this.downloadMod(server, entry.name, entry.version);
        downloaded.push({ name: entry.name, version });
      } catch (err) {
        errors.push({ name: entry.name, error: (err as Error).message });
      }
    }
    return { downloaded, errors };
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
      const zip = new AdmZip(data);
      // Mod zips contain `<name>_<version>/info.json`; pick the shallowest info.json.
      const infoEntry = zip
        .getEntries()
        .filter((e) => e.entryName.endsWith('/info.json') || e.entryName === 'info.json')
        .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0];
      if (!infoEntry) throw new Error('no info.json inside zip');
      const info = JSON.parse(infoEntry.getData().toString('utf8')) as {
        name?: string;
        version?: string;
      };
      if (!info.name || !info.version) throw new Error('info.json missing name/version');
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
  ): Promise<{ updated: { name: string; version: string }[]; errors: { name: string; error: string }[] }> {
    const updated: { name: string; version: string }[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const entry of serverFiles.readModList(server.id)) {
      if (!entry.enabled || BUNDLED_MODS.has(entry.name)) continue;
      try {
        // Force latest: ignore any pin.
        const version = await this.downloadMod(server, entry.name);
        updated.push({ name: entry.name, version });
      } catch (err) {
        errors.push({ name: entry.name, error: (err as Error).message });
      }
    }
    return { updated, errors };
  }

  /** Export a shareable manifest of a server's mod list (names + enabled flags). */
  exportManifest(serverId: string): { mods: ModEntry[] } {
    return { mods: serverFiles.readModList(serverId) };
  }
}
