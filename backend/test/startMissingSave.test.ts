import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A server's recorded save can go missing on disk — deleted by hand, lost in a
 * restore, or a wizard step that pinned generate_new_save=0 before the upload
 * actually landed a file. Before this fix, start() handed that name straight to
 * the Factorio image as SAVE_NAME, which errors out looking for a file that was
 * never there — surfacing as a raw container-log error instead of anything this
 * app explains. It should instead boot the newest save on disk, which is where
 * autosaves land, rather than fail outright when a good save still exists.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-missing-save-'));
const { openDb } = await import('../src/db/index.js');
const { ServersRepo } = await import('../src/db/serversRepo.js');
const { ServerManager } = await import('../src/services/serverManager.js');
const { serverFiles } = await import('../src/services/serverFiles.js');

// Satisfies the default 'space_age' game mode's dependency closure so
// applyGameModeMods/modProblems don't reject it.
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
  const createContainerCalls: unknown[] = [];
  const manager = new ServerManager(
    db,
    repo,
    { allocatePair: () => ({ gamePort: 34197, rconPort: 27015 }), releaseServerPorts: () => {} } as never,
    {
      ensureNetwork: async () => {},
      hostPortsInUse: async () => new Set<number>(),
      remove: async () => {},
      createContainer: async (row: unknown) => {
        createContainerCalls.push(row);
        return 'fake-container-id';
      },
      start: async () => {},
    } as never,
    { createServerSrv: async () => {} } as never,
    undefined as never,
    undefined as never,
    { installedMods: () => [], downloadMissing: async () => [] } as never,
    { forServer: async () => profile } as never,
  );
  return { repo, manager, createContainerCalls };
}

/** A real, active (non-draft) server ready to start, pointed at a save that exists. */
async function activeServer(repo: InstanceType<typeof ServersRepo>, manager: InstanceType<typeof ServerManager>) {
  const draft = await manager.createDraft({ source: 'save' });
  serverFiles.ensureDirs(draft.id);
  serverFiles.writeSave(draft.id, 'my-world', Buffer.from('a save'));
  repo.update(
    draft.id,
    {
      lifecycle: 'active',
      subdomain: 'test-server',
      dns_enabled: 0,
      save_name: 'my-world',
      generate_new_save: 0,
    } as never,
  );
  return draft.id;
}

test('starting with a missing save falls back to the newest save on disk', async () => {
  const { repo, manager } = harness();
  const id = await activeServer(repo, manager);

  // The recorded save disappears (deleted by hand, a lost restore, ...), but an
  // autosave from a previous run is still sitting in the same directory.
  serverFiles.deleteSave(id, 'my-world');
  serverFiles.writeSave(id, '_autosave1', Buffer.from('autosave'));

  await manager.start(id);

  assert.equal(repo.getById(id)!.save_name, '_autosave1');
  assert.equal(repo.getById(id)!.status, 'running');
});

test('a save that still exists is left alone', async () => {
  const { repo, manager } = harness();
  const id = await activeServer(repo, manager);

  await manager.start(id);

  assert.equal(repo.getById(id)!.save_name, 'my-world');
});

test('no save anywhere fails loudly instead of booting a broken container', async () => {
  const { repo, manager, createContainerCalls } = harness();
  const id = await activeServer(repo, manager);
  serverFiles.deleteSave(id, 'my-world');

  await assert.rejects(() => manager.start(id), /my-world.*not found.*no other saves/s);
  assert.equal(createContainerCalls.length, 0);
});

test('a server meant to generate a new map is untouched even with no save yet', async () => {
  const { repo, manager } = harness();
  const draft = await manager.createDraft({ source: 'generate' });
  repo.update(
    draft.id,
    { lifecycle: 'active', subdomain: 'fresh-server', dns_enabled: 0 } as never,
  );

  await manager.start(draft.id);

  assert.equal(repo.getById(draft.id)!.save_name, 'default');
  assert.equal(repo.getById(draft.id)!.status, 'running');
});
