import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { ModpacksRepo } from '../src/db/modpacksRepo.js';
import { ServersRepo } from '../src/db/serversRepo.js';
import { ModpackService } from '../src/services/modpackService.js';
import type { ModService } from '../src/services/modService.js';
import type { ServerRow } from '../src/db/models.js';
import type { ModEntry } from '../src/services/serverFiles.js';

/**
 * Applying a modpack from the new-server wizard points the existing apply path at
 * a draft row rather than an active server. Nothing downloads here — the mod
 * service is stubbed — because what needs proving is that a draft resolves at all
 * and gets the pack's list, not that the portal works.
 */
function harness() {
  const db = openDb(':memory:');
  const packs = new ModpacksRepo(db);
  const servers = new ServersRepo(db);
  const applied: { server: ServerRow; entries: ModEntry[] }[] = [];
  const mods = {
    applyModList: async (server: ServerRow, entries: ModEntry[]) => {
      applied.push({ server, entries });
      return { downloaded: entries.map((e) => ({ name: e.name, version: '1.0.0' })), errors: [] };
    },
  } as unknown as ModService;

  packs.insert({ id: 'pack1', name: 'Ribbon World', description: '', factorio_version: '2.0' });
  packs.replaceMods('pack1', [
    { name: 'flib', enabled: true, version: null },
    { name: 'space-exploration', enabled: true, version: null },
  ]);

  return { db, packs, servers, applied, service: new ModpackService(packs, servers, mods) };
}

function insertRow(db: ReturnType<typeof openDb>, id: string, lifecycle: string): void {
  db.prepare(
    `INSERT INTO servers (id, name, subdomain, game_port, rcon_port, rcon_password, lifecycle)
     VALUES (?, ?, ?, 0, 0, 'pw', ?)`,
  ).run(id, id, `${id}-sub`, lifecycle);
}

test('a modpack can be applied to a wizard draft, not just an active server', async () => {
  const h = harness();
  insertRow(h.db, 'draft1', 'draft');

  const result = await h.service.apply('pack1', 'draft1');

  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].server.id, 'draft1');
  assert.deepEqual(
    h.applied[0].entries.map((e) => e.name),
    ['flib', 'space-exploration'],
    "the draft receives the pack's whole list",
  );
  assert.deepEqual(
    result.downloaded.map((d) => d.name),
    ['flib', 'space-exploration'],
  );
});

test('the draft records which pack it was given, so finalize carries it over', async () => {
  const h = harness();
  insertRow(h.db, 'draft1', 'draft');

  await h.service.apply('pack1', 'draft1');

  assert.equal(h.servers.getById('draft1')?.applied_modpack_id, 'pack1');
});

test('applying to an id that does not exist is still refused', async () => {
  const h = harness();
  await assert.rejects(() => h.service.apply('pack1', 'nope'), /Server/);
  assert.deepEqual(h.applied, [], 'nothing is downloaded for a server that is not there');
});

test('a draft is excluded from the operational listing it would pollute', () => {
  const h = harness();
  insertRow(h.db, 'draft1', 'draft');
  insertRow(h.db, 'live1', 'active');

  assert.deepEqual(
    h.servers.list().map((r) => r.id),
    ['live1'],
    'drafts stay out of the server list even once they hold mods',
  );
  assert.ok(h.servers.getById('draft1'), 'but are still addressable by id');
});
