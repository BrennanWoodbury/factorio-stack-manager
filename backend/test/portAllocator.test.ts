import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { PortAllocator } from '../src/services/portAllocator.js';
import { PortPoolExhaustedError } from '../src/lib/errors.js';

/** In-memory DB with the real schema. */
function freshDb() {
  return openDb(':memory:');
}

let counter = 0;
function insertServer(db: ReturnType<typeof openDb>, gamePort = 0, rconPort = 0): string {
  const id = `srv-${++counter}`;
  db.prepare(
    `INSERT INTO servers (id, name, subdomain, game_port, rcon_port, rcon_password)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, `${id}-sub`, gamePort, rconPort, 'pw');
  return id;
}

test('allocates lowest free ports from each range', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);
  const s = insertServer(db);
  const { gamePort, rconPort } = alloc.allocatePair(s);
  assert.equal(gamePort, 34197);
  assert.equal(rconPort, 27015);
});

test('never double-allocates a port across many servers', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34206], [27015, 27024]);
  const game = new Set<number>();
  const rcon = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const s = insertServer(db);
    const { gamePort, rconPort } = alloc.allocatePair(s);
    assert.ok(!game.has(gamePort), `game port ${gamePort} handed out twice`);
    assert.ok(!rcon.has(rconPort), `rcon port ${rconPort} handed out twice`);
    game.add(gamePort);
    rcon.add(rconPort);
  }
  assert.equal(game.size, 10);
  assert.equal(rcon.size, 10);
});

test('reuses ports after release', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34197], [27015, 27015]); // range of 1 each
  const s1 = insertServer(db);
  const a = alloc.allocatePair(s1);
  assert.equal(a.gamePort, 34197);
  // pool now full
  const s2 = insertServer(db);
  assert.throws(() => alloc.allocatePair(s2), PortPoolExhaustedError);
  // release s1, pool free again
  alloc.releaseServerPorts(s1);
  const s3 = insertServer(db);
  const b = alloc.allocatePair(s3);
  assert.equal(b.gamePort, 34197);
});

test('rolls back game claim when rcon range is exhausted', () => {
  const db = freshDb();
  // game range has room, rcon range is size 1 and gets used up first
  const alloc = new PortAllocator(db, [34197, 34206], [27015, 27015]);
  const s1 = insertServer(db);
  alloc.allocatePair(s1); // consumes the single rcon port
  const s2 = insertServer(db);
  assert.throws(() => alloc.allocatePair(s2), PortPoolExhaustedError);
  // The game port that would have gone to s2 must NOT have been claimed:
  // capacity used for game must still be 1, not 2.
  assert.equal(alloc.capacity('game').used, 1);
  assert.equal(alloc.capacity('rcon').used, 1);
});

test('capacity reports total/used/free correctly', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]); // 3 each
  assert.deepEqual(alloc.capacity('game'), { total: 3, used: 0, external: 0, free: 3 });
  const s = insertServer(db);
  alloc.allocatePair(s);
  assert.deepEqual(alloc.capacity('game'), { total: 3, used: 1, external: 0, free: 2 });
  assert.deepEqual(alloc.capacity('rcon'), { total: 3, used: 1, external: 0, free: 2 });
});

test('capacity counts ports held outside the manager as unavailable', () => {
  // Three Factorio servers running outside the tool occupy three of our ports,
  // and reporting them free would promise capacity that does not exist.
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34200], [27015, 27018]); // 4 each

  assert.deepEqual(alloc.capacity('game', new Set([34197, 34198, 34199])), {
    total: 4,
    used: 0,
    external: 3,
    free: 1,
  });
});

test('a port is never counted twice when it is both ours and on the host', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34200], [27015, 27018]);
  const s = insertServer(db);
  const { gamePort } = alloc.allocatePair(s); // 34197, and its container publishes it

  assert.deepEqual(alloc.capacity('game', new Set([gamePort, 34198])), {
    total: 4,
    used: 1,
    external: 1,
    free: 2,
  });
});

test('host ports outside the range are ignored', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);

  // A web server on 8080 and an unrelated game on 34500 say nothing about our pool.
  assert.deepEqual(alloc.capacity('game', new Set([8080, 34500, 27015])), {
    total: 3,
    used: 0,
    external: 0,
    free: 3,
  });
  // ...though 27015 does land in the rcon range.
  assert.equal(alloc.capacity('rcon', new Set([8080, 34500, 27015])).external, 1);
});

test('a full range held entirely from outside reports nothing free', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);

  const c = alloc.capacity('game', new Set([34197, 34198, 34199]));
  assert.equal(c.free, 0);
  assert.equal(c.used, 0, 'none of it is ours');
});

/* ------------------------------------------------------------------ *
 * Ports held outside this manager
 * ------------------------------------------------------------------ */

test('a port something else already holds is skipped', () => {
  // The manager's table only knows what it handed out. A Factorio server run
  // outside the tool holds a real port, and binding it fails at container start.
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);
  const s = insertServer(db);

  const pair = alloc.allocatePair(s, new Set([34197, 34198, 27015]));

  assert.equal(pair.gamePort, 34199);
  assert.equal(pair.rconPort, 27016);
});

test('blocked ports are not permanently consumed', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);
  alloc.allocatePair(insertServer(db), new Set([34197]));

  // Whatever was holding 34197 has gone away; the next server may use it.
  const next = alloc.allocatePair(insertServer(db));
  assert.equal(next.gamePort, 34197);
});

test('a range fully blocked from outside reports exhaustion rather than handing out a bad port', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34198], [27015, 27016]);
  assert.throws(
    () => alloc.allocatePair(insertServer(db), new Set([34197, 34198])),
    PortPoolExhaustedError,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM port_allocations').get() as { n: number }).n,
    0,
    'the rcon claim rolls back with the failed game claim',
  );
});

test('reallocate moves a server off a port and frees the old one', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);
  const s = insertServer(db);
  const first = alloc.allocatePair(s);
  assert.equal(first.gamePort, 34197);

  const moved = alloc.reallocate(s, 'game', new Set([34197]));

  assert.equal(moved, 34198);
  const held = db
    .prepare("SELECT port FROM port_allocations WHERE kind = 'game' AND server_id = ?")
    .all(s) as { port: number }[];
  assert.deepEqual(held.map((r) => r.port), [34198], 'the old claim is gone, not duplicated');
  // The vacated port is available to the next server.
  assert.equal(alloc.allocatePair(insertServer(db)).gamePort, 34197);
});

test('reallocate leaves the original port claimed when there is nowhere to move', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34198], [27015, 27016]);
  const s = insertServer(db);
  alloc.allocatePair(s); // 34197
  alloc.allocatePair(insertServer(db)); // 34198 — range now full

  assert.throws(() => alloc.reallocate(s, 'game', new Set([34197])), PortPoolExhaustedError);
  const held = db
    .prepare("SELECT port FROM port_allocations WHERE kind = 'game' AND server_id = ?")
    .all(s) as { port: number }[];
  assert.deepEqual(
    held.map((r) => r.port),
    [34197],
    'a server with an unusable port still beats one holding none',
  );
});

test('reallocating one kind leaves the other alone', () => {
  const db = freshDb();
  const alloc = new PortAllocator(db, [34197, 34199], [27015, 27017]);
  const s = insertServer(db);
  const { rconPort } = alloc.allocatePair(s);

  alloc.reallocate(s, 'game', new Set([34197]));

  const rcon = db
    .prepare("SELECT port FROM port_allocations WHERE kind = 'rcon' AND server_id = ?")
    .all(s) as { port: number }[];
  assert.deepEqual(rcon.map((r) => r.port), [rconPort]);
});
