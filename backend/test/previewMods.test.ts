import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Map previews have to render with the server's own mods — on every planet, Nauvis
 * included. Previously the mod dir was only passed for non-Nauvis planets, on the
 * theory that Nauvis "keeps the bundled defaults". But runOneShot invokes the bare
 * binary, whose config resolves write-data to the image's install root, so a Nauvis
 * preview loaded no mods at all: terrain mods (Alien Biomes, Krastorio, ...) were
 * invisible, and the seed a player picked off the preview generated a different world
 * than --create, which has always passed --mod-directory.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-preview-mods-'));
const { openDb } = await import('../src/db/index.js');
const { ServersRepo } = await import('../src/db/serversRepo.js');
const { ServerManager } = await import('../src/services/serverManager.js');
const { serverFiles } = await import('../src/services/serverFiles.js');

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
  const oneShotArgs: string[][] = [];
  const manager = new ServerManager(
    db,
    repo,
    { allocatePair: () => ({ gamePort: 34197, rconPort: 27015 }), releaseServerPorts: () => {} } as never,
    {
      ensureNetwork: async () => {},
      hostPortsInUse: async () => new Set<number>(),
      remove: async () => {},
      // Stand in for the render: record the args, then leave the PNG the one-shot
      // would have written so readPreview finds it.
      runOneShot: async (row: { id: string }, _hostDir: string, args: string[]) => {
        oneShotArgs.push(args);
        const dir = serverFiles.previewDir(row.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'out.png'), 'png-bytes');
        return { exitCode: 0, logs: '' };
      },
    } as never,
    { createServerSrv: async () => {} } as never,
    undefined as never,
    undefined as never,
    { installedMods: () => [], downloadMissing: async () => [] } as never,
    { forServer: async () => profile } as never,
  );
  return { repo, manager, oneShotArgs };
}

async function previewableServer(manager: InstanceType<typeof ServerManager>) {
  const draft = await manager.createDraft({ source: 'generate' });
  serverFiles.ensureDirs(draft.id);
  return draft.id;
}

/** The value following `flag` in an argv array, or undefined when absent. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('a Nauvis preview loads the server mods', async () => {
  const { manager, oneShotArgs } = harness();
  const id = await previewableServer(manager);

  const png = await manager.previewMap(id, { planet: 'nauvis' });

  assert.equal(png.toString(), 'png-bytes');
  assert.equal(argValue(oneShotArgs[0], '--mod-directory'), '/factorio/mods');
  assert.equal(argValue(oneShotArgs[0], '--map-preview-planet'), 'nauvis');
});

test('a preview with no planet named still loads the server mods', async () => {
  const { manager, oneShotArgs } = harness();
  const id = await previewableServer(manager);

  await manager.previewMap(id);

  assert.equal(argValue(oneShotArgs[0], '--mod-directory'), '/factorio/mods');
  assert.ok(!oneShotArgs[0].includes('--map-preview-planet'));
});

test('off-world planets keep loading the server mods', async () => {
  const { manager, oneShotArgs } = harness();
  const id = await previewableServer(manager);

  await manager.previewMap(id, { planet: 'vulcanus' });

  assert.equal(argValue(oneShotArgs[0], '--mod-directory'), '/factorio/mods');
  assert.equal(argValue(oneShotArgs[0], '--map-preview-planet'), 'vulcanus');
});

test('the mod list is reconciled with the game mode before rendering', async () => {
  const { manager } = harness();
  const id = await previewableServer(manager);

  await manager.previewMap(id, { planet: 'nauvis' });

  // Default mode is space_age, so its closure should be enabled in mod-list.json —
  // the same reconciliation map generation does, so preview and --create agree.
  const modList = serverFiles.readModList(id);
  assert.equal(modList.find((m) => m.name === 'space-age')?.enabled, true);
  assert.equal(modList.find((m) => m.name === 'quality')?.enabled, true);
});
