import test from 'node:test';
import assert from 'node:assert/strict';
import { kvGet, kvSet, openDb } from '../src/db/index.js';
import { DnsService } from '../src/services/dnsService.js';
import { getDnsSettings, setDnsSettings } from '../src/services/dnsSettings.js';

const originalFetch = globalThis.fetch;

function cloudflareResult(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cloudflareFailure(message: string): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code: 1000, message }], result: null }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

function insertServer(
  db: ReturnType<typeof openDb>,
  id: string,
  subdomain: string,
  gamePort: number,
): void {
  db.prepare(
    `INSERT INTO servers (id, name, subdomain, game_port, rcon_port, rcon_password, lifecycle)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
  ).run(id, id, subdomain, gamePort, gamePort + 1000, 'secret');
}

function configureDns(db: ReturnType<typeof openDb>): void {
  setDnsSettings(db, {
    baseDomain: 'games.example.com',
    cloudflareZoneId: 'zone-123',
    cloudflareToken: 'token-123',
    ipCheckUrl: 'https://ip.example.test',
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('tests an unsaved subdomain configuration without persisting it', async () => {
  const db = openDb(':memory:');
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/zones/zone-123')) {
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await new DnsService(db).testConnection({
    baseDomain: 'games.example.com',
    cloudflareZoneId: 'zone-123',
    cloudflareToken: 'candidate-token',
    ipCheckUrl: 'https://ip.example.test',
  });

  assert.deepEqual(result, {
    ok: true,
    zoneName: 'example.com',
    publicIp: '203.0.113.42',
  });
  assert.equal(calls.length, 3);
  assert.equal(getDnsSettings(db).cloudflareToken, '');
  db.close();
});

test('derives the shared host record from the server domain and ignores the legacy value', () => {
  const db = openDb(':memory:');
  kvSet(db, 'dns_base_domain', 'factorio.example.com');
  kvSet(db, 'dns_host_record', 'legacy.example.com');

  assert.equal(
    getDnsSettings(db).hostRecordName,
    'factorio-tools-manager.factorio.example.com',
  );
  db.close();
});

test('reports a generated-host CNAME collision during the read-only test', async () => {
  const db = openDb(':memory:');
  let checkedPublicIp = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/zones/zone-123')) {
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url.includes('/dns_records?')) {
      return cloudflareResult([
        {
          id: 'existing-cname',
          type: 'CNAME',
          name: 'factorio-tools-manager.games.example.com',
          content: 'elsewhere.example.net',
        },
      ]);
    }
    checkedPublicIp = true;
    return new Response('203.0.113.42');
  };

  const result = await new DnsService(db).testConnection({
    baseDomain: 'games.example.com',
    cloudflareZoneId: 'zone-123',
    cloudflareToken: 'candidate-token',
    ipCheckUrl: 'https://ip.example.test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.zoneName, 'example.com');
  assert.match(result.error ?? '', /conflicts with an existing CNAME/);
  assert.equal(checkedPublicIp, false);
  db.close();
});

test('rejects server names outside the selected Cloudflare zone', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
  };

  const result = await new DnsService(db).testConnection({
    baseDomain: 'games.invalid.test',
    cloudflareZoneId: 'zone-123',
    cloudflareToken: 'candidate-token',
    ipCheckUrl: 'https://ip.example.test',
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /must belong to Cloudflare zone example\.com/);
  assert.equal(calls, 1);
  db.close();
});

test('uses the stored masked token when testing other edits', async () => {
  const db = openDb(':memory:');
  setDnsSettings(db, { cloudflareToken: 'stored-token' });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer stored-token');
    }
    if (url.endsWith('/zones/zone-123')) {
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    return new Response('198.51.100.7');
  };

  const result = await new DnsService(db).testConnection({
    baseDomain: 'example.com',
    cloudflareZoneId: 'zone-123',
    ipCheckUrl: 'https://ip.example.test',
  });

  assert.equal(result.ok, true);
  db.close();
});

test('reconciliation backfills every active server and the shared A record', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  insertServer(db, 'beta', 'beta', 34198);
  let nextId = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    if (url.endsWith('/dns_records') && method === 'POST') {
      return cloudflareResult({ id: `created-${++nextId}` });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await new DnsService(db).reconcile();

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map((record) => [record.type, record.name, record.action]),
    [
      ['A', 'factorio-tools-manager.games.example.com', 'created'],
      ['SRV', '_factorio._udp.alpha.games.example.com', 'created'],
      ['SRV', '_factorio._udp.beta.games.example.com', 'created'],
    ],
  );
  assert.equal(
    db.prepare<{ count: number }>("SELECT count(*) AS count FROM dns_records WHERE type = 'SRV'").get()
      ?.count,
    2,
  );
  assert.equal(kvGet(db, 'host_a_record_id'), 'created-1');
  db.close();
});

test('reconciliation rediscovers records by name and removes stale tracked IDs', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  kvSet(db, 'host_a_record_id', 'stale-a');
  db.prepare(
    `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
     VALUES ('alpha', 'SRV', 'old-name', 'stale-srv', 'old-target')`,
  ).run();
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('type=A')) {
      return cloudflareResult([
        { id: 'discovered-a', name: 'factorio-tools-manager.games.example.com' },
      ]);
    }
    if (url.includes('type=SRV')) {
      return cloudflareResult([
        { id: 'discovered-srv', name: '_factorio._udp.alpha.games.example.com' },
      ]);
    }
    if (method === 'PUT') return cloudflareResult({ id: url.split('/').at(-1) });
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await new DnsService(db).reconcile();

  assert.equal(result.ok, true);
  assert.equal(kvGet(db, 'host_a_record_id'), 'discovered-a');
  assert.equal(
    db.prepare<{ id: string }>(
      "SELECT cloudflare_record_id AS id FROM dns_records WHERE server_id = 'alpha'",
    ).get()?.id,
    'discovered-srv',
  );
  assert.deepEqual(deleted.sort(), ['stale-a', 'stale-srv']);
  db.close();
});

test('a partial reconciliation keeps old topology bookkeeping and records', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  insertServer(db, 'beta', 'beta', 34198);
  kvSet(db, 'host_a_record_id', 'old-a');
  for (const serverId of ['alpha', 'beta']) {
    db.prepare(
      `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
       VALUES (?, 'SRV', ?, ?, 'old-target')`,
    ).run(serverId, `old-${serverId}`, `old-${serverId}-srv`);
  }
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('type=A')) {
      return cloudflareResult([
        { id: 'new-a', name: 'factorio-tools-manager.games.example.com' },
      ]);
    }
    if (url.includes('_factorio._udp.alpha')) {
      return cloudflareResult([
        { id: 'new-alpha-srv', name: '_factorio._udp.alpha.games.example.com' },
      ]);
    }
    if (url.includes('_factorio._udp.beta')) return cloudflareFailure('temporary failure');
    if (method === 'PUT') return cloudflareResult({ id: url.split('/').at(-1) });
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await new DnsService(db).reconcile();

  assert.equal(result.ok, false);
  assert.equal(kvGet(db, 'host_a_record_id'), 'old-a');
  assert.deepEqual(
    db
      .prepare<{ id: string }>(
        "SELECT cloudflare_record_id AS id FROM dns_records ORDER BY server_id",
      )
      .all()
      .map((row) => row.id),
    ['old-alpha-srv', 'old-beta-srv'],
  );
  assert.deepEqual(deleted, []);
  db.close();
});

test('failed activation preserves stored settings and removes newly-created records', async () => {
  const db = openDb(':memory:');
  insertServer(db, 'alpha', 'alpha', 34197);
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/zones/zone-123')) {
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    if (url.endsWith('/dns_records') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { type: string };
      return body.type === 'A' ? cloudflareResult({ id: 'new-a' }) : cloudflareFailure('write denied');
    }
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  await assert.rejects(
    () =>
      new DnsService(db).activateSettings({
        baseDomain: 'games.example.com',
        cloudflareZoneId: 'zone-123',
        cloudflareToken: 'token-123',
        ipCheckUrl: 'https://ip.example.test',
      }),
    /DNS activation failed/,
  );

  assert.equal(getDnsSettings(db).cloudflareZoneId, '');
  assert.deepEqual(deleted, ['new-a']);
  db.close();
});

test('successful topology change swaps bookkeeping and removes old-zone records', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  kvSet(db, 'host_a_record_id', 'old-a');
  db.prepare(
    `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
     VALUES ('alpha', 'SRV', 'old-name', 'old-srv', 'old-target')`,
  ).run();
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/zones/new-zone')) {
      return cloudflareResult({ id: 'new-zone', name: 'new.example', status: 'active' });
    }
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    if (url.endsWith('/dns_records') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { type: string };
      return cloudflareResult({ id: body.type === 'A' ? 'new-a' : 'new-srv' });
    }
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const activated = await new DnsService(db).activateSettings({
    baseDomain: 'games.new.example',
    cloudflareZoneId: 'new-zone',
    cloudflareToken: 'new-token',
  });

  assert.equal(activated.reconciliation?.ok, true);
  assert.equal(getDnsSettings(db).cloudflareZoneId, 'new-zone');
  assert.equal(getDnsSettings(db).cloudflareZoneName, 'new.example');
  assert.equal(kvGet(db, 'host_a_record_id'), 'new-a');
  assert.equal(
    db.prepare<{ id: string }>(
      "SELECT cloudflare_record_id AS id FROM dns_records WHERE server_id = 'alpha'",
    ).get()?.id,
    'new-srv',
  );
  assert.deepEqual(deleted.sort(), ['old-a', 'old-srv']);
  db.close();
});

test('concurrent admin saves cannot restore a stale DNS token', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  const service = new DnsService(db);
  const initialRevision = service.settings().revision;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const zoneAuthorizations: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    if (url.endsWith('/zones/zone-123')) {
      zoneAuthorizations.push(authorization);
      if (authorization === 'Bearer replacement-token') {
        markFirstStarted();
        await firstGate;
      }
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    if (url.includes('/dns_records?')) {
      return cloudflareResult([
        {
          id: 'existing-a',
          type: 'A',
          name: 'factorio-tools-manager.games.example.com',
          content: '203.0.113.42',
        },
      ]);
    }
    if (method === 'PUT') return cloudflareResult({ id: 'existing-a' });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const replaceToken = service.activateSettings(
    { cloudflareToken: 'replacement-token' },
    initialRevision,
  );
  await firstStarted;
  const staleSave = service.activateSettings(
    { ddnsIntervalSeconds: 600 },
    initialRevision,
  );

  // The second request must wait outside the network/commit section. Once the
  // first request commits, its stale expected revision is rejected.
  await Promise.resolve();
  assert.deepEqual(zoneAuthorizations, ['Bearer replacement-token']);
  releaseFirst();
  await replaceToken;
  await assert.rejects(staleSave, /DNS settings changed in another session/);

  assert.equal(getDnsSettings(db).cloudflareToken, 'replacement-token');
  assert.equal(getDnsSettings(db).ddnsIntervalSeconds, 300);
  assert.deepEqual(zoneAuthorizations, ['Bearer replacement-token']);

  const refreshedRevision = getDnsSettings(db).revision;
  await service.activateSettings({ ddnsIntervalSeconds: 600 }, refreshedRevision);
  assert.equal(getDnsSettings(db).cloudflareToken, 'replacement-token');
  assert.equal(getDnsSettings(db).ddnsIntervalSeconds, 600);
  assert.deepEqual(zoneAuthorizations, [
    'Bearer replacement-token',
    'Bearer replacement-token',
  ]);
  db.close();
});
