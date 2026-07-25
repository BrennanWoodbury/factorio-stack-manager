import fs from 'node:fs';
import path from 'node:path';
import { serversDir, config, getHostServersDir } from '../config.js';
import type { ServerRow } from '../db/models.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('serverFiles');

export interface ModEntry {
  name: string;
  enabled: boolean;
  version?: string;
}

/** Whether a backup was made on demand ('manual') or by the scheduler ('auto'). */
export type BackupKind = 'manual' | 'auto';

export interface BackupInfo {
  name: string;
  source: string;
  kind: BackupKind;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Manages the on-disk data directory for each server. The manager reads/writes
 * via its own local mount (`serversDir/<id>`); the *same* directory is bind-
 * mounted into the Factorio container at `/factorio` using the host path
 * (`getHostServersDir()/<id>`), which is what DockerService receives — resolved at
 * startup from the manager's own mount table when possible.
 *
 * Layout (mirrors what the factoriotools image expects under /factorio):
 *   <id>/saves/         *.zip save files
 *   <id>/mods/          mod-list.json + downloaded mod zips
 *   <id>/config/        server-settings.json
 */
export class ServerFilesService {
  localDir(serverId: string): string {
    return path.join(serversDir, serverId);
  }

  /** Path as the Docker daemon sees it, for the bind mount. */
  hostDir(serverId: string): string {
    return path.join(getHostServersDir(), serverId);
  }

  savesDir(serverId: string): string {
    return path.join(this.localDir(serverId), 'saves');
  }

  modsDir(serverId: string): string {
    return path.join(this.localDir(serverId), 'mods');
  }

  configDir(serverId: string): string {
    return path.join(this.localDir(serverId), 'config');
  }

  ensureDirs(serverId: string): void {
    for (const d of [this.savesDir(serverId), this.modsDir(serverId), this.configDir(serverId)]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  removeAll(serverId: string): void {
    fs.rmSync(this.localDir(serverId), { recursive: true, force: true });
  }

  /**
   * The three fields the manager keeps on the server row (edited via the basic
   * settings form). They are ALWAYS overlaid onto the advanced settings at write
   * time, so there is exactly one source of truth per field and no drift.
   */
  static readonly MANAGED_KEYS = ['name', 'description', 'max_players'] as const;

  /** Advanced server-settings defaults (everything except the managed keys). */
  defaultAdvancedSettings(): Record<string, unknown> {
    return {
      tags: ['factorio-stack-manager'],
      visibility: { public: false, lan: true },
      require_user_verification: true,
      max_upload_in_kilobytes_per_second: 0,
      max_upload_slots: 5,
      minimum_latency_in_ticks: 0,
      game_password: '',
      // Factorio 2.x spelling is "admins-only" (1.x used "admin-only"); the wrong
      // value makes the server refuse to start ("Invalid value ... AllowedCommands").
      allow_commands: 'admins-only',
      autosave_interval: 10,
      autosave_slots: 5,
      afk_autokick_interval: 0,
      auto_pause: true,
      only_admins_can_pause_the_game: true,
      autosave_only_on_server: true,
      // Default on: on Linux the server forks to autosave, so the game doesn't freeze
      // during a save. Factorio flags it "experimental"; toggle off in Advanced settings.
      non_blocking_saving: true,
    };
  }

  /** A server's SPARSE advanced-settings overrides (only the keys it overrode). */
  getServerOverrides(server: ServerRow): Record<string, unknown> {
    let stored: Record<string, unknown> = {};
    if (server.settings_json) {
      try {
        stored = JSON.parse(server.settings_json) as Record<string, unknown>;
      } catch {
        stored = {};
      }
    }
    const clean = { ...stored };
    for (const k of ServerFilesService.MANAGED_KEYS) delete clean[k];
    return clean;
  }

  /**
   * Effective advanced settings for a server: `base` (the global defaults, itself
   * hard-coded ⊕ the admin's global overrides) with this server's sparse overrides
   * merged on. Falls back to the hard-coded defaults when no base is given.
   */
  getAdvancedSettings(server: ServerRow, base?: Record<string, unknown>): Record<string, unknown> {
    const merged = deepMerge(base ?? this.defaultAdvancedSettings(), this.getServerOverrides(server));
    for (const k of ServerFilesService.MANAGED_KEYS) delete merged[k];
    return merged;
  }

  /** The effective server-settings.json body: advanced ⊕ managed row fields. */
  effectiveSettings(server: ServerRow, base?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...this.getAdvancedSettings(server, base),
      name: server.name,
      description: server.description,
      max_players: server.max_players,
    };
  }

  /** Write server-settings.json from the server row. Called before each start. */
  writeServerSettings(server: ServerRow, base?: Record<string, unknown>): void {
    this.ensureDirs(server.id);
    fs.writeFileSync(
      path.join(this.configDir(server.id), 'server-settings.json'),
      JSON.stringify(this.effectiveSettings(server, base), null, 2),
    );
  }

  // ---- Map generation settings (new-save generation) ----

  /**
   * Default map-gen-settings.json — mirrors the factoriotools image's
   * map-gen-settings.example.json (Factorio 2.x schema, where water/trees/enemy-base
   * live under autoplace_controls). Used when the server has none stored, and as the
   * base that stored values are merged onto so newly-added keys still appear.
   */
  defaultMapGenSettings(): Record<string, unknown> {
    return {
      width: 0,
      height: 0,
      starting_area: 1,
      peaceful_mode: false,
      autoplace_controls: {
        coal: { frequency: 1, size: 1, richness: 1 },
        stone: { frequency: 1, size: 1, richness: 1 },
        'copper-ore': { frequency: 1, size: 1, richness: 1 },
        'iron-ore': { frequency: 1, size: 1, richness: 1 },
        'uranium-ore': { frequency: 1, size: 1, richness: 1 },
        'crude-oil': { frequency: 1, size: 1, richness: 1 },
        water: { frequency: 1, size: 1 },
        trees: { frequency: 1, size: 1 },
        'enemy-base': { frequency: 1, size: 1 },
      },
      cliff_settings: {
        name: 'cliff',
        cliff_elevation_0: 10,
        cliff_elevation_interval: 40,
        richness: 1,
      },
      property_expression_names: {
        'control:moisture:frequency': '1',
        'control:moisture:bias': '0',
        'control:aux:frequency': '1',
        'control:aux:bias': '0',
      },
      starting_points: [{ x: 0, y: 0 }],
      seed: null,
    };
  }

  /** Stored map-gen-settings for a server, deep-merged onto the defaults. */
  getMapGenSettings(server: ServerRow): Record<string, unknown> {
    return deepMerge(this.defaultMapGenSettings(), parseJsonObject(server.map_gen_settings_json));
  }

  mapGenSettingsPath(serverId: string): string {
    return path.join(this.configDir(serverId), 'map-gen-settings.json');
  }

  mapSettingsPath(serverId: string): string {
    return path.join(this.configDir(serverId), 'map-settings.json');
  }

  /**
   * map-settings.json (pollution/evolution/expansion/etc.) is NOT managed by this
   * tool: Factorio validates it strictly against the exact binary version, requiring
   * keys that aren't even in an older image's example, so a hand-written file
   * crash-loops new-save generation. We leave it to the image, which drops a
   * version-matched example. This removes any incomplete leftover — one missing the
   * `path_finder` section that a complete file always has (e.g. one an earlier build
   * of this tool wrote) — so the image recreates a valid one on the next start.
   */
  healMapSettings(serverId: string): void {
    const p = this.mapSettingsPath(serverId);
    if (!fs.existsSync(p)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !('path_finder' in parsed)) {
        fs.rmSync(p);
        log.warn(`removed incomplete map-settings.json for ${serverId}; image will recreate it`);
      }
    } catch {
      fs.rmSync(p); // corrupt — let the image recopy its example
    }
  }

  /**
   * Write config/map-gen-settings.json — but ONLY when the server has customized map
   * generation. When it hasn't, we leave the file absent so the image uses its own
   * version-matched example (no schema-drift risk). The image passes the file to
   * `--create`, so it must be on disk before generation. Also heals any stale
   * incomplete map-settings.json. Called before each start and before createSave.
   */
  writeMapGenSettings(server: ServerRow): void {
    // map-settings.json: write the imported (version-correct) one if the server has
    // it; otherwise heal any stale incomplete file and let the image supply its own.
    if (server.map_settings_json) {
      this.ensureDirs(server.id);
      fs.writeFileSync(this.mapSettingsPath(server.id), server.map_settings_json);
    } else {
      this.healMapSettings(server.id);
    }
    if (!server.map_gen_settings_json) return; // uncustomized → use the image's example
    this.ensureDirs(server.id);
    fs.writeFileSync(
      this.mapGenSettingsPath(server.id),
      JSON.stringify(this.getMapGenSettings(server), null, 2),
    );
  }

  // ---- Map preview (scratch dir under the server data dir, mounted into one-shots) ----

  previewDir(serverId: string): string {
    return path.join(this.localDir(serverId), '.preview');
  }

  /** Write a map-gen-settings object to the preview scratch dir; returns the in-container path. */
  writePreviewSettings(serverId: string, settings: Record<string, unknown>): string {
    const dir = this.previewDir(serverId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'map-gen-settings.json'), JSON.stringify(settings, null, 2));
    return '/factorio/.preview/map-gen-settings.json'; // path as the container sees it
  }

  /** In-container path where a preview one-shot should write its PNG. */
  previewOutContainerPath(): string {
    return '/factorio/.preview/out.png';
  }

  /** Read the PNG produced by a preview one-shot. */
  readPreview(serverId: string): Buffer {
    const p = path.join(this.previewDir(serverId), 'out.png');
    if (!fs.existsSync(p)) throw new NotFoundError('Map preview');
    return fs.readFileSync(p);
  }

  // ---- Exchange string decode/encode (headless scenario one-shots) ----

  private importScratchDir(serverId: string): string {
    return path.join(this.localDir(serverId), '.import');
  }

  /** Isolated server-settings for a boot probe: public listing OFF, nothing announced. */
  writeProbeServerSettings(serverId: string): string {
    return this.writeScenarioServerSettings(serverId);
  }

  /** Minimal server-settings.json required by --start-server-load-scenario. */
  private writeScenarioServerSettings(serverId: string): string {
    const dir = this.importScratchDir(serverId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server-settings.json'),
      JSON.stringify({
        name: 'ftm',
        description: '',
        visibility: { public: false, lan: false },
        require_user_verification: false,
        game_password: '',
        allow_commands: 'admins-only',
      }),
    );
    return '/factorio/.import/server-settings.json';
  }

  /**
   * Write a throwaway scenario whose control.lua decodes `exchangeString` with
   * Factorio's own `helpers.parse_map_exchange_string`, logs the JSON between
   * markers, then aborts (fast exit). `exchangeString` must be pre-validated to the
   * `>>>base64<<<` charset so it's safe to embed in a Lua long-bracket string.
   */
  writeDecoderScenario(serverId: string, exchangeString: string): string {
    const dir = path.join(this.localDir(serverId), 'scenarios', 'ftm-decode');
    fs.mkdirSync(dir, { recursive: true });
    const lua =
      'script.on_init(function()\n' +
      '  local ok, data = pcall(function() return helpers.parse_map_exchange_string([==[' +
      exchangeString +
      ']==]) end)\n' +
      '  if ok then log("FTM_BEGIN"..helpers.table_to_json(data).."FTM_END") else log("FTM_ERR:"..tostring(data)) end\n' +
      '  error("FTM_STOP")\n' +
      'end)\n';
    fs.writeFileSync(path.join(dir, 'control.lua'), lua);
    return this.writeScenarioServerSettings(serverId);
  }

  /**
   * Write a throwaway scenario that emits the current map's exchange string via
   * `game.get_map_exchange_string()`. Run it with `--map-gen-settings` pointing at
   * the settings to encode (written by `writeEncodeSettings`).
   */
  writeEncoderScenario(serverId: string): string {
    const dir = path.join(this.localDir(serverId), 'scenarios', 'ftm-encode');
    fs.mkdirSync(dir, { recursive: true });
    const lua =
      'script.on_init(function()\n' +
      '  local ok, s = pcall(function() return game.get_map_exchange_string() end)\n' +
      '  if ok then log("FTM_BEGIN"..s.."FTM_END") else log("FTM_ERR:"..tostring(s)) end\n' +
      '  error("FTM_STOP")\n' +
      'end)\n';
    fs.writeFileSync(path.join(dir, 'control.lua'), lua);
    return this.writeScenarioServerSettings(serverId);
  }

  /**
   * Write a scenario that dumps the DEFAULT map-gen JSON for the server's loaded mods:
   * `parse(get_map_exchange_string())` on a fresh world → the full control set (incl.
   * mod resources) at defaults. Run with `--mod-directory /factorio/mods` so the
   * server's downloaded mods load.
   */
  writeBaselineScenario(serverId: string): string {
    const dir = path.join(this.localDir(serverId), 'scenarios', 'ftm-baseline');
    fs.mkdirSync(dir, { recursive: true });
    const lua =
      'script.on_init(function()\n' +
      '  local ok, s = pcall(function() return game.get_map_exchange_string() end)\n' +
      '  if ok then log("FTM_BEGIN"..helpers.table_to_json(helpers.parse_map_exchange_string(s)).."FTM_END")\n' +
      '  else log("FTM_ERR:"..tostring(s)) end\n' +
      '  error("FTM_STOP")\n' +
      'end)\n';
    fs.writeFileSync(path.join(dir, 'control.lua'), lua);
    return this.writeScenarioServerSettings(serverId);
  }

  /** Write the map-gen settings to encode; returns the in-container path. */
  writeEncodeSettings(serverId: string, mapGen: Record<string, unknown>): string {
    const dir = this.importScratchDir(serverId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'encode-mgs.json'), JSON.stringify(mapGen));
    return '/factorio/.import/encode-mgs.json';
  }

  // ---- RCON password ----

  rconPasswordPath(serverId: string): string {
    return path.join(this.configDir(serverId), 'rconpw');
  }

  /**
   * Write the RCON password to config/rconpw. The factoriotools image reads its
   * RCON password from this file (auto-generating one only if absent) and ignores
   * the RCON_PASSWORD env var, so we must write it ourselves for the manager's
   * stored password to match what the server actually uses.
   */
  writeRconPassword(serverId: string, password: string): void {
    this.ensureDirs(serverId);
    fs.writeFileSync(this.rconPasswordPath(serverId), password);
  }

  // ---- Whitelist ----

  whitelistPath(serverId: string): string {
    return path.join(this.configDir(serverId), 'server-whitelist.json');
  }

  /**
   * Write the effective player whitelist to config/server-whitelist.json. The
   * factoriotools image enforces the whitelist whenever this file is present, so
   * we must NOT write it when the list is empty (that would block everyone) —
   * instead we remove any stale file, leaving the server open.
   */
  writeWhitelist(serverId: string, names: string[]): void {
    const path_ = this.whitelistPath(serverId);
    if (names.length === 0) {
      if (fs.existsSync(path_)) fs.rmSync(path_);
      return;
    }
    this.ensureDirs(serverId);
    fs.writeFileSync(path_, JSON.stringify(names, null, 2));
  }

  // ---- Backups ----

  backupsDir(serverId: string): string {
    return path.join(this.localDir(serverId), 'backups');
  }

  backupPath(serverId: string, backupName: string): string {
    return path.join(this.backupsDir(serverId), `${sanitizeName(backupName)}.zip`);
  }

  /** Newest save by mtime, or undefined if there are none. */
  latestSaveName(serverId: string): string | undefined {
    return this.listSaves(serverId)[0]?.name; // listSaves is sorted newest-first
  }

  /**
   * Copy a save into backups/ as `<save>__<kind>-<timestamp>.zip`. Returns the backup
   * name. The `<save>__` prefix lets restore recover the original save name; the
   * `<kind>-` prefix on the rest tags it manual vs auto for separate retention.
   */
  backupSave(serverId: string, saveName: string, kind: BackupKind = 'manual'): string {
    const src = this.savePath(serverId, saveName);
    if (!fs.existsSync(src)) throw new NotFoundError(`Save "${saveName}"`);
    fs.mkdirSync(this.backupsDir(serverId), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${sanitizeName(saveName)}__${kind}-${ts}`;
    fs.copyFileSync(src, this.backupPath(serverId, name));
    return name;
  }

  listBackups(serverId: string): BackupInfo[] {
    const dir = this.backupsDir(serverId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const name = f.replace(/\.zip$/, '');
        const { source, kind } = parseBackupName(name);
        const stat = fs.statSync(path.join(dir, f));
        return { name, source, kind, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  readBackup(serverId: string, backupName: string): Buffer {
    const p = this.backupPath(serverId, backupName);
    if (!fs.existsSync(p)) throw new NotFoundError(`Backup "${backupName}"`);
    return fs.readFileSync(p);
  }

  deleteBackup(serverId: string, backupName: string): void {
    const p = this.backupPath(serverId, backupName);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  /** Copy a backup into saves/ under its original save name. Returns that name. */
  restoreBackup(serverId: string, backupName: string): string {
    const p = this.backupPath(serverId, backupName);
    if (!fs.existsSync(p)) throw new NotFoundError(`Backup "${backupName}"`);
    const source = sanitizeName(parseBackupName(backupName).source || backupName);
    this.ensureDirs(serverId);
    fs.copyFileSync(p, this.savePath(serverId, source));
    return source;
  }

  /** Keep only the newest `keep` backups of a given kind; delete the rest of that kind. */
  pruneBackups(serverId: string, kind: BackupKind, keep: number): number {
    if (keep <= 0) return 0;
    const backups = this.listBackups(serverId).filter((b) => b.kind === kind); // newest-first
    const stale = backups.slice(keep);
    for (const b of stale) this.deleteBackup(serverId, b.name);
    return stale.length;
  }

  // ---- Admin list ----

  adminlistPath(serverId: string): string {
    return path.join(this.configDir(serverId), 'server-adminlist.json');
  }

  /** Write the effective admin list to config/server-adminlist.json (empty removes it). */
  writeAdminlist(serverId: string, names: string[]): void {
    const p = this.adminlistPath(serverId);
    if (names.length === 0) {
      if (fs.existsSync(p)) fs.rmSync(p);
      return;
    }
    this.ensureDirs(serverId);
    fs.writeFileSync(p, JSON.stringify(names, null, 2));
  }

  // ---- Saves ----

  listSaves(serverId: string): { name: string; sizeBytes: number; modifiedAt: string }[] {
    const dir = this.savesDir(serverId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return {
          name: f.replace(/\.zip$/, ''),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  savePath(serverId: string, saveName: string): string {
    const safe = sanitizeName(saveName);
    return path.join(this.savesDir(serverId), `${safe}.zip`);
  }

  saveExists(serverId: string, saveName: string): boolean {
    return fs.existsSync(this.savePath(serverId, saveName));
  }

  /** Persist an uploaded save buffer under the given name. */
  writeSave(serverId: string, saveName: string, data: Buffer): void {
    this.ensureDirs(serverId);
    fs.writeFileSync(this.savePath(serverId, saveName), data);
  }

  readSave(serverId: string, saveName: string): Buffer {
    const p = this.savePath(serverId, saveName);
    if (!fs.existsSync(p)) throw new NotFoundError(`Save "${saveName}"`);
    return fs.readFileSync(p);
  }

  deleteSave(serverId: string, saveName: string): void {
    const p = this.savePath(serverId, saveName);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // ---- Mods ----

  modListPath(serverId: string): string {
    return path.join(this.modsDir(serverId), 'mod-list.json');
  }

  readModList(serverId: string): ModEntry[] {
    const p = this.modListPath(serverId);
    if (!fs.existsSync(p)) return [{ name: 'base', enabled: true }];
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { mods?: ModEntry[] };
      return parsed.mods ?? [{ name: 'base', enabled: true }];
    } catch {
      throw new ValidationError('mod-list.json is corrupt');
    }
  }

  writeModList(serverId: string, mods: ModEntry[]): void {
    this.ensureDirs(serverId);
    // Always keep base present so the game runs.
    if (!mods.some((m) => m.name === 'base')) {
      mods = [{ name: 'base', enabled: true }, ...mods];
    }
    fs.writeFileSync(
      this.modListPath(serverId),
      JSON.stringify({ mods: mods.map((m) => ({ name: m.name, enabled: m.enabled })) }, null, 2),
    );
  }
}

/** Parse a JSON string into a plain object, or {} on null/invalid input. */
function parseJsonObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `override` onto `base`. Plain objects are merged key-by-key;
 * arrays and scalars from `override` replace `base` wholesale. Neither input is
 * mutated. Lets stored settings override defaults while any keys the user never
 * touched (e.g. added in a later game version) fall back to the default.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

/**
 * Split a backup name into its source save + kind. Names are `<source>__<kind>-<ts>`
 * (new) or `<source>__<ts>` (legacy — treated as 'manual', so a pre-tag backup is
 * kept under manual retention rather than auto-pruned aggressively).
 */
function parseBackupName(name: string): { source: string; kind: BackupKind } {
  const i = name.indexOf('__');
  const source = i >= 0 ? name.slice(0, i) : name;
  const rest = i >= 0 ? name.slice(i + 2) : '';
  return { source, kind: rest.startsWith('auto-') ? 'auto' : 'manual' };
}

/** Prevent path traversal / illegal filename chars in user-supplied save names. */
export function sanitizeName(name: string): string {
  const trimmed = name.trim().replace(/\.zip$/i, '');
  if (!/^[A-Za-z0-9 _.-]+$/.test(trimmed) || trimmed.includes('..')) {
    throw new ValidationError(
      'Name may only contain letters, numbers, spaces, dot, dash and underscore',
    );
  }
  return trimmed;
}

export const serverFiles = new ServerFilesService();
