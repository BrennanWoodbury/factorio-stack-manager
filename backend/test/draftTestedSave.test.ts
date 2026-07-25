import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A passing probe pins the save it generated, so what gets created is exactly what
 * was tested. With a standalone "Test" button the wizard becomes a loop — test,
 * tweak, test again — and that pinned save has to be dropped when the world it was
 * generated from changes, or the second test silently re-verifies the first map.
 * The wizard autosaves the whole form constantly, so the other half of this is that
 * ordinary edits (a name, a description) must leave a tested map alone.
 */
process.env.ADMIN_PASSWORD ??= 'test-only';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-tested-save-'));
const { openDb } = await import('../src/db/index.js');
const { ServersRepo } = await import('../src/db/serversRepo.js');
const { ServerManager } = await import('../src/services/serverManager.js');
const { serverFiles } = await import('../src/services/serverFiles.js');
type DraftSource = 'generate' | 'import' | 'save';

function harness() {
  const db = openDb(':memory:');
  const repo = new ServersRepo(db);
  // Only the db + repo are exercised here: drafts never touch docker, DNS or RCON.
  const manager = new ServerManager(
    db,
    repo,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { repo, manager };
}

/** Stand in for a probe that passed: a save on disk, pinned as the boot target. */
function pinTestedSave(repo: InstanceType<typeof ServersRepo>, id: string) {
  serverFiles.ensureDirs(id);
  serverFiles.writeSave(id, 'default', Buffer.from('tested-map'));
  repo.update(id, { generate_new_save: 0, save_name: 'default' } as never);
}

async function testedDraft(source: DraftSource = 'generate') {
  const { repo, manager } = harness();
  const draft = await manager.createDraft({ source, mapGen: { terrain_segmentation: 1 } });
  await manager.updateDraft(draft.id, { mapGen: { terrain_segmentation: 1 } });
  pinTestedSave(repo, draft.id);
  return { repo, manager, id: draft.id };
}

test('editing map generation drops the tested save', async () => {
  const { repo, manager, id } = await testedDraft();

  await manager.updateDraft(id, { mapGen: { terrain_segmentation: 3 } });

  assert.equal(serverFiles.saveExists(id, 'default'), false);
  assert.equal(repo.getById(id)!.generate_new_save, 1);
});

test('switching game mode drops the tested save (bundled mods generate the map)', async () => {
  const { repo, manager, id } = await testedDraft();

  await manager.updateDraft(id, { gameMode: 'vanilla' });

  assert.equal(serverFiles.saveExists(id, 'default'), false);
  assert.equal(repo.getById(id)!.generate_new_save, 1);
});

test('autosaving unchanged map settings keeps the tested save', async () => {
  const { repo, manager, id } = await testedDraft();

  // What the wizard's debounced autosave sends on every keystroke: the whole form,
  // map settings included, with only the name actually different.
  await manager.updateDraft(id, {
    name: 'Factory One',
    description: 'a base',
    mapGen: { terrain_segmentation: 1 },
  });

  assert.equal(serverFiles.saveExists(id, 'default'), true);
  assert.equal(repo.getById(id)!.generate_new_save, 0);
});

test("a load-from-save draft keeps its upload no matter what's edited", async () => {
  const { repo, manager } = harness();
  const draft = await manager.createDraft({ source: 'save' });
  serverFiles.ensureDirs(draft.id);
  serverFiles.writeSave(draft.id, 'default', Buffer.from('uploaded-save'));

  await manager.updateDraft(draft.id, { source: 'save', gameMode: 'vanilla' });

  assert.equal(serverFiles.saveExists(draft.id, 'default'), true);
  assert.equal(repo.getById(draft.id)!.generate_new_save, 0);
});
