import type { DB } from './index.js';

/**
 * Incremental schema migrations, gated by SQLite's `PRAGMA user_version`.
 *
 * `schema.ts` creates any missing table (idempotent CREATE IF NOT EXISTS) and is
 * applied first. Migrations here handle changes that CREATE-IF-NOT-EXISTS can't
 * express — chiefly `ALTER TABLE ... ADD COLUMN` — and run in order, each bumping
 * user_version so they apply exactly once per database.
 */
interface Migration {
  version: number;
  /**
   * Can a build that predates this migration still operate on the database
   * afterwards?
   *
   * True for purely additive changes — an older build simply ignores a column it
   * doesn't know about. False for anything that removes, renames or rewrites what
   * an older build reads, which makes the upgrade a one-way door until the
   * snapshot is restored.
   *
   * This is what keeps "schema changed" from meaning "breaking change": nearly
   * every migration here is an ADD COLUMN, and none of those should cost a user
   * the ability to roll back.
   */
  backwardCompatible: boolean;
  up: (db: DB) => void;
}

/** kv key holding the oldest schema version still able to open this database. */
const FLOOR_KEY = 'schema_min_compatible';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    backwardCompatible: true,
    // Full editable server-settings.json body (advanced fields only; name /
    // description / max_players stay on the row and are overlaid at write time).
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN settings_json TEXT'),
  },
  {
    version: 2,
    backwardCompatible: true,
    // Which modpack a server was last given (for display + "re-apply"). Not a FK
    // (SQLite can't ADD COLUMN with a FK); referential cleanup is done in code.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN applied_modpack_id TEXT'),
  },
  {
    version: 3,
    backwardCompatible: false,
    // Rename the factorio.com account credential columns: the same username/token
    // is used both for mod-portal downloads AND public-server listing, so the
    // mod-centric name was misleading. Guarded so it's a no-op on fresh DBs (where
    // schema.ts already creates the new names).
    up: (db) => {
      const cols = db.prepare<{ name: string }>('PRAGMA table_info(servers)').all();
      const has = (n: string) => cols.some((c) => c.name === n);
      if (has('mod_portal_username') && !has('factorio_username')) {
        db.exec('ALTER TABLE servers RENAME COLUMN mod_portal_username TO factorio_username');
      }
      if (has('mod_portal_token') && !has('factorio_token')) {
        db.exec('ALTER TABLE servers RENAME COLUMN mod_portal_token TO factorio_token');
      }
    },
  },
  {
    version: 4,
    backwardCompatible: true,
    // Per-server player whitelist (JSON array of Factorio usernames). The global
    // whitelist lives in the kv table; the effective whitelist written to
    // server-whitelist.json on start is the union of the two.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN whitelist_json TEXT'),
  },
  {
    version: 5,
    backwardCompatible: true,
    // Per-server Factorio image tag (e.g. 'stable', 'latest', '2.0.55'). Empty =>
    // use the global FACTORIO_IMAGE. Applied to the base repo of FACTORIO_IMAGE.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN factorio_tag TEXT'),
  },
  {
    version: 6,
    backwardCompatible: true,
    // When 1, a restart-requiring config change made while the server is running
    // triggers an automatic restart to apply it.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 0'),
  },
  {
    version: 7,
    backwardCompatible: true,
    // Per-server admin list (JSON array of Factorio usernames). Global admin list
    // lives in kv; the effective admin list written to server-adminlist.json on
    // start is the union of the two (mirrors the whitelist).
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN adminlist_json TEXT'),
  },
  {
    version: 8,
    backwardCompatible: true,
    // The user's intended run state ('running' | 'stopped'), set by start/stop and
    // NOT overwritten by observed-status updates. On manager startup, servers whose
    // desired_state is 'running' but whose container isn't are resumed.
    up: (db) => db.exec("ALTER TABLE servers ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'stopped'"),
  },
  {
    version: 9,
    backwardCompatible: true,
    // Scheduled backup config per server.
    up: (db) => {
      db.exec('ALTER TABLE servers ADD COLUMN auto_backup INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE servers ADD COLUMN backup_interval_minutes INTEGER NOT NULL DEFAULT 60');
      db.exec('ALTER TABLE servers ADD COLUMN backup_keep INTEGER NOT NULL DEFAULT 10');
    },
  },
  {
    version: 10,
    backwardCompatible: true,
    // New-map generation settings (the in-game "map generation" screen): resource
    // frequency/size/richness, water, cliffs, starting area, peaceful mode, seed
    // (map-gen-settings.json) and enemy/pollution controls (map-settings.json).
    // Nullable => use the image's example defaults; written to config/ before a new
    // save is generated.
    up: (db) => {
      db.exec('ALTER TABLE servers ADD COLUMN map_gen_settings_json TEXT');
      db.exec('ALTER TABLE servers ADD COLUMN map_settings_json TEXT');
    },
  },
  {
    version: 11,
    backwardCompatible: true,
    // Separate retention for manual vs automatic backups: `backup_keep` now applies
    // to auto backups only, and this new column caps manual backups independently.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN backup_keep_manual INTEGER NOT NULL DEFAULT 10'),
  },
  {
    version: 12,
    backwardCompatible: true,
    // Global-default + per-server override: an `<col>_overridden` flag per cascading
    // setting (auto_restart + backup config). 0 = inherits the global (and is pushed
    // to on a global change); 1 = the server's own value, frozen until reset.
    up: (db) => {
      for (const col of [
        'auto_restart',
        'auto_backup',
        'backup_interval_minutes',
        'backup_keep',
        'backup_keep_manual',
      ]) {
        db.exec(`ALTER TABLE servers ADD COLUMN ${col}_overridden INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 13,
    backwardCompatible: true,
    // Game mode: 'vanilla' | 'space_age' | 'modded'. Drives the map-gen slider set
    // (which planets show) and the bundled Space Age mods' enablement on start.
    up: (db) => db.exec("ALTER TABLE servers ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'space_age'"),
  },
  {
    version: 14,
    backwardCompatible: true,
    // Draft lifecycle. A row is created up front while the new-server wizard is in
    // progress (lifecycle='draft') and only becomes a real server on finalize
    // (lifecycle='active'). Drafts hold no ports and no DNS, are excluded from every
    // operational listing, survive restarts (so the wizard is resumable), and are
    // pruned once `expires_at` passes. `draft_state_json` stores the wizard's
    // in-progress state (intended subdomain, mode, mapgen, mods, …) for resume.
    // Existing rows are real servers => 'active'.
    up: (db) => {
      db.exec("ALTER TABLE servers ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'");
      db.exec('ALTER TABLE servers ADD COLUMN expires_at TEXT');
      db.exec('ALTER TABLE servers ADD COLUMN draft_state_json TEXT');
    },
  },
  {
    version: 15,
    backwardCompatible: true,
    // Per-server DNS opt-out. A server can be excluded from Cloudflare entirely
    // (players connect by IP:port) while DNS stays on globally — useful for a
    // private or throwaway server that shouldn't appear in public DNS. Existing
    // servers all had records, so they default to 1.
    up: (db) => db.exec('ALTER TABLE servers ADD COLUMN dns_enabled INTEGER NOT NULL DEFAULT 1'),
  },
];

/** Highest migration this build knows how to apply. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** The schema version recorded in the database (0 for a fresh one). */
export function schemaVersion(db: DB): number {
  return db.prepare<{ user_version: number }>('PRAGMA user_version').get()?.user_version ?? 0;
}

/**
 * Thrown when the database has had a change applied that this build cannot work
 * with — not merely a newer one.
 *
 * Migrations only run forward, so an older binary skips everything newer and then
 * uses whatever schema it finds. For an additive migration that is completely
 * fine: it just never touches the new column. For one that renames or removes
 * something it reads (v3 renames columns) the reads fail, scattered and
 * unexplained. Refusing to open is the kinder failure — but only in the second
 * case, which is why the floor exists rather than a blanket "is it newer".
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
    readonly floor: number,
  ) {
    super(
      `This database is at schema v${found} and requires a build that understands at least ` +
        `v${floor}; this one only understands up to v${supported}. A release newer than this ` +
        `one made a change that cannot be read backwards. Roll forward to that release (or ` +
        `newer) to start. If you meant to go back, restore the snapshot taken before the ` +
        `upgrade from the db-backups directory.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * Oldest schema version still able to open this database, or null if unrecorded.
 *
 * Kept in `kv` so it's visible to anyone inspecting the file. Read defensively:
 * on a database whose schema predates the kv table there is nothing to find.
 */
function readCompatibilityFloor(db: DB): number | null {
  try {
    const row = db.prepare<{ value: string }>('SELECT value FROM kv WHERE key = ?').get(FLOOR_KEY);
    if (row === undefined) return null;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // no kv table yet
  }
}

function writeCompatibilityFloor(db: DB, floor: number): void {
  try {
    db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(FLOOR_KEY, String(floor));
  } catch {
    /* no kv table (bare test database) — the floor is recomputable anyway */
  }
}

/**
 * The floor for a database that has never recorded one: the newest incompatible
 * migration already applied, which this build can work out from its own list.
 */
function backfillFloor(db: DB, current: number): number {
  const floor = MIGRATIONS.filter((m) => !m.backwardCompatible && m.version <= current).reduce(
    (max, m) => Math.max(max, m.version),
    0,
  );
  writeCompatibilityFloor(db, floor);
  return floor;
}

/**
 * Apply every migration newer than the database's recorded version.
 *
 * `onBeforeMigrate` fires once, only when there is actually work to do, so a
 * snapshot can be taken while the schema is still readable by the build that
 * wrote it — the thing that makes a downgrade recoverable rather than terminal.
 */
export function runMigrations(
  db: DB,
  opts: { onBeforeMigrate?: (fromVersion: number) => void } = {},
): void {
  const current = schemaVersion(db);

  if (current > LATEST_SCHEMA_VERSION) {
    // Newer database. Whether that matters depends on *what* changed, so consult
    // the floor the newer build left behind rather than assuming the worst.
    const floor = readCompatibilityFloor(db);
    if (floor === null) {
      // Written by a build from before the floor existed: nothing recorded, and
      // we can't inspect migrations we don't have. Refuse rather than guess.
      throw new SchemaTooNewError(current, LATEST_SCHEMA_VERSION, current);
    }
    if (floor > LATEST_SCHEMA_VERSION) {
      throw new SchemaTooNewError(current, LATEST_SCHEMA_VERSION, floor);
    }
    console.warn(
      `[db] database is at schema v${current}, newer than this build's v${LATEST_SCHEMA_VERSION}, ` +
        'but every change since is backward compatible — continuing.',
    );
    return;
  }

  if (readCompatibilityFloor(db) === null) backfillFloor(db, current);

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  opts.onBeforeMigrate?.(current);

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      // user_version can't be parameterised; version is an integer literal we control.
      db.exec(`PRAGMA user_version = ${m.version}`);
      if (!m.backwardCompatible) writeCompatibilityFloor(db, m.version);
    })();
    console.log(
      `[db] applied migration v${m.version}${m.backwardCompatible ? '' : ' (one-way)'}`,
    );
  }
}
