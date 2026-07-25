import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictingHostPorts } from '../src/services/dockerService.js';

/**
 * Docker reports a port collision as a plain HTTP 500 with the reason in the
 * message — there is no status code that distinguishes it from any other start
 * failure, so this string match is what decides between "move to another port"
 * and "give up and tell the user". Both directions matter: missing a conflict
 * leaves the old broken behaviour, and a false positive would silently move a
 * server's port over an unrelated failure.
 */

// Verbatim from a real failed start.
const REAL = `(HTTP code 500) server error - driver failed programming external connectivity on endpoint ftm-739ab045 (d0295a97ddfa816084f4960166e2c47dd868cb5a841a5199defdaabebba997cc): Bind for 0.0.0.0:34197 failed: port is already allocated `;

test('the port is picked out of a real Docker bind failure', () => {
  assert.deepEqual(conflictingHostPorts(new Error(REAL)), [34197]);
});

test('a loopback binding (RCON) is recognised the same way', () => {
  assert.deepEqual(
    conflictingHostPorts(new Error('Bind for 127.0.0.1:27015 failed: port is already allocated')),
    [27015],
  );
});

test('every port named in one failure is returned', () => {
  const err = new Error(
    'Bind for 0.0.0.0:34197 failed: port is already allocated; ' +
      'Bind for 127.0.0.1:27015 failed: port is already allocated',
  );
  assert.deepEqual(conflictingHostPorts(err), [34197, 27015]);
});

test('the kernel phrasing is recognised too', () => {
  assert.deepEqual(
    conflictingHostPorts(new Error('Bind for 0.0.0.0:34200 failed: address already in use')),
    [34200],
  );
});

test('an unrelated failure is not treated as a port conflict', () => {
  // These must surface to the user, not silently move the server to another port.
  for (const message of [
    'no such image: factoriotools/factorio:stable',
    'driver failed programming external connectivity on endpoint ftm-abc',
    'container ftm-abc is already running',
    'permission denied while trying to connect to the Docker daemon socket',
  ]) {
    assert.deepEqual(conflictingHostPorts(new Error(message)), [], message);
  }
});

test('non-Error values do not throw', () => {
  assert.deepEqual(conflictingHostPorts(undefined), []);
  assert.deepEqual(conflictingHostPorts(null), []);
  assert.deepEqual(conflictingHostPorts('Bind for 0.0.0.0:34197 failed: port is already allocated'), [
    34197,
  ]);
});
