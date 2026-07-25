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
    'factorio-stack-manager.factorio.example.com',
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
          name: 'factorio-stack-manager.games.example.com',
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
      ['A', 'factorio-stack-manager.games.example.com', 'created'],
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
        { id: 'discovered-a', name: 'factorio-stack-manager.games.example.com' },
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
        { id: 'new-a', name: 'factorio-stack-manager.games.example.com' },
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
          name: 'factorio-stack-manager.games.example.com',
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

/** The row as the manager would hand it to DnsService. */
function serverRow(db: ReturnType<typeof openDb>, id: string) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Parameters<
    DnsService['createServerSrv']
  >[0];
}

/** Records every Cloudflare write so the request body itself can be asserted. */
function captureCloudflare(): { writes: { method: string; url: string; body: any }[] } {
  const writes: { method: string; url: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return cloudflareResult({ id: 'record-1', type: 'SRV', name: 'x', content: 'y' });
    }
    if (url.includes('/dns_records?')) return cloudflareResult([]);
    if (url.endsWith('/zones/zone-123')) {
      return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
    }
    if (url === 'https://ip.example.test') return new Response('203.0.113.42');
    throw new Error(`Unexpected request: ${url}`);
  };
  return { writes };
}

test('an SRV record is created with the full record name Cloudflare requires', async () => {
  // Cloudflare used to derive the name from data.service/proto/name and now
  // requires the top-level field, rejecting a request without one as
  // "9000: DNS name is invalid" — which is what a server create hit.
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'srv1', 'factory', 34197);
  const { writes } = captureCloudflare();

  await new DnsService(db).createServerSrv(serverRow(db, 'srv1'));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].body.type, 'SRV');
  assert.equal(writes[0].body.name, '_factorio._udp.factory.games.example.com');
  assert.deepEqual(writes[0].body.data.name, 'factory.games.example.com');
  assert.equal(writes[0].body.data.port, 34197);
});

test('a server opted out of DNS gets no Cloudflare record at all', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'srv1', 'private', 34197);
  db.prepare('UPDATE servers SET dns_enabled = 0 WHERE id = ?').run('srv1');
  const { writes } = captureCloudflare();

  await new DnsService(db).createServerSrv(serverRow(db, 'srv1'));

  assert.deepEqual(writes, [], 'nothing is sent to Cloudflare');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM dns_records WHERE server_id = 'srv1'").get<{ n: number }>()
      ?.n,
    0,
  );
});

test('opting a server out afterwards removes the record it already had', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'srv1', 'factory', 34197);
  const dns = new DnsService(db);
  captureCloudflare();
  await dns.createServerSrv(serverRow(db, 'srv1'));

  db.prepare('UPDATE servers SET dns_enabled = 0 WHERE id = ?').run('srv1');
  const { writes } = captureCloudflare();
  await dns.updateServerSrv(serverRow(db, 'srv1'));

  assert.deepEqual(
    writes.map((w) => w.method),
    ['DELETE'],
    'the existing record is deleted, not updated',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM dns_records WHERE server_id = 'srv1'").get<{ n: number }>()
      ?.n,
    0,
  );
});

test('other servers keep their records when one opts out', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'keep', 'public', 34197);
  insertServer(db, 'drop', 'private', 34198);
  db.prepare('UPDATE servers SET dns_enabled = 0 WHERE id = ?').run('drop');
  const dns = new DnsService(db);
  const { writes } = captureCloudflare();

  await dns.createServerSrv(serverRow(db, 'keep'));
  await dns.createServerSrv(serverRow(db, 'drop'));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.name, '_factorio._udp.public.games.example.com');
});

test('switching DNS off stops all automation but keeps the settings', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'srv1', 'factory', 34197);
  setDnsSettings(db, { enabled: false });
  const { writes } = captureCloudflare();

  await new DnsService(db).createServerSrv(serverRow(db, 'srv1'));
  assert.deepEqual(writes, []);

  const s = getDnsSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.cloudflareToken, 'token-123', 'the token is still there to switch back on with');
  assert.equal(s.cloudflareZoneId, 'zone-123');
  assert.equal(s.baseDomain, 'games.example.com');

  setDnsSettings(db, { enabled: true });
  await new DnsService(db).createServerSrv(serverRow(db, 'srv1'));
  assert.equal(writes.length, 1, 'switching back on resumes without retyping anything');
});

test('DNS defaults to on for installations that predate the switch', () => {
  const db = openDb(':memory:');
  configureDns(db);
  assert.equal(kvGet(db, 'dns_enabled'), undefined, 'nothing stored');
  assert.equal(getDnsSettings(db).enabled, true);
});

test('reconciliation sends the record name on every SRV write too', async () => {
  // A separate call site from createServerSrv, and the one a manual "Sync DNS now"
  // uses — it needs the same top-level name or every record fails with 9000.
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'srv1', 'factory', 34197);
  const { writes } = captureCloudflare();

  const run = await new DnsService(db).reconcile();

  assert.equal(run.ok, true);
  const srvWrites = writes.filter((w) => w.body?.type === 'SRV');
  assert.equal(srvWrites.length, 1);
  assert.equal(srvWrites[0].body.name, '_factorio._udp.factory.games.example.com');
});

/** Inserts a tracked SRV row as it would exist under the pre-rebrand host label. */
function insertLegacySrvRow(
  db: ReturnType<typeof openDb>,
  serverId: string,
  subdomain: string,
  port: number,
  recordId: string,
): void {
  db.prepare(
    `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
     VALUES (?, 'SRV', ?, ?, ?)`,
  ).run(
    serverId,
    `_factorio._udp.${subdomain}.games.example.com`,
    recordId,
    `factorio-tools-manager.games.example.com:${port}`,
  );
}

test('host-label migration is a no-op when DNS is not configured', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('should not have called Cloudflare');
  };

  await new DnsService(db).migrateHostLabelRename();

  assert.equal(calls, 0);
  assert.equal(kvGet(db, 'dns_host_label_migrated'), undefined);
  db.close();
});

test('host-label migration no-ops once already marked done', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  kvSet(db, 'dns_host_label_migrated', '1');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('should not have called Cloudflare');
  };

  await new DnsService(db).migrateHostLabelRename();

  assert.equal(calls, 0);
  db.close();
});

test('host-label migration creates the new A record, repoints every SRV, and redirects the old one', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  insertServer(db, 'beta', 'beta', 34198);
  insertLegacySrvRow(db, 'alpha', 'alpha', 34197, 'srv-alpha');
  insertLegacySrvRow(db, 'beta', 'beta', 34198, 'srv-beta');
  kvSet(db, 'last_public_ip', '203.0.113.42');

  const deleted: string[] = [];
  const writes: { method: string; url: string; body: any }[] = [];
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    if (method === 'GET' && url.includes('type=A')) return cloudflareResult([]); // new A: not found yet
    if (method === 'GET' && !url.includes('type=')) {
      // findRecordsByName(oldName) — the pre-rebrand A record is still there.
      return cloudflareResult([
        { id: 'old-a', type: 'A', name: 'factorio-tools-manager.games.example.com', content: '198.51.100.1' },
      ]);
    }
    if (method === 'POST' && url.endsWith('/dns_records')) {
      const body = JSON.parse(String(init?.body)) as { type: string };
      if (body.type === 'A') return cloudflareResult({ id: 'new-a' });
      if (body.type === 'CNAME') return cloudflareResult({ id: 'cname-1' });
    }
    if (method === 'PUT') return cloudflareResult({ id: url.split('/').at(-1) });
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const dns = new DnsService(db);
  await dns.migrateHostLabelRename();

  assert.equal(kvGet(db, 'host_a_record_id'), 'new-a');
  assert.equal(kvGet(db, 'dns_host_label_migrated'), '1');
  assert.equal(kvGet(db, 'dns_host_record'), 'factorio-stack-manager.games.example.com');
  assert.equal(
    db.prepare<{ content: string }>("SELECT content FROM dns_records WHERE server_id = 'alpha'").get()
      ?.content,
    'factorio-stack-manager.games.example.com:34197',
  );
  assert.equal(
    db.prepare<{ content: string }>("SELECT content FROM dns_records WHERE server_id = 'beta'").get()
      ?.content,
    'factorio-stack-manager.games.example.com:34198',
  );

  const srvWrites = writes.filter((w) => w.body?.type === 'SRV');
  assert.equal(srvWrites.length, 2);
  for (const w of srvWrites) assert.equal(w.body.data.target, 'factorio-stack-manager.games.example.com');

  assert.deepEqual(deleted, ['old-a']);
  const cnameWrite = writes.find((w) => w.body?.type === 'CNAME');
  assert.equal(cnameWrite?.body.name, 'factorio-tools-manager.games.example.com');
  assert.equal(cnameWrite?.body.content, 'factorio-stack-manager.games.example.com');

  const callsBeforeRetry = calls;
  await dns.migrateHostLabelRename();
  assert.equal(calls, callsBeforeRetry, 'a second call makes no further Cloudflare requests');
  db.close();
});

test('host-label migration leaves the old record alone when it is already gone', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  insertLegacySrvRow(db, 'alpha', 'alpha', 34197, 'srv-alpha');
  kvSet(db, 'last_public_ip', '203.0.113.42');

  const deleted: string[] = [];
  const writes: { method: string; url: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    if (method === 'GET' && url.includes('type=A')) return cloudflareResult([]);
    if (method === 'GET' && !url.includes('type=')) return cloudflareResult([]); // old record already gone
    if (method === 'POST' && url.endsWith('/dns_records')) {
      return cloudflareResult({ id: 'new-a' });
    }
    if (method === 'PUT') return cloudflareResult({ id: url.split('/').at(-1) });
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  await new DnsService(db).migrateHostLabelRename();

  assert.equal(kvGet(db, 'dns_host_label_migrated'), '1');
  assert.deepEqual(deleted, []);
  assert.equal(writes.some((w) => w.body?.type === 'CNAME'), false);
  db.close();
});

test('host-label migration retries on the next call after a partial SRV failure', async () => {
  const db = openDb(':memory:');
  configureDns(db);
  insertServer(db, 'alpha', 'alpha', 34197);
  insertServer(db, 'beta', 'beta', 34198);
  insertLegacySrvRow(db, 'alpha', 'alpha', 34197, 'srv-alpha');
  insertLegacySrvRow(db, 'beta', 'beta', 34198, 'srv-beta');
  kvSet(db, 'last_public_ip', '203.0.113.42');

  let aRecordCreated = false;
  let betaAttempts = 0;
  const deleted: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('type=A')) {
      return cloudflareResult(aRecordCreated ? [{ id: 'new-a', type: 'A', content: '203.0.113.42' }] : []);
    }
    if (method === 'GET' && !url.includes('type=')) {
      return cloudflareResult([
        { id: 'old-a', type: 'A', name: 'factorio-tools-manager.games.example.com', content: '198.51.100.1' },
      ]);
    }
    if (method === 'POST' && url.endsWith('/dns_records')) {
      const body = JSON.parse(String(init?.body)) as { type: string };
      if (body.type === 'A') {
        aRecordCreated = true;
        return cloudflareResult({ id: 'new-a' });
      }
      if (body.type === 'CNAME') return cloudflareResult({ id: 'cname-1' });
    }
    if (method === 'PUT' && url.endsWith('/srv-beta')) {
      betaAttempts++;
      if (betaAttempts === 1) return cloudflareFailure('temporary failure');
      return cloudflareResult({ id: 'srv-beta' });
    }
    if (method === 'PUT') return cloudflareResult({ id: url.split('/').at(-1) });
    if (method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return cloudflareResult({ id: url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const dns = new DnsService(db);
  await dns.migrateHostLabelRename();

  assert.equal(kvGet(db, 'dns_host_label_migrated'), undefined, 'not marked done: beta was not repointed');
  assert.equal(kvGet(db, 'host_a_record_id'), undefined, 'bookkeeping withheld until every SRV succeeds');
  assert.deepEqual(deleted, [], 'the old record is untouched until the migration fully succeeds');

  await dns.migrateHostLabelRename();

  assert.equal(kvGet(db, 'dns_host_label_migrated'), '1');
  assert.equal(kvGet(db, 'host_a_record_id'), 'new-a');
  assert.equal(
    db.prepare<{ content: string }>("SELECT content FROM dns_records WHERE server_id = 'beta'").get()
      ?.content,
    'factorio-stack-manager.games.example.com:34198',
  );
  assert.deepEqual(deleted, ['old-a']);
  db.close();
});
