import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { getOrCreateInstanceId, buildPingEvent } from '../src/jobs/telemetry.js';
import type { AppConfig } from '../src/config.js';

const fakeConfig = { appVersion: '1.2.3' } as AppConfig;

test('getOrCreateInstanceId', async (t) => {
  await t.test('creates a random id and persists it across calls', () => {
    const db = openDb(':memory:');
    const first = getOrCreateInstanceId(db);
    const second = getOrCreateInstanceId(db);
    assert.equal(first, second);
    // Full RFC 4122 v4 shape (hyphen positions, version nibble, variant nibble)
    // — not just length/charset, so a malformed id would actually fail this.
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  await t.test('two fresh installs get different ids', () => {
    const a = getOrCreateInstanceId(openDb(':memory:'));
    const b = getOrCreateInstanceId(openDb(':memory:'));
    assert.notEqual(a, b);
  });
});

test('buildPingEvent', async (t) => {
  await t.test('carries only the documented fields, nothing identifying', () => {
    const event = buildPingEvent(fakeConfig, 'abc-123', 4);
    assert.equal(event.eventName, 'heartbeat');
    assert.equal(event.props.instance_id, 'abc-123');
    assert.equal(event.props.server_count, 4);
    assert.equal(event.systemProps.appVersion, '1.2.3');
    assert.deepEqual(Object.keys(event.props).sort(), ['instance_id', 'server_count']);
  });

  await t.test('sessionId is well under Aptabase\'s 36-char limit for non-numeric ids', () => {
    const event = buildPingEvent(fakeConfig, 'abc-123', 0);
    assert.ok(event.sessionId.length <= 36);
  });
});
