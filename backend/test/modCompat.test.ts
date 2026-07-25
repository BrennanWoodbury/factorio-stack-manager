import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  satisfiesConstraint,
  gameSeries,
  installedFromInfo,
  validateModSet,
  describeProblems,
  type InstalledMod,
  type ModListEntry,
} from '../src/services/modCompat.js';
import { parseDependencies, type ImageProfile } from '../src/services/imageProfile.js';

/**
 * Every fatal case here was confirmed by running factoriotools/factorio:stable
 * (2.0.77) with a bad mod: the container exits(1) about 7ms into startup and the
 * restart policy loops it forever. Factorio's own wording, which these tests pin:
 *
 *   Failed to load mod "testmod": Incompatible Factorio version (current: 2.0, required: 1.1)
 *   Failed to load mod "testmod": Missing required dependency flib >= 0.14.0
 *   Failed to load mod "testmod": Dependency depmod >= 2.0.0 is not satisfied (active: depmod 1.0.0)
 */

function profile(gameVersion: string, bundled: string[] = ['base']): ImageProfile {
  return {
    imageId: 'sha256:test',
    gameVersion,
    mods: new Map(bundled.map((name) => [name, { name, version: gameVersion, requires: [] }])),
    derived: true,
  };
}

function mod(name: string, over: Partial<InstalledMod> = {}): InstalledMod {
  return { name, version: '1.0.0', factorioVersion: '2.0', dependencies: [], ...over };
}

function withDeps(name: string, deps: string[], factorioVersion = '2.0'): InstalledMod {
  return { name, version: '1.0.0', factorioVersion, dependencies: parseDependencies(deps) };
}

const on = (...names: string[]): ModListEntry[] => names.map((name) => ({ name, enabled: true }));

test('a mod built for another Factorio series is rejected, in the game\'s own words', () => {
  const problems = validateModSet(on('base', 'oldmod'), [mod('oldmod', { factorioVersion: '1.1' })], profile('2.0.77'));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'game-version');
  assert.match(problems[0].detail, /Incompatible Factorio version \(current: 2\.0, required: 1\.1\)/);
});

test('the series is the major.minor, so patch releases never matter', () => {
  assert.equal(gameSeries('2.0.77'), '2.0');
  assert.equal(gameSeries('2.1.12'), '2.1');
  assert.equal(gameSeries('unknown'), '');
  // A 2.0 mod on any 2.0.x image is fine.
  assert.deepEqual(validateModSet(on('base', 'm'), [mod('m')], profile('2.0.12')), []);
});

test('a missing hard dependency is reported with its constraint', () => {
  const problems = validateModSet(
    on('base', 'needsflib'),
    [withDeps('needsflib', ['base', 'flib >= 0.14.0'])],
    profile('2.0.77'),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'missing-dependency');
  assert.match(problems[0].detail, /Missing required dependency flib >= 0\.14\.0/);
});

test('a dependency that is installed but switched off is its own problem', () => {
  const list: ModListEntry[] = [
    { name: 'base', enabled: true },
    { name: 'needsflib', enabled: true },
    { name: 'flib', enabled: false },
  ];
  const problems = validateModSet(list, [withDeps('needsflib', ['flib']), mod('flib')], profile('2.0.77'));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'disabled-dependency');
});

test('optional and incompatible prefixes are not requirements', () => {
  const problems = validateModSet(
    on('base', 'm'),
    [withDeps('m', ['? nice-to-have', '(?) hidden', '+ default-on', '! nemesis'])],
    profile('2.0.77'),
  );
  assert.deepEqual(problems, [], 'nothing optional is required, and an absent conflict is fine');
});

test('an enabled incompatible mod is a conflict', () => {
  const problems = validateModSet(
    on('base', 'm', 'nemesis'),
    [withDeps('m', ['! nemesis']), mod('nemesis')],
    profile('2.0.77'),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'conflict');
  assert.match(problems[0].detail, /nemesis/);
});

test('mods that ship in the image satisfy dependencies and are never checked', () => {
  const p = profile('2.0.77', ['base', 'space-age', 'quality']);
  const problems = validateModSet(
    on('base', 'space-age', 'm'),
    [withDeps('m', ['base >= 2.0.0', 'space-age'])],
    p,
  );
  assert.deepEqual(problems, [], 'bundled mods count as present and enabled');
});

test('a bundled mod absent from mod-list.json still counts as enabled', () => {
  // The game enables its own mods by default, so their absence from the list is
  // not the user disabling them — reporting it would be a false alarm on every server.
  const p = profile('2.0.77', ['base', 'quality']);
  const problems = validateModSet(on('m'), [withDeps('m', ['quality'])], p);
  assert.deepEqual(problems, []);
});

test('an enabled mod with no zip downloaded is reported', () => {
  const problems = validateModSet(on('base', 'ghost'), [], profile('2.0.77'));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'not-installed');
});

test('disabled mods are ignored entirely, however broken they are', () => {
  const list: ModListEntry[] = [
    { name: 'base', enabled: true },
    { name: 'broken', enabled: false },
  ];
  const installed = [withDeps('broken', ['nonexistent'], '0.16')];
  assert.deepEqual(validateModSet(list, installed, profile('2.0.77')), []);
});

test("an unsatisfied version constraint is reported in the game's own words", () => {
  // Verified fatal on 2.0.77, phrased by Factorio as:
  //   Dependency depmod >= 2.0.0 is not satisfied (active: depmod 1.0.0)
  const problems = validateModSet(
    on('base', 'm', 'flib'),
    [withDeps('m', ['flib >= 0.14.0']), mod('flib', { version: '0.1.0' })],
    profile('2.0.77'),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'dependency-version');
  assert.equal(
    problems[0].detail,
    'Dependency flib >= 0.14.0 is not satisfied (active: flib 0.1.0).',
  );
});

test('a satisfied constraint is silent, at the boundary included', () => {
  const set = (flibVersion: string) =>
    validateModSet(
      on('base', 'm', 'flib'),
      [withDeps('m', ['flib >= 0.14.0']), mod('flib', { version: flibVersion })],
      profile('2.0.77'),
    );
  assert.deepEqual(set('0.14.0'), [], '>= includes the named version');
  assert.deepEqual(set('0.14'), [], 'a missing component counts as zero');
  assert.deepEqual(set('1.0.0'), []);
  assert.equal(set('0.13.9').length, 1);
});

test('every comparator the game allows is honoured', () => {
  assert.ok(satisfiesConstraint('1.2.3', '>= 1.2.3'));
  assert.ok(!satisfiesConstraint('1.2.3', '> 1.2.3'));
  assert.ok(satisfiesConstraint('1.2.3', '= 1.2.3'));
  assert.ok(!satisfiesConstraint('1.2.4', '= 1.2.3'));
  assert.ok(satisfiesConstraint('1.2.3', '<= 1.2.3'));
  assert.ok(!satisfiesConstraint('1.2.3', '< 1.2.3'));
  assert.ok(satisfiesConstraint('1.2.2', '< 1.2.3'));
});

test('versions compare component-wise, not as text', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1, '10 is newer than 9');
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.77', '2.1.0'), -1);
  assert.equal(compareVersions('2.1.0', '2.0.77'), 1);
  assert.ok(satisfiesConstraint('0.10.0', '>= 0.9.0'), 'the classic string-compare trap');
});

test('a constraint we cannot parse is treated as satisfied', () => {
  // Blocking a start over a manifest we simply did not understand is worse than
  // missing one the game would have rejected.
  assert.ok(satisfiesConstraint('1.0.0', 'sometime after 2.0'));
  assert.ok(satisfiesConstraint('1.0.0', ''));
  assert.ok(satisfiesConstraint('1.0.0', undefined));
});

test('constraints on mods bundled in the image are checked against the image', () => {
  const p = profile('2.1.12', ['base']);
  const tooNew = validateModSet(on('base', 'm'), [withDeps('m', ['base >= 2.2.0'], '2.1')], p);
  assert.equal(tooNew.length, 1);
  assert.equal(tooNew[0].kind, 'dependency-version');
  assert.match(tooNew[0].detail, /active: base 2\.1\.12/);

  assert.deepEqual(
    validateModSet(on('base', 'm'), [withDeps('m', ['base >= 2.0.0'], '2.1')], p),
    [],
  );
});

test('a constraint on a missing mod stays a missing dependency, not a version problem', () => {
  const problems = validateModSet(on('base', 'm'), [withDeps('m', ['flib >= 0.14.0'])], profile('2.0.77'));
  assert.deepEqual(
    problems.map((p) => p.kind),
    ['missing-dependency'],
  );
});

test('an unknown game version disables the series check but not the rest', () => {
  const problems = validateModSet(
    on('base', 'm'),
    [withDeps('m', ['missing-dep'], '1.1')],
    profile('unknown'),
  );
  assert.deepEqual(
    problems.map((p) => p.kind),
    ['missing-dependency'],
  );
});

test('manifests are read leniently, and a mod with no declared version is allowed', () => {
  assert.equal(installedFromInfo({ name: 'm' }), undefined, 'no version is not a mod');
  assert.equal(installedFromInfo(null), undefined);
  const parsed = installedFromInfo({
    name: 'm',
    version: '1.0.0',
    factorio_version: '2.0',
    dependencies: ['base', '? opt'],
  });
  assert.equal(parsed?.factorioVersion, '2.0');
  assert.equal(parsed?.dependencies.length, 2);

  const noVersion = installedFromInfo({ name: 'm', version: '1.0.0' });
  assert.equal(noVersion?.factorioVersion, undefined);
  assert.deepEqual(validateModSet(on('base', 'm'), [noVersion!], profile('2.0.77')), []);
});

test('the refusal message names every mod and reason', () => {
  const text = describeProblems([
    { kind: 'game-version', mod: 'a', detail: 'Incompatible Factorio version.' },
    { kind: 'missing-dependency', mod: 'b', detail: 'Missing required dependency flib.' },
  ]);
  assert.match(text, /a: Incompatible/);
  assert.match(text, /b: Missing required dependency flib/);
  assert.match(text, /keep restarting/);
});
