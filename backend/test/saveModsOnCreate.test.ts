import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { SaveMod } from '../src/services/saveInspect.js';

/**
 * An uploaded save's mods were only ever installed by the pre-flight boot probe, so
 * "create without testing" produced a server with the save's portal mods missing —
 * and Factorio doesn't error on that, it drops them and hosts a gutted world. On top
 * of it, a save draft kept the wizard's default game mode (Space Age), which forced
 * the expansion on for every uploaded world including vanilla ones.
 *
 * These cover the save's header being what decides its mod set, on every path that
 * turns a draft into a server.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-save-mods-'));
const { openDb } = await import('../src/db/index.js');
const { ServersRepo } = await import('../src/db/serversRepo.js');
const { ServerManager } = await import('../src/services/serverManager.js');
const { serverFiles } = await import('../src/services/serverFiles.js');

/** A `level-init.dat` header, in the byte layout the parser documents. */
function buildHeader(mods: SaveMod[]): Buffer {
  const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'utf8')]);
  const version = Buffer.alloc(8);
  [2, 0, 77, 0].forEach((n, i) => version.writeUInt16LE(n, i * 2));
  return Buffer.concat([
    version,
    Buffer.from([0]), // flag
    str(''), // campaign
    str('freeplay'),
    str('base'),
    Buffer.alloc(20), // fixed scenario/difficulty block
    Buffer.from([mods.length]),
    ...mods.flatMap((m) => [
      str(m.name),
      Buffer.from(m.version.split('.').map(Number)),
      Buffer.alloc(4), // crc32
    ]),
    Buffer.alloc(64, 0xab), // trailing map data
  ]);
}

/** A save file carrying that header — what the wizard's upload receives. */
function saveZip(mods: SaveMod[]): Buffer {
  const zip = new AdmZip();
  zip.addFile('my-world/level-init.dat', buildHeader(mods));
  return zip.toBuffer();
}

const SA_SAVE: SaveMod[] = [
  { name: 'base', version: '2.0.77' },
  { name: 'space-age', version: '2.0.77' },
  { name: 'quality', version: '2.0.77' },
  { name: 'flib', version: '0.16.3' },
  { name: 'Krastorio2', version: '1.3.25' },
];
const VANILLA_SAVE: SaveMod[] = [{ name: 'base', version: '2.0.77' }];

const profile = {
  imageId: 'img',
  gameVersion: '2.0.77',
  derived: true,
  mods: new Map([
    ['base', { name: 'base', version: '2.0.77', requires: [] }],
    ['space-age', { name: 'space-age', version: '2.0.77', requires: ['quality', 'elevated-rails'] }],
    ['quality', { name: 'quality', version: '2.0.77', requires: [] }],
    ['elevated-rails', { name: 'elevated-rails', version: '2.0.77', requires: [] }],
  ]),
};

function harness() {
  const db = openDb(':memory:');
  const repo = new ServersRepo(db);
  const downloaded: string[] = [];
  const manager = new ServerManager(
    db,
    repo,
    // Finalize claims ports and a DNS record; neither is what these are about.
    { allocatePair: () => ({ gamePort: 34197, rconPort: 27015 }), releaseServerPorts: () => {} } as never,
    { hostPortsInUse: async () => [] } as never,
    { createServerSrv: async () => {} } as never,
    undefined as never,
    undefined as never,
    { installedMods: () => [] } as never,
    { forServer: async () => profile } as never,
  );
  const hooks = {
    downloadMod: async (name: string, version?: string) => void downloaded.push(`${name}@${version}`),
  };
  return { repo, manager, downloaded, hooks };
}

/** Upload a save into a fresh draft, ready to finalize. */
async function draftFromSave(
  manager: InstanceType<typeof ServerManager>,
  mods: SaveMod[],
  subdomain: string,
) {
  const draft = await manager.createDraft({ source: 'save' });
  const staged = await manager.stageDraftSave(draft.id, saveZip(mods), 'my-world.zip');
  await manager.updateDraft(draft.id, { name: 'From save', subdomain });
  return { id: draft.id, staged };
}

const enabledIn = (id: string) =>
  serverFiles.readModList(id).filter((m) => m.enabled).map((m) => m.name);

test('creating without testing installs the mods the save names', async () => {
  const { manager, downloaded, hooks } = harness();
  const { id } = await draftFromSave(manager, SA_SAVE, 'from-save');

  await manager.finalize(id, hooks);

  assert.deepEqual(downloaded, ['flib@0.16.3', 'Krastorio2@1.3.25']);
  assert.deepEqual(enabledIn(id).sort(), ['Krastorio2', 'base', 'flib', 'quality', 'space-age']);
});

test('a mod the save needs but we cannot fetch fails creation instead of gutting the world', async () => {
  const { manager, repo } = harness();
  const { id } = await draftFromSave(manager, SA_SAVE, 'from-save');

  await assert.rejects(
    () =>
      manager.finalize(id, {
        downloadMod: async (name) => {
          throw new Error(`portal said no to ${name}`);
        },
      }),
    /flib.*portal said no/s,
  );
  // Nothing half-created: the draft is still a draft.
  assert.equal(repo.getById(id)!.lifecycle, 'draft');
});

test('a vanilla save does not get Space Age forced on', async () => {
  const { manager, repo, hooks } = harness();
  const { id, staged } = await draftFromSave(manager, VANILLA_SAVE, 'vanilla-save');

  assert.equal(staged.gameMode, 'modded_vanilla');
  assert.equal(repo.getById(id)!.game_mode, 'modded_vanilla');

  await manager.finalize(id, hooks);

  assert.deepEqual(enabledIn(id), ['base']);
});

test('a save that uses Space Age adopts the mode that says so', async () => {
  const { manager, repo, hooks } = harness();
  const { id, staged } = await draftFromSave(manager, SA_SAVE, 'sa-save');

  assert.equal(staged.gameMode, 'modded_space_age');
  assert.equal(repo.getById(id)!.game_mode, 'modded_space_age');

  await manager.finalize(id, hooks);
  assert.ok(enabledIn(id).includes('space-age'));
});

test('bundled mods the save does not use are switched off, not left on', async () => {
  const { manager, hooks } = harness();
  const { id } = await draftFromSave(manager, VANILLA_SAVE, 'was-modded');
  // A default modpack or an earlier flow could have left the expansion enabled.
  serverFiles.writeModList(id, [
    { name: 'base', enabled: true },
    { name: 'space-age', enabled: true },
    { name: 'quality', enabled: true },
  ]);

  await manager.finalize(id, hooks);

  assert.deepEqual(enabledIn(id), ['base']);
});

test('mods already on disk at the version the save wants are not downloaded again', async () => {
  // Resolution runs on the probe and again at create; mod zips are big.
  const { manager, repo, downloaded, hooks } = harness();
  const { id } = await draftFromSave(manager, SA_SAVE, 'already-have-them');
  (manager as never as { mods: { installedMods: () => unknown[] } }).mods = {
    installedMods: () => [
      { name: 'flib', version: '0.16.3' },
      { name: 'Krastorio2', version: '1.3.24' }, // older than the save asks for
    ],
  };

  await manager.finalize(id, hooks);

  assert.deepEqual(downloaded, ['Krastorio2@1.3.25']);
  assert.ok(enabledIn(id).includes('flib'));
  assert.equal(repo.getById(id)!.lifecycle, 'active');
});
