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
  /** Whether this server gets Cloudflare DNS records at all. */
  dnsEnabled: boolean;
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
  /** 'running' | 'stopped' | 'crashed' — 'crashed' means it keeps exiting and restarting. */
  status: string;
  running: boolean;
  startedAt?: string;
  /** Times Docker has restarted the container; non-zero means it has died. */
  restartCount?: number;
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

/** Something about a server's mod set that would stop the game loading it. */
export interface ModProblem {
  kind:
    | 'not-installed'
    | 'game-version'
    | 'missing-dependency'
    | 'disabled-dependency'
    | 'dependency-version'
    | 'conflict';
  mod: string;
  detail: string;
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

/** One dependency the user is being asked about before a mod is added. */
export interface ResolvedDependency {
  name: string;
  title: string;
  summary: string;
  downloadsCount: number;
  /** Version constraint as the mod author wrote it, e.g. ">= 0.14.0". Display only. */
  constraint?: string;
  /** The mod that pulled this in — the one being added, or a dependency of it. */
  via: string;
  /** Optional deps: `+`, which the game enables by default. */
  defaultEnabled?: boolean;
  /** Optional deps: `(?)`, hidden from the game's own mod GUI. */
  hidden?: boolean;
  /** Incompatible deps: whether the conflicting mod is already in the list. */
  installed?: boolean;
}

/** What adding one mod would pull in — the payload behind the approve/cancel dialog. */
export interface DependencyResolution {
  name: string;
  title: string;
  required: ResolvedDependency[];
  optional: ResolvedDependency[];
  incompatible: ResolvedDependency[];
  satisfied: string[];
  missing: string[];
  truncated: boolean;
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
  revision: number;
  baseDomain: string;
  hostRecordName: string;
  cloudflareZoneId: string;
  cloudflareZoneName: string;
  hasToken: boolean;
  ddnsIntervalSeconds: number;
  ipCheckUrl: string;
  /** The user's on/off switch — settings are kept either way. */
  enabled: boolean;
  /** Everything DNS needs is filled in. */
  configured: boolean;
  /** Switched on *and* configured: records are really being managed. */
  active: boolean;
}

export interface DnsReconcileRecordResult {
  type: 'A' | 'SRV';
  name: string;
  serverId?: string;
  ok: boolean;
  action?: 'created' | 'updated';
  error?: string;
}

export interface DnsReconcileResult {
  ok: boolean;
  lastRun: string;
  publicIp?: string;
  records: DnsReconcileRecordResult[];
}

/**
 * `used` is what this manager allocated; `external` is ports in the range held by
 * other containers on the host. Both are unavailable, so `free` excludes them.
 */
export interface PortCapacity {
  range: [number, number];
  total: number;
  used: number;
  external: number;
  free: number;
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
    game: PortCapacity;
    rcon: PortCapacity;
  };
}
