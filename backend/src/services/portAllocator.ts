import type { DB } from '../db/index.js';
import { PortPoolExhaustedError } from '../lib/errors.js';

export type PortKind = 'game' | 'rcon';
export type PortRange = readonly [number, number];

/**
 * Atomic port allocator.
 *
 * Correctness contract (this is the networking-critical invariant of the whole
 * app): a port is considered "in use" iff a row exists for it in
 * `port_allocations`. Because that table's PRIMARY KEY is (kind, port), the DB
 * itself guarantees a given port is claimed at most once. Every claim/release
 * happens inside a single better-sqlite3 transaction (which is synchronous and
 * serialized), so two concurrent server-creates can never be handed the same
 * port — the second matching INSERT would violate the primary key and roll back.
 *
 * Game ports come only from the pre-forwarded UDP range; that host port is what
 * gets advertised in the Factorio SRV record and must equal the externally
 * reachable port (the router forward is manual and 1:1). RCON ports come from a
 * separate range and are never forwarded/advertised.
 *
 * The table is authoritative for what *this manager* handed out, which is not the
 * same as what is free on the host: a Factorio server run outside the tool, or any
 * other process, can hold a port in the range. Callers pass those in as `blocked`
 * so they are skipped — see DockerService.hostPortsInUse() for the ports other
 * containers hold, and ServerManager.start() for recovering from a bind failure
 * the host only reveals at container start.
 */
export class PortAllocator {
  constructor(
    private readonly db: DB,
    private readonly gameRange: PortRange,
    private readonly rconRange: PortRange,
  ) {}

  /** All ports currently claimed for a kind, as a Set for O(1) lookup. */
  private takenSet(kind: PortKind): Set<number> {
    const rows = this.db
      .prepare('SELECT port FROM port_allocations WHERE kind = ?')
      .all(kind) as { port: number }[];
    return new Set(rows.map((r) => r.port));
  }

  private rangeFor(kind: PortKind): PortRange {
    return kind === 'game' ? this.gameRange : this.rconRange;
  }

  /**
   * Lowest port of `kind` that is neither claimed nor `blocked`, or throw if the
   * pool is exhausted. Does NOT claim.
   */
  private nextFree(kind: PortKind, blocked?: ReadonlySet<number>): number {
    const [start, end] = this.rangeFor(kind);
    const taken = this.takenSet(kind);
    for (let p = start; p <= end; p++) {
      if (!taken.has(p) && !blocked?.has(p)) return p;
    }
    throw new PortPoolExhaustedError(kind);
  }

  private claim(kind: PortKind, port: number, serverId: string): void {
    this.db
      .prepare('INSERT INTO port_allocations (kind, port, server_id) VALUES (?, ?, ?)')
      .run(kind, port, serverId);
  }

  /**
   * Atomically allocate one game port and one RCON port for a server. Either both
   * succeed or neither is claimed (the transaction rolls back on any failure,
   * including pool exhaustion of the second range after the first was claimed).
   */
  allocatePair(
    serverId: string,
    blocked?: ReadonlySet<number>,
  ): { gamePort: number; rconPort: number } {
    const txn = this.db.transaction((sid: string) => {
      const gamePort = this.nextFree('game', blocked);
      this.claim('game', gamePort, sid);
      const rconPort = this.nextFree('rcon', blocked);
      this.claim('rcon', rconPort, sid);
      return { gamePort, rconPort };
    });
    return txn(serverId);
  }

  /**
   * Swap one of a server's ports for the next free one, skipping `blocked`.
   * Returns the new port.
   *
   * Used when the host refuses a binding we believed was free — releasing and
   * re-claiming in one transaction so the old port goes back into the pool only
   * if a replacement is actually available.
   */
  reallocate(serverId: string, kind: PortKind, blocked?: ReadonlySet<number>): number {
    const txn = this.db.transaction((sid: string) => {
      // Drop the claim first so the pool sees it as free — the new port can never
      // be the old one, because the caller always blocks what just failed. If no
      // replacement exists, the throw rolls the whole transaction back and the
      // server keeps the port it had rather than ending up holding none.
      this.db
        .prepare('DELETE FROM port_allocations WHERE kind = ? AND server_id = ?')
        .run(kind, sid);
      const port = this.nextFree(kind, blocked);
      this.claim(kind, port, sid);
      return port;
    });
    return txn(serverId);
  }

  /** Release every port held by a server (called on delete). Idempotent. */
  releaseServerPorts(serverId: string): void {
    this.db.prepare('DELETE FROM port_allocations WHERE server_id = ?').run(serverId);
  }

  /** Introspection for status / capacity display. */
  capacity(kind: PortKind): { total: number; used: number; free: number } {
    const [start, end] = this.rangeFor(kind);
    const total = end - start + 1;
    const used = this.takenSet(kind).size;
    return { total, used, free: total - used };
  }
}
