import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { effectsFor, scanLuaSource, scanModZip } from '../src/services/mapGenScan.js';

/**
 * A preview renders the data stage, so a mod that rewrites the world from control.lua
 * is invisible to it no matter how faithfully the mods are loaded. These cover the
 * detection that turns that into a warning instead of a silently wrong picture.
 */

test('a mod that rewrites chunks at runtime is detected', () => {
  const hits = scanLuaSource('script.on_event(defines.events.on_chunk_generated, place_ore)');
  assert.deepEqual(hits, ['on_chunk_generated']);
  assert.deepEqual(effectsFor(hits), ['rewrites chunks as they generate']);
});

test('a prototype-only mod is not flagged', () => {
  // Data-stage terrain work is exactly what a preview *does* show.
  const source = 'data.raw.tile["grass-1"].autoplace = { probability_expression = "x" }';
  assert.deepEqual(scanLuaSource(source), []);
});

test('markers are matched as whole words, not substrings', () => {
  // `offset_tiles`/`recreate_surface` are ordinary names and must not trip the scan.
  assert.deepEqual(scanLuaSource('local t = helpers.offset_tiles(x)'), []);
  assert.deepEqual(scanLuaSource('function M.recreate_surfaces() end'), []);
  // The real call still matches when it appears as a method.
  assert.deepEqual(scanLuaSource('surface.set_tiles(tiles)'), ['set_tiles']);
});

test('several runtime behaviours are reported together, in a stable order', () => {
  const hits = scanLuaSource('game.create_surface(name) surface.set_tiles(t) on_chunk_generated');
  assert.deepEqual(hits, ['on_chunk_generated', 'create_surface', 'set_tiles']);
});

test('every lua file in a zip is scanned, not just control.lua', () => {
  // Mods split logic across scripts/; stopping at the entry point would miss most.
  const zip = new AdmZip();
  zip.addFile('rso_6.2.6/control.lua', Buffer.from('require("scripts.gen")'));
  zip.addFile('rso_6.2.6/scripts/gen.lua', Buffer.from('on_chunk_generated'));
  assert.deepEqual(scanModZip(zip.toBuffer()), ['on_chunk_generated']);
});

test('non-lua entries are ignored', () => {
  const zip = new AdmZip();
  zip.addFile('m_1.0.0/info.json', Buffer.from('{"name":"m","description":"on_chunk_generated"}'));
  zip.addFile('m_1.0.0/locale/en/m.cfg', Buffer.from('desc=uses create_surface'));
  assert.deepEqual(scanModZip(zip.toBuffer()), []);
});
