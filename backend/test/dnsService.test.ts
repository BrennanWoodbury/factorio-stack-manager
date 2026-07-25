import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { DnsService } from '../src/services/dnsService.js';
import { getDnsSettings, setDnsSettings } from '../src/services/dnsSettings.js';

const originalFetch = globalThis.fetch;

function cloudflareResult(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
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
    hostRecordName: 'host.games.example.com',
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

test('rejects server names outside the selected Cloudflare zone', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return cloudflareResult({ id: 'zone-123', name: 'example.com', status: 'active' });
  };

  const result = await new DnsService(db).testConnection({
    baseDomain: 'games.invalid.test',
    hostRecordName: 'host.games.invalid.test',
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
    hostRecordName: 'host.example.com',
    cloudflareZoneId: 'zone-123',
    ipCheckUrl: 'https://ip.example.test',
  });

  assert.equal(result.ok, true);
  db.close();
});
