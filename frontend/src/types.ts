export interface Server {
  id: string;
  name: string;
  subdomain: string;
  description: string;
  maxPlayers: number;
  gamePort: number;
  rconPort: number;
  saveName: string;
  generateNewSave: boolean;
  gameMode: string;
  hasFactorioCredentials: boolean;
  containerId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  appliedModpackId: string | null;
  factorioTag: string;
  autoRestart: boolean;
  autoBackup: boolean;
  backupIntervalMinutes: number;
  backupKeep: number;
  backupKeepManual: number;
  overrides: {
    autoRestart: boolean;
    autoBackup: boolean;
    backupIntervalMinutes: boolean;
    backupKeep: boolean;
    backupKeepManual: boolean;
  };
  factorioImage?: string;
  connectHost?: string;
}

/** Raw map-gen-settings.json object (mirrors Factorio's schema). */
export type MapGenSettings = Record<string, unknown>;
export interface MapGen {
  mapGen: MapGenSettings;
  mapSettings?: MapGenSettings | null;
}

/** New-server wizard flow. */
export type DraftSource = 'generate' | 'import' | 'save';

/** In-progress wizard state, persisted on the draft (resumable across restarts). */
export interface DraftState {
  source: DraftSource;
  step?: string;
  name?: string;
  subdomain?: string;
  maxPlayers?: number;
  description?: string;
  factorioTag?: string;
  gameMode?: string;
  mapGen?: MapGenSettings;
  mapSettings?: MapGenSettings | null;
  mods?: ModEntry[];
  exchangeString?: string;
  saveStaged?: boolean;
  saveFileName?: string;
  saveGameVersion?: string;
  saveScenario?: string;
  saveMods?: { name: string; version: string }[];
}

/** Draft summary for the "Continue new server" list. */
export interface DraftDto {
  id: string;
  source: DraftSource;
  step: string | null;
  name: string;
  subdomain: string;
  gameMode: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface DraftResult {
  draft: DraftDto;
  state: DraftState;
}

/** Global server defaults (cascading, per-server overridable). */
export interface GlobalDefaults {
  autoRestart: boolean;
  autoBackup: boolean;
  backupIntervalMinutes: number;
  backupKeep: number;
  backupKeepManual: number;
  modpackId: string | null;
  mapTemplateId: string | null;
  modpackName: string | null;
  mapTemplateName: string | null;
}

/** Keys of the cascading scalar settings (match the backend). */
export type CascadeKey =
  | 'autoRestart'
  | 'autoBackup'
  | 'backupIntervalMinutes'
  | 'backupKeep'
  | 'backupKeepManual';

/** The single global Factorio.com account (token never returned). */
export interface FactorioAccount {
  username: string;
  hasToken: boolean;
  configured: boolean;
}

export interface MapGenTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export interface MapGenTemplateDetail extends MapGenTemplate {
  settings: MapGenSettings;
}

export interface BackupInfo {
  name: string;
  source: string;
  kind: 'manual' | 'auto';
  sizeBytes: number;
  createdAt: string;
}

export interface ServerStatus {
  id: string;
  status: string;
  running: boolean;
  startedAt?: string;
  players?: { count: number; names: string[] };
  playersError?: string;
}

/**
 * What a Factorio image supports, read from the image's own bundled mods.
 * `known: false` means it hasn't been pulled yet — the UI must not draw
 * conclusions from that; start/Test & Create do the authoritative check.
 */
export interface FactorioImageInfo {
  known: boolean;
  image: string;
  gameVersion?: string;
  bundledMods?: string[];
  /** Game mode → why it can't run on this image. Absent key = supported. */
  modeIssues?: Record<string, string>;
}

export interface SaveInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ModEntry {
  name: string;
  enabled: boolean;
  version?: string;
}

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

export interface Modpack {
  id: string;
  name: string;
  description: string;
  factorioVersion: string;
  modCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModpackMod {
  name: string;
  enabled: boolean;
  version: string | null;
}

export interface ModpackDetail {
  pack: Modpack;
  mods: ModpackMod[];
  usedBy: { id: string; name: string }[];
}

export interface ApplyResult {
  serverId: string;
  downloaded: { name: string; version: string }[];
  errors: { name: string; error: string }[];
}

export interface DnsSettings {
  baseDomain: string;
  hostRecordName: string;
  cloudflareZoneId: string;
  hasToken: boolean;
  ddnsIntervalSeconds: number;
  ipCheckUrl: string;
  enabled: boolean;
}

export interface SystemStatus {
  /** Build identity of the running manager ("dev" for a local build). */
  version?: string;
  docker: { ok: boolean; error?: string };
  dns: { enabled: boolean; baseDomain: string | null; hostRecord: string | null };
  ddns: {
    enabled: boolean;
    running: boolean;
    lastIp?: string;
    lastCheck?: string;
    lastError?: string;
    intervalSeconds: number;
  };
  ports: {
    game: { range: [number, number]; total: number; used: number; free: number };
    rcon: { range: [number, number]; total: number; used: number; free: number };
  };
}
