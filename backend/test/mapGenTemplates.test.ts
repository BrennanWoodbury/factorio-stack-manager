import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { MapGenTemplatesRepo } from '../src/db/mapGenTemplatesRepo.js';
import { ServersRepo } from '../src/db/serversRepo.js';

// The service reaches serverFiles for the built-in defaults, which loads the
// env-backed config at import time. Nothing here reads it.
process.env.ADMIN_PASSWORD ??= 'test-only';
const { MapGenTemplateService } = await import('../src/services/mapGenTemplateService.js');

/**
 * The listing carries each template's settings so a client holding a settings
 * object can tell which template produced it. The editor is handed raw settings
 * with no record of their origin — a resumed wizard draft, or the global default
 * template applied at creation — and without this it can only claim that no
 * template is loaded over settings that plainly came from one.
 */
function service() {
  const db = openDb(':memory:');
  return new MapGenTemplateService(new MapGenTemplatesRepo(db), new ServersRepo(db));
}

test('listed templates carry the settings that identify them', () => {
  const svc = service();
  svc.create({ name: 'Peaceful', settings: { peaceful_mode: true, water: 1 } });
  svc.create({ name: 'Rich resources', settings: { water: 2 } });

  const listed = svc.list();
  const peaceful = listed.find((t) => t.name === 'Peaceful');

  assert.deepEqual(peaceful?.settings, { peaceful_mode: true, water: 1 });
  assert.equal(listed.every((t) => typeof t.settings === 'object'), true);
});

test('listed settings match what fetching the template returns', () => {
  const svc = service();
  const created = svc.create({
    name: 'Islands',
    settings: { water: 6, autoplace_controls: { 'iron-ore': { frequency: 2, size: 1 } } },
  });

  const listed = svc.list().find((t) => t.id === created.id);

  assert.deepEqual(listed?.settings, svc.get(created.id).settings);
});

test('a template with unreadable settings lists as empty rather than breaking the list', () => {
  // parseSettings already tolerates corrupt JSON; the listing must not be the one
  // place that throws, or a single bad row would empty the picker.
  const db = openDb(':memory:');
  const repo = new MapGenTemplatesRepo(db);
  const svc = new MapGenTemplateService(repo, new ServersRepo(db));
  svc.create({ name: 'Good', settings: { water: 1 } });
  db.prepare("UPDATE map_gen_templates SET settings_json = 'not json' WHERE name = 'Good'").run();

  const listed = svc.list();

  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].settings, {});
});
