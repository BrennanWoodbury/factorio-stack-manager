import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSaveHeader,
  portalModsFor,
  bundledModsFor,
  gameModeForSave,
  type SaveMod,
} from '../src/services/saveInspect.js';

/**
 * Build a `level-init.dat` header the way Factorio writes one. The byte layout here
 * was derived from real 2.0.77 saves (see the parser's doc comment); `fixedWidth`
 * lets a test simulate a future release changing the fixed block's size.
 */
function buildHeader(
  opts: {
    version?: [number, number, number, number];
    campaign?: string;
    scenario?: string;
    baseMod?: string;
    mods?: SaveMod[];
    fixedWidth?: number;
  } = {},
): Buffer {
  const {
    version = [2, 0, 77, 0],
    campaign = '',
    scenario = 'freeplay',
    baseMod = 'base',
    mods = [{ name: 'base', version: '2.0.77' }],
    fixedWidth = 20,
  } = opts;

  const parts: Buffer[] = [];
  const v = Buffer.alloc(8);
  version.forEach((n, i) => v.writeUInt16LE(n, i * 2));
  parts.push(v);
  parts.push(Buffer.from([0])); // flag

  const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'utf8')]);
  parts.push(str(campaign), str(scenario), str(baseMod));
  parts.push(Buffer.alloc(fixedWidth)); // fixed scenario/difficulty block

  parts.push(Buffer.from([mods.length])); // mod count
  for (const m of mods) {
    parts.push(str(m.name));
    parts.push(Buffer.from(m.version.split('.').map(Number)));
    parts.push(Buffer.alloc(4)); // crc32
  }
  // Trailing map data — the parser must not depend on the header ending here.
  parts.push(Buffer.alloc(64, 0xab));
  return Buffer.concat(parts);
}

test('reads game version, scenario and mods from a header', () => {
  const buf = buildHeader({
    mods: [
      { name: 'base', version: '2.0.77' },
      { name: 'space-age', version: '2.0.77' },
      { name: 'hdrprobe', version: '3.7.11' },
    ],
  });
  const h = parseSaveHeader(buf);
  assert.equal(h.gameVersion, '2.0.77');
  assert.equal(h.scenario, 'freeplay');
  assert.deepEqual(h.mods, [
    { name: 'base', version: '2.0.77' },
    { name: 'space-age', version: '2.0.77' },
    { name: 'hdrprobe', version: '3.7.11' },
  ]);
});

test('a vanilla save reports only base', () => {
  const h = parseSaveHeader(buildHeader());
  assert.deepEqual(h.mods, [{ name: 'base', version: '2.0.77' }]);
  assert.deepEqual(portalModsFor(h), []);
  assert.deepEqual(bundledModsFor(h), []);
});

test('variable-length scenario names do not shift the parse', () => {
  const h = parseSaveHeader(
    buildHeader({
      scenario: 'a-much-longer-scenario-name',
      mods: [
        { name: 'base', version: '2.0.77' },
        { name: 'krastorio2', version: '1.3.24' },
      ],
    }),
  );
  assert.equal(h.scenario, 'a-much-longer-scenario-name');
  assert.deepEqual(
    h.mods.map((m) => m.name),
    ['base', 'krastorio2'],
  );
});

test('recovers when the fixed block changes width (future Factorio release)', () => {
  const h = parseSaveHeader(
    buildHeader({
      fixedWidth: 26,
      mods: [
        { name: 'base', version: '2.1.0' },
        { name: 'somemod', version: '1.0.0' },
      ],
    }),
  );
  assert.deepEqual(
    h.mods.map((m) => m.name),
    ['base', 'somemod'],
  );
});

test('splits bundled expansion mods from portal mods', () => {
  const h = parseSaveHeader(
    buildHeader({
      mods: [
        { name: 'base', version: '2.0.77' },
        { name: 'space-age', version: '2.0.77' },
        { name: 'quality', version: '2.0.77' },
        { name: 'krastorio2', version: '1.3.24' },
        { name: 'aai-industry', version: '0.5.19' },
      ],
    }),
  );
  assert.deepEqual(bundledModsFor(h), ['space-age', 'quality']);
  assert.deepEqual(portalModsFor(h), [
    { name: 'krastorio2', version: '1.3.24' },
    { name: 'aai-industry', version: '0.5.19' },
  ]);
});

test('rejects a buffer that is not a save header', () => {
  assert.throws(() => parseSaveHeader(Buffer.alloc(400, 0x7f)), /could not locate the mod list/);
});

test('rejects a truncated header', () => {
  assert.throws(() => parseSaveHeader(Buffer.alloc(4)), /truncated/);
});

test('the game mode a save should run as names the base its mods sit on', () => {
  // A save owns its mod set, so the mode it adopts must not enforce a bundled set
  // of its own — it only says which base to read the map-gen sliders against.
  const sa = parseSaveHeader(
    buildHeader({
      mods: [
        { name: 'base', version: '2.0.77' },
        { name: 'space-age', version: '2.0.77' },
        { name: 'krastorio2', version: '1.3.24' },
      ],
    }),
  );
  assert.equal(gameModeForSave(sa), 'modded_space_age');

  const vanilla = parseSaveHeader(
    buildHeader({ mods: [{ name: 'base', version: '2.0.77' }, { name: 'krastorio2', version: '1.3.24' }] }),
  );
  assert.equal(gameModeForSave(vanilla), 'modded_vanilla');
  assert.equal(gameModeForSave(parseSaveHeader(buildHeader())), 'modded_vanilla');
});
