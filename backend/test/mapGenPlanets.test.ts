import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

/**
 * Space Age made planets a data-stage prototype, so a planet mod's world previews
 * exactly like Vulcanus — but only if we know its name. No hardcoded list can supply
 * one, so the loaded mod set is asked directly. That costs a container boot, hence the
 * caching, and the answer is only valid for the mod set that produced it.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-planets-'));
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

/** A mod zip on disk, as installedMods and the runtime scan both read it. */
function writeMod(serverId: string, name: string, version: string, lua: string) {
  const zip = new AdmZip();
  const dir = `${name}_${version}`;
  zip.addFile(`${dir}/info.json`, Buffer.from(JSON.stringify({ name, version })));
  zip.addFile(`${dir}/control.lua`, Buffer.from(lua));
  fs.writeFileSync(path.join(serverFiles.modsDir(serverId), `${dir}.zip`), zip.toBuffer());
}

function harness(planets: string[] = ['nauvis', 'maraxsis']) {
  const db = openDb(':memory:');
  const repo = new ServersRepo(db);
  const scenarioRuns: string[][] = [];
  const installed: { name: string; version: string }[] = [];
  const manager = new ServerManager(
    db,
    repo,
    { allocatePair: () => ({ gamePort: 34197, rconPort: 27015 }), releaseServerPorts: () => {} } as never,
    {
      ensureNetwork: async () => {},
      hostPortsInUse: async () => new Set<number>(),
      remove: async () => {},
      runOneShot: async (_row: unknown, _hostDir: string, args: string[]) => {
        scenarioRuns.push(args);
        return { exitCode: 0, logs: `FTM_BEGIN${JSON.stringify(planets)}FTM_END` };
      },
    } as never,
    { createServerSrv: async () => {} } as never,
    undefined as never,
    undefined as never,
    { installedMods: () => installed, downloadMissing: async () => [] } as never,
    { forServer: async () => profile } as never,
  );
  return { repo, manager, scenarioRuns, installed };
}

async function server(manager: InstanceType<typeof ServerManager>) {
  const draft = await manager.createDraft({ source: 'generate' });
  serverFiles.ensureDirs(draft.id);
  return draft.id;
}

test('planets come from the loaded mod set, including modded ones', async () => {
  const { manager, scenarioRuns } = harness(['aquilo', 'maraxsis', 'nauvis']);
  const id = await server(manager);

  const found = await manager.listPlanets(id);

  assert.deepEqual(found, ['aquilo', 'maraxsis', 'nauvis']);
  // The listing is only meaningful with the server's mods loaded.
  assert.ok(scenarioRuns[0].includes('--mod-directory'));
  assert.ok(scenarioRuns[0].includes('ftm-planets'));
});

test('a repeat listing reuses the cached answer instead of booting again', async () => {
  const { manager, scenarioRuns } = harness();
  const id = await server(manager);

  await manager.listPlanets(id);
  await manager.listPlanets(id);

  assert.equal(scenarioRuns.length, 1);
});

test('changing the mod set invalidates the cached listing', async () => {
  const { manager, scenarioRuns, installed } = harness();
  const id = await server(manager);
  serverFiles.writeModList(id, [{ name: 'maraxsis', enabled: true }]);
  installed.push({ name: 'maraxsis', version: '1.0.0' });

  await manager.listPlanets(id);
  installed[0].version = '1.1.0'; // the user updated the mod
  await manager.listPlanets(id);

  assert.equal(scenarioRuns.length, 2);
});

test('an empty listing is an error, not a server with no planets', async () => {
  const { manager } = harness([]);
  const id = await server(manager);

  await assert.rejects(() => manager.listPlanets(id), /no planets/);
});

test('only enabled mods are reported as changing the map at runtime', async () => {
  const { manager } = harness();
  const id = await server(manager);
  writeMod(id, 'rso-mod', '6.2.6', 'script.on_event(defines.events.on_chunk_generated, f)');
  writeMod(id, 'off-mod', '1.0.0', 'game.create_surface("x")');
  writeMod(id, 'tidy-mod', '1.0.0', 'data.raw.tile["grass-1"] = {}');
  serverFiles.writeModList(id, [
    { name: 'rso-mod', enabled: true },
    { name: 'off-mod', enabled: false },
    { name: 'tidy-mod', enabled: true },
  ]);

  const flagged = manager.runtimeMapGenMods(id);

  // The disabled mod can't affect the world; the prototype-only one is shown faithfully.
  assert.deepEqual(
    flagged.map((m) => m.name),
    ['rso-mod'],
  );
  assert.deepEqual(flagged[0].effects, ['rewrites chunks as they generate']);
});

test('a server with no mods on disk reports nothing to warn about', async () => {
  const { manager } = harness();
  const id = await server(manager);

  assert.deepEqual(manager.runtimeMapGenMods(id), []);
});
