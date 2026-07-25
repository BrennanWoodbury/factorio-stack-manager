/** Row shapes as stored in SQLite (snake_case columns). */
export interface ServerRow {
  id: string;
  name: string;
  subdomain: string;
  description: string;
  max_players: number;
  game_port: number;
  rcon_port: number;
  rcon_password: string;
  save_name: string;
  generate_new_save: number; // 0 | 1
  factorio_username: string;
  factorio_token: string;
  container_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** Full editable server-settings.json body (advanced fields only). Nullable
   *  until first edited; defaulted in code. Added in migration v1. */
  settings_json: string | null;
  /** Modpack last applied to this server (for display / re-apply). Migration v2. */
  applied_modpack_id: string | null;
  /** Per-server player whitelist as a JSON string array. Migration v4. */
  whitelist_json: string | null;
  /** Per-server Factorio image tag; empty/null => global default. Migration v5. */
  factorio_tag: string | null;
  /** 1 = auto-restart on restart-requiring config change. Migration v6. */
  auto_restart: number;
  /** Per-server admin list as a JSON string array. Migration v7. */
  adminlist_json: string | null;
  /** User's intended run state: 'running' | 'stopped'. Migration v8. */
  desired_state: string;
  /** Scheduled backups. Migration v9. `backup_keep` = auto-backup retention. */
  auto_backup: number;
  backup_interval_minutes: number;
  backup_keep: number;
  /** Manual-backup retention (separate from auto). Migration v11. */
  backup_keep_manual: number;
  /** Per-setting override flags (0 = inherits global default). Migration v12. */
  auto_restart_overridden: number;
  auto_backup_overridden: number;
  backup_interval_minutes_overridden: number;
  backup_keep_overridden: number;
  backup_keep_manual_overridden: number;
  /** New-map generation settings (map-gen-settings.json). Nullable => image
   *  defaults. Applied when a new save is generated. Migration v10. */
  map_gen_settings_json: string | null;
  /** New-map enemy/pollution settings (map-settings.json). Migration v10. */
  map_settings_json: string | null;
  /** 'vanilla' | 'space_age' | 'modded'. Migration v13. */
  game_mode: string;
  /** 0 excludes this server from Cloudflare entirely. Migration v15. */
  dns_enabled: number;
  /** 'draft' (wizard in progress) | 'active' (real server). Migration v14. */
  lifecycle: string;
  /** ISO time a draft is pruned at; null for active servers. Migration v14. */
  expires_at: string | null;
  /** Wizard resume state (see DraftState) as JSON; null for active. Migration v14. */
  draft_state_json: string | null;
}

/**
 * A new-server wizard's in-progress state, persisted on the draft row so the flow
 * survives restarts and is resumable ("Continue new server"). The intended subdomain
 * lives here rather than on the row's `subdomain` column (which holds a placeholder to
 * satisfy the NOT NULL/UNIQUE constraint) — real uniqueness is validated at finalize.
 */
export interface DraftState {
  /** Which wizard flow this draft is in. */
  source: 'generate' | 'import' | 'save';
  /** Furthest wizard stage reached, so resume lands on the right step. */
  step?: string;
  /** Intended fields (mirrored onto the row where columns exist). */
  name?: string;
  subdomain?: string;
  maxPlayers?: number;
  description?: string;
  factorioTag?: string;
  gameMode?: string;
  mapGen?: Record<string, unknown>;
  mapSettings?: Record<string, unknown>;
  mods?: { name: string; enabled: boolean }[];
  /** Import flow: the pasted exchange string and the settings it decoded to. */
  exchangeString?: string;
  /** Save flow: a save file has been uploaded into the draft's dir. */
  saveStaged?: boolean;
  saveFileName?: string;
  /** Save flow: what the uploaded save's own header says it needs (read at upload). */
  saveGameVersion?: string;
  saveScenario?: string;
  saveMods?: { name: string; version: string }[];
}

/** API-facing draft shape for the "Continue new server" list. */
export interface DraftDto {
  id: string;
  source: string;
  step: string | null;
  name: string;
  subdomain: string;
  gameMode: string;
  createdAt: string;
  updatedAt: string;
  /** ISO time this draft is pruned at (for an "expires in Nh" display). */
  expiresAt: string | null;
}

export function toDraftDto(row: ServerRow): DraftDto {
  let state: DraftState | null = null;
  try {
    state = row.draft_state_json ? (JSON.parse(row.draft_state_json) as DraftState) : null;
  } catch {
    state = null;
  }
  return {
    id: row.id,
    source: state?.source ?? 'generate',
    step: state?.step ?? null,
    name: (state?.name ?? row.name ?? '').trim(),
    subdomain: (state?.subdomain ?? '').trim(),
    gameMode: state?.gameMode ?? row.game_mode ?? 'space_age',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** API-facing server shape (camelCase, secrets stripped where appropriate). */
export interface ServerDto {
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
  /** Per-server image tag ('' = global default). */
  factorioTag: string;
  autoRestart: boolean;
  /** Whether this server gets Cloudflare records at all. */
  dnsEnabled: boolean;
  autoBackup: boolean;
  backupIntervalMinutes: number;
  backupKeep: number;
  backupKeepManual: number;
  /** Which cascading settings are overridden on this server (vs inheriting global). */
  overrides: {
    autoRestart: boolean;
    autoBackup: boolean;
    backupIntervalMinutes: boolean;
    backupKeep: boolean;
    backupKeepManual: boolean;
  };
  /** Resolved Docker image the server will run (repo:tag). */
  factorioImage?: string;
  /** Fully-qualified connect hostname players use, when DNS is enabled. */
  connectHost?: string;
}

export function toDto(
  row: ServerRow,
  connectHost?: string,
  factorioImage?: string,
  opts?: { hasFactorioCredentials?: boolean },
): ServerDto {
  return {
    id: row.id,
    name: row.name,
    subdomain: row.subdomain,
    description: row.description,
    maxPlayers: row.max_players,
    gamePort: row.game_port,
    rconPort: row.rcon_port,
    saveName: row.save_name,
    generateNewSave: row.generate_new_save === 1,
    gameMode: row.game_mode ?? 'space_age',
    hasFactorioCredentials: opts?.hasFactorioCredentials ?? false,
    containerId: row.container_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedModpackId: row.applied_modpack_id ?? null,
    factorioTag: row.factorio_tag ?? '',
    autoRestart: row.auto_restart === 1,
    dnsEnabled: row.dns_enabled !== 0,
    autoBackup: row.auto_backup === 1,
    backupIntervalMinutes: row.backup_interval_minutes,
    backupKeep: row.backup_keep,
    backupKeepManual: row.backup_keep_manual,
    overrides: {
      autoRestart: row.auto_restart_overridden === 1,
      autoBackup: row.auto_backup_overridden === 1,
      backupIntervalMinutes: row.backup_interval_minutes_overridden === 1,
      backupKeep: row.backup_keep_overridden === 1,
      backupKeepManual: row.backup_keep_manual_overridden === 1,
    },
    factorioImage,
    connectHost,
  };
}

export interface DnsRecordRow {
  id: number;
  server_id: string | null;
  type: string;
  name: string;
  cloudflare_record_id: string | null;
  content: string;
  created_at: string;
}
