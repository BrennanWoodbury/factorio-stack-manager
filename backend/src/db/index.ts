import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';
import { runMigrations } from './migrations.js';

/**
 * Thin wrapper over Node's built-in synchronous SQLite (`node:sqlite`), exposing
 * a small better-sqlite3-style surface: `prepare().get/all/run`, `exec`, `pragma`
 * and a `transaction(fn)` helper that returns a callable running `fn` inside a
 * BEGIN/COMMIT (rolling back on throw). Synchronous + serialized, which is what
 * makes the port allocator's atomicity guarantee hold.
 *
 * We use node:sqlite instead of a native module (better-sqlite3) because it needs
 * no compilation and works out of the box on modern Node in the container.
 */
export class DB {
  private readonly raw: DatabaseSync;
  private txnDepth = 0;

  constructor(filename: string) {
    this.raw = new DatabaseSync(filename);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(statement: string): void {
    this.raw.exec(`PRAGMA ${statement};`);
  }

  prepare<Row = unknown>(sql: string): Stmt<Row> {
    return new Stmt<Row>(this.raw.prepare(sql));
  }

  close(): void {
    this.raw.close();
  }

  /**
   * Returns a function that runs `fn` inside a transaction. Nested calls use
   * SAVEPOINTs so composing transactional operations is safe. Mirrors the
   * better-sqlite3 API: `const run = db.transaction(fn); run(args)`.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const savepoint = `sp_${this.txnDepth}`;
      const begin = this.txnDepth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
      const commit = this.txnDepth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
      const rollback =
        this.txnDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`;
      this.raw.exec(begin);
      this.txnDepth++;
      try {
        const result = fn(...args);
        this.raw.exec(commit);
        return result;
      } catch (err) {
        this.raw.exec(rollback);
        throw err;
      } finally {
        this.txnDepth--;
      }
    };
  }
}

/** Prepared statement wrapper mirroring the subset of better-sqlite3 we use. */
export class Stmt<Row = unknown> {
  constructor(private readonly stmt: StatementSync) {
    // Allow callers to pass full row objects that contain keys not referenced by
    // the SQL (e.g. created_at) without node:sqlite throwing "Unknown named
    // parameter". Only the placeholders present in the SQL are bound.
    this.stmt.setAllowUnknownNamedParameters(true);
  }
  get(...params: BindParam[]): Row | undefined {
    return this.stmt.get(...(params as never[])) as Row | undefined;
  }
  all(...params: BindParam[]): Row[] {
    return this.stmt.all(...(params as never[])) as Row[];
  }
  run(...params: BindParam[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(params as never[]));
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;
/** Either a positional value or a single object of named parameters. */
export type BindParam = SqlValue | Record<string, SqlValue>;

/**
 * Open (creating if needed) the database, apply the schema and pragmas.
 * `foreign_keys` ON so ON DELETE CASCADE fires; WAL for read/write concurrency
 * between the API and background jobs.
 */
export function openDb(filename: string): DB {
  // A database that doesn't exist yet has nothing worth preserving, and a first
  // run would otherwise leave a snapshot of an empty file behind.
  const isNew = filename === ':memory:' || !fs.existsSync(filename);
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DB(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db, {
    onBeforeMigrate: isNew ? undefined : (from) => snapshotBeforeMigrate(db, filename, from),
  });
  return db;
}

/** How many pre-migration snapshots to keep before pruning the oldest. */
const KEEP_DB_SNAPSHOTS = 5;

/**
 * Snapshot the database immediately before its first migration in this run.
 *
 * `VACUUM INTO` rather than a file copy: the database is in WAL mode, so the
 * .db file on its own is not a complete or consistent picture. This is what
 * makes an upgrade reversible — restore the snapshot and the old image starts
 * cleanly instead of hitting SchemaTooNewError with nowhere to go.
 *
 * A failed snapshot aborts startup rather than migrating unprotected; set
 * SKIP_DB_BACKUP=true to override (and accept a one-way upgrade).
 */
function snapshotBeforeMigrate(db: DB, filename: string, fromVersion: number): void {
  if (filename === ':memory:') return;
  if (process.env.SKIP_DB_BACKUP === 'true') {
    console.warn('[db] SKIP_DB_BACKUP=true — migrating without a snapshot');
    return;
  }

  const dir = path.join(path.dirname(filename), 'db-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `manager-v${fromVersion}-${stamp}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // VACUUM INTO refuses to overwrite, and the timestamp makes collisions moot.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`[db] snapshot before migrating from v${fromVersion}: ${target}`);
  } catch (err) {
    throw new Error(
      `Could not snapshot the database before migrating (${(err as Error).message}). ` +
        'Refusing to migrate without a backup — free up disk space, or set SKIP_DB_BACKUP=true ' +
        'to proceed anyway (the upgrade will not be reversible).',
    );
  }

  // Keep the most recent few; these are small but they do accumulate.
  try {
    // By mtime, not name: "manager-v9-…" sorts after "manager-v14-…" lexically.
    const stale = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('manager-v') && f.endsWith('.db'))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at)
      .slice(0, -KEEP_DB_SNAPSHOTS);
    for (const { f } of stale) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* pruning is best-effort */
  }
}

export function kvGet(db: DB, key: string): string | undefined {
  const row = db.prepare<{ value: string }>('SELECT value FROM kv WHERE key = ?').get(key);
  return row?.value;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
