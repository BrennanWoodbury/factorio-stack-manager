import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModInfo,
  parseDependency,
  parseDependencies,
  hardDependencies,
  dependencyClosure,
  modEnablementFor,
  gameModeIssue,
  fallbackProfile,
  atLeast,
  INFO_SEPARATOR,
  type ImageProfile,
} from '../src/services/imageProfile.js';

/**
 * Verbatim `info.json` payloads from the real images, so these tests pin the
 * behaviour to what Factorio actually ships rather than to our reading of it.
 * 2.0 makes `quality` a hard dependency of `space-age`; 2.1 relaxes it to `+`
 * and splits out `recycler`, which both then hard-require.
 */
const IMAGE_2_0 = [
  '{"name":"base","version":"2.0.77","dependencies":[]}',
  '{"name":"core"}',
  '{"name":"elevated-rails","version":"2.0.77","dependencies":["base >= 2.0.0"]}',
  '{"name":"quality","version":"2.0.77","dependencies":["base >= 2.0.0"]}',
  '{"name":"space-age","version":"2.0.77","dependencies":["base >= 2.0.0","elevated-rails >= 2.0.0","quality >= 2.0.0"]}',
];

const IMAGE_2_1 = [
  '{"name":"base","version":"2.1.12","dependencies":[]}',
  '{"name":"core"}',
  '{"name":"elevated-rails","version":"2.1.12","dependencies":["base >= 2.1.0"]}',
  '{"name":"quality","version":"2.1.12","dependencies":["base >= 2.1.0","recycler >= 2.1.0"]}',
  '{"name":"recycler","version":"2.1.12","dependencies":["base >= 2.1.0"]}',
  '{"name":"space-age","version":"2.1.12","dependencies":["base >= 2.1.0","elevated-rails >= 2.1.0","+ quality >= 2.1.0","recycler >= 2.1.0"]}',
];

/** Reproduce the introspection script's output format. */
const asOutput = (chunks: string[]) => chunks.map((c) => `${c}\n${INFO_SEPARATOR}\n`).join('');

function profileOf(chunks: string[], gameVersion: string): ImageProfile {
  const mods = parseModInfo(asOutput(chunks));
  return { imageId: 'sha256:test', gameVersion, mods: new Map(mods.map((m) => [m.name, m])), derived: true };
}

const P20 = () => profileOf(IMAGE_2_0, '2.0.77');
const P21 = () => profileOf(IMAGE_2_1, '2.1.12');

test('parses the mod manifests and drops core', () => {
  const mods = parseModInfo(asOutput(IMAGE_2_1));
  assert.deepEqual(
    mods.map((m) => m.name).sort(),
    ['base', 'elevated-rails', 'quality', 'recycler', 'space-age'],
  );
  assert.equal(mods.find((m) => m.name === 'base')?.version, '2.1.12');
});

test('ignores chunks that are not complete manifests', () => {
  const mods = parseModInfo(`{"name":"base","version":"1"}\n${INFO_SEPARATOR}\n{"name":"trunc`);
  assert.deepEqual(mods.map((m) => m.name), ['base']);
});

test('optional dependency prefixes are not requirements', () => {
  assert.deepEqual(hardDependencies(['base >= 2.1.0', '+ quality >= 2.1.0']), ['base']);
  assert.deepEqual(hardDependencies(['? foo', '(?) bar', '! baz', '~ qux >= 1.0']), ['qux']);
  assert.deepEqual(hardDependencies(undefined), []);
});

test('every dependency prefix maps to a kind, and the constraint survives', () => {
  const parsed = parseDependencies([
    'base >= 2.1.0',
    '~ postprocess >= 0.7.5',
    '+ quality',
    '? optional-thing >= 1.2.3',
    '(?) hidden-thing',
    '! conflicting-thing',
    'core',
    42,
  ]);
  assert.deepEqual(
    parsed.map((d) => [d.name, d.kind, d.constraint]),
    [
      ['base', 'required', '>= 2.1.0'],
      ['postprocess', 'required', '>= 0.7.5'],
      ['quality', 'optional', undefined],
      ['optional-thing', 'optional', '>= 1.2.3'],
      ['hidden-thing', 'optional', undefined],
      ['conflicting-thing', 'incompatible', undefined],
    ],
    'core and non-strings are dropped',
  );
  assert.equal(parsed.find((d) => d.name === 'quality')?.defaultEnabled, true);
  assert.equal(parsed.find((d) => d.name === 'hidden-thing')?.hidden, true);
  assert.equal(parseDependency('  spaced-name  <= 3.0 ')?.constraint, '<= 3.0');
  assert.equal(parseDependency(''), undefined);
});

test('2.0: quality comes back through the closure, so no-quality is impossible', () => {
  const p = P20();
  assert.ok(dependencyClosure(['space-age'], p).has('quality'));
  const issue = gameModeIssue('space_age_no_quality', p);
  assert.match(issue ?? '', /2\.1 or newer/);
  assert.match(issue ?? '', /2\.0\.77/);
});

test('2.1: no-quality is supported, and recycler is pulled in automatically', () => {
  const p = P21();
  assert.equal(gameModeIssue('space_age_no_quality', p), null);
  assert.deepEqual(modEnablementFor('space_age_no_quality', p), {
    'elevated-rails': true,
    quality: false,
    recycler: true,
    'space-age': true,
  });
});

test('2.1: plain Space Age enables recycler without it being named anywhere', () => {
  assert.deepEqual(modEnablementFor('space_age', P21()), {
    'elevated-rails': true,
    quality: true,
    recycler: true,
    'space-age': true,
  });
});

test('2.0: Space Age enablement matches the pre-existing behaviour', () => {
  assert.deepEqual(modEnablementFor('space_age', P20()), {
    'elevated-rails': true,
    quality: true,
    'space-age': true,
  });
});

test('vanilla disables every bundled mod on both versions', () => {
  assert.deepEqual(modEnablementFor('vanilla', P20()), {
    'elevated-rails': false,
    quality: false,
    'space-age': false,
  });
  assert.deepEqual(modEnablementFor('vanilla', P21()), {
    'elevated-rails': false,
    quality: false,
    recycler: false,
    'space-age': false,
  });
});

test('modded leaves the mod list alone', () => {
  assert.equal(modEnablementFor('modded', P21()), null);
  assert.equal(gameModeIssue('modded', P21()), null);
});

test('an unknown mode is treated as Space Age', () => {
  assert.deepEqual(modEnablementFor('nonsense', P21()), modEnablementFor('space_age', P21()));
});

test('a future release that splits out another mod needs no code change', () => {
  // Hypothetical 2.2 where space-age also requires a new bundled "fluids" mod.
  const p = profileOf(
    [
      '{"name":"base","version":"2.2.0","dependencies":[]}',
      '{"name":"fluids","version":"2.2.0","dependencies":["base >= 2.2.0"]}',
      '{"name":"space-age","version":"2.2.0","dependencies":["base >= 2.2.0","fluids >= 2.2.0"]}',
    ],
    '2.2.0',
  );
  assert.deepEqual(modEnablementFor('space_age', p), { fluids: true, 'space-age': true });
});

test('the fallback profile encodes the same version split', () => {
  assert.ok(gameModeIssue('space_age_no_quality', fallbackProfile('id', '2.0.77')));
  assert.equal(gameModeIssue('space_age_no_quality', fallbackProfile('id', '2.1.12')), null);
  assert.equal(modEnablementFor('space_age', fallbackProfile('id', '2.1.12'))?.recycler, true);
});

test('version comparison handles the 2.0/2.1 boundary', () => {
  assert.equal(atLeast('2.0.77', 2, 1), false);
  assert.equal(atLeast('2.1.0', 2, 1), true);
  assert.equal(atLeast('2.1.12', 2, 1), true);
  assert.equal(atLeast('3.0.0', 2, 1), true);
  assert.equal(atLeast('unknown', 2, 1), false);
});
