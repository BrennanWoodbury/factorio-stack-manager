import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ServerRow } from '../src/db/models.js';

/**
 * A mod list is written before its downloads run, so a failure part-way leaves
 * mods enabled with no zips — a server that refuses to start and can only be
 * fixed by re-saving the list by hand. These cover finding that state and
 * healing it.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-ondemand-'));
const { ModService } = await import('../src/services/modService.js');
const { serverFiles } = await import('../src/services/serverFiles.js');

function installZip(serverId: string, name: string, version = '1.0.0'): void {
  const dir = serverFiles.modsDir(serverId);
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile(
    `${name}_${version}/info.json`,
    Buffer.from(JSON.stringify({ name, version, factorio_version: '2.0', dependencies: ['base'] })),
  );
  zip.writeZip(path.join(dir, `${name}_${version}.zip`));
}

function server(id: string): ServerRow {
  serverFiles.ensureDirs(id);
  return { id, factorio_tag: '' } as ServerRow;
}

test('mods enabled with no zip on disk are the missing ones', () => {
  const mods = new ModService(undefined as never);
  const id = 'srv-missing';
  server(id);
  installZip(id, 'flib');
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'space-age', enabled: true },
    { name: 'flib', enabled: true },
    { name: 'Milestones', enabled: true },
    { name: 'RateCalculator', enabled: false },
  ]);

  assert.deepEqual(
    mods.missingMods(id),
    ['Milestones'],
    'base and space-age ship in the image; flib is installed; a disabled mod is not needed',
  );
});

test('nothing is missing when every enabled mod is present', () => {
  const mods = new ModService(undefined as never);
  const id = 'srv-complete';
  server(id);
  installZip(id, 'flib');
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'flib', enabled: true },
  ]);

  assert.deepEqual(mods.missingMods(id), []);
});

test('downloadMissing reports every failure rather than stopping at the first', async () => {
  // Without credentials each download fails the same way — which is exactly the
  // case that needs all of them named, not just the first.
  const mods = new ModService({
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
  } as never);
  const id = 'srv-nofetch';
  server(id);
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'Milestones', enabled: true },
    { name: 'RateCalculator', enabled: true },
  ]);

  const failures = await mods.downloadMissing({ id, factorio_tag: '' } as ServerRow);

  assert.deepEqual(
    failures.map((f) => f.name),
    ['Milestones', 'RateCalculator'],
  );
  assert.match(failures[0].error, /Factorio\.com account is required/);
});

test('downloadMissing does nothing when there is nothing to fetch', async () => {
  const mods = new ModService(undefined as never);
  const id = 'srv-nothing';
  server(id);
  installZip(id, 'flib');
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'flib', enabled: true },
  ]);

  // No DB access, no network: with nothing missing neither is reached.
  assert.deepEqual(await mods.downloadMissing({ id, factorio_tag: '' } as ServerRow), []);
});

test('a corrupt zip counts as missing, so the mod is re-fetched rather than trusted', () => {
  const mods = new ModService(undefined as never);
  const id = 'srv-corrupt';
  server(id);
  fs.writeFileSync(path.join(serverFiles.modsDir(id), 'flib_1.0.0.zip'), 'not a zip');
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'flib', enabled: true },
  ]);

  assert.deepEqual(mods.missingMods(id), ['flib']);
});
