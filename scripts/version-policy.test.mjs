import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMigrations,
  breakingContracts,
  classifyPath,
  compareVersions,
  evaluatePolicy,
  isRuntimeFileChange,
  latestTag,
  nextVersion,
  parseMajor,
  parseTag,
} from './version-policy.mjs';

const previous = { major: 1, minor: 0, patch: 7, tag: 'v1.0.7' };
const noMigrations = { violations: [], added: [], additive: [], oneWay: [] };

test('SemVer tags sort numerically and malformed tags are excluded', () => {
  const tags = ['v1.0.9', 'v1.0.10', 'v2.0.0-rc.1', 'v01.0.0', 'nightly', 'v1.12.0'];
  assert.equal(latestTag(tags)?.tag, 'v1.12.0');
  assert.equal(parseTag('v1.2.3')?.patch, 3);
  assert.equal(parseTag('1.2.3'), null);
  assert.ok(compareVersions(parseTag('v10.0.0'), parseTag('v2.99.99')) > 0);
});

test('patch, minor, and major calculations reset the right fields', () => {
  assert.equal(nextVersion(previous, 'patch', 1), '1.0.8');
  assert.equal(nextVersion(previous, 'minor', 1), '1.1.0');
  assert.equal(nextVersion(previous, 'major', 2), '2.0.0');
  assert.equal(nextVersion(previous, 'none', 1), null);
});

test('only MAJOR is stored', () => {
  assert.equal(parseMajor('# release line\nMAJOR=3\n'), 3);
  assert.throws(() => parseMajor('MAJOR=3\nMINOR=1\n'), /must not store MINOR/);
  assert.throws(() => parseMajor('MAJOR=2\nMAJOR=3\n'), /exactly one/);
  assert.throws(() => parseMajor('MAJOR=wat\n'), /numeric MAJOR/);
});

test('MAJOR may stay put or increase exactly once', () => {
  const unchanged = evaluatePolicy({ changedFiles: [], baseMajor: 1, declaredMajor: 1, previous, migrations: noMigrations });
  assert.deepEqual(unchanged.violations, []);
  const one = evaluatePolicy({ changedFiles: [], baseMajor: 1, declaredMajor: 2, previous, migrations: noMigrations });
  assert.equal(one.version, '2.0.0');
  assert.deepEqual(one.violations, []);
  assert.match(evaluatePolicy({ changedFiles: [], baseMajor: 2, declaredMajor: 1, previous, migrations: noMigrations }).violations[0], /decreased/);
  assert.match(evaluatePolicy({ changedFiles: [], baseMajor: 1, declaredMajor: 3, previous, migrations: noMigrations }).violations.join(' '), /skipped/);
});

test('concurrent recalculation uses the tag visible after the lock', () => {
  assert.equal(nextVersion({ ...previous, patch: 7 }, 'patch', 1), '1.0.8');
  assert.equal(nextVersion({ ...previous, patch: 8 }, 'patch', 1), '1.0.9');
});

test('runtime path classification is explicit and excludes non-shipping surfaces', () => {
  const cases = new Map([
    ['backend/src/index.ts', 'backend runtime source'],
    ['backend/src/routes/api.js', 'backend runtime source'],
    ['frontend/src/App.tsx', 'frontend runtime source'],
    ['frontend/src/styles.css', 'frontend runtime source'],
    ['frontend/public/favicon.svg', 'production frontend asset'],
    ['frontend/index.html', 'production frontend asset'],
    ['backend/package.json', 'runtime dependency manifest'],
    ['frontend/package-lock.json', 'runtime dependency manifest'],
    ['Dockerfile', 'production image definition'],
    ['docker-compose.yml', 'production Compose configuration'],
    ['templates/factorio-tools-manager.xml', 'Unraid runtime template'],
    ['backend/test/version.test.ts', null],
    ['frontend/src/App.test.tsx', null],
    ['README.md', null],
    ['CHANGELOG.md', null],
    ['.github/workflows/ci.yml', null],
    ['docker-compose.dev.yml', null],
    ['scripts/version-policy.mjs', null],
  ]);
  for (const [file, expected] of cases) assert.equal(classifyPath(file), expected, file);
});

test('release metadata normalization is not mistaken for a runtime change', () => {
  assert.equal(isRuntimeFileChange('backend/package.json', '{"version":"1.2.3","dependencies":{"x":"1"}}', '{"version":"0.0.0","dependencies":{"x":"1"}}'), false);
  assert.equal(isRuntimeFileChange('backend/package.json', '{"version":"0.0.0","dependencies":{"x":"1"}}', '{"version":"0.0.0","dependencies":{"x":"2"}}'), true);
  assert.equal(isRuntimeFileChange('templates/factorio-tools-manager.xml', '<Date>old</Date><Changes>old</Changes>', '<Date>new</Date><Changes>link</Changes>'), false);
});

const migrations = (entries) => `
const MIGRATIONS: Migration[] = [
${entries.map(({ version, flag = true, body = 'db.exec("SELECT 1")' }) => `  {
    version: ${version},
    ${flag === null ? '' : `backwardCompatible: ${flag},`}
    up: (db) => ${body},
  },`).join('\n')}
];`;

test('an additive migration produces a minor release', () => {
  const result = analyzeMigrations(migrations([{ version: 1 }]), migrations([{ version: 1 }, { version: 2 }]), true);
  assert.deepEqual(result.additive, [2]);
  const policy = evaluatePolicy({ changedFiles: ['backend/src/db/migrations.ts'], baseMajor: 1, declaredMajor: 1, previous, migrations: result });
  assert.equal(policy.version, '1.1.0');
  assert.deepEqual(policy.violations, []);
});

test('a one-way migration requires a manual major increase', () => {
  const result = analyzeMigrations(migrations([{ version: 1 }]), migrations([{ version: 1 }, { version: 2, flag: false }]), true);
  const rejected = evaluatePolicy({ changedFiles: [], baseMajor: 1, declaredMajor: 1, previous, migrations: result });
  assert.match(rejected.violations.join(' '), /requires MAJOR=2/);
  const accepted = evaluatePolicy({ changedFiles: [], baseMajor: 1, declaredMajor: 2, previous, migrations: result });
  assert.equal(accepted.version, '2.0.0');
  assert.deepEqual(accepted.violations, []);
});

test('breaking runtime contracts require the next MAJOR', () => {
  const before = {
    config: "opt('OLD_ENV', 'x'); parseRange('GAME_PORT_RANGE', '1-2')",
    template: '<Config Target="OLD_ENV" Default="x"/><Config Name="Appdata" Target="/data" Default="/mnt"/>',
  };
  const after = {
    config: "parseRange('GAME_PORT_RANGE', '3-4')",
    template: '<Config Name="Appdata" Target="/new-data" Default="/mnt"/>',
  };
  const breaking = breakingContracts(before, after);
  assert.match(breaking.join(' '), /removed environment/);
  assert.match(breaking.join(' '), /Unraid Config target/);
  assert.match(breaking.join(' '), /GAME_PORT_RANGE/);
  assert.match(breaking.join(' '), /data mount/);
  const rejected = evaluatePolicy({ changedFiles: ['backend/src/config.ts'], baseMajor: 1, declaredMajor: 1, previous, migrations: noMigrations, breaking });
  assert.equal(rejected.version, '2.0.0');
  assert.match(rejected.violations.join(' '), /requires MAJOR=2/);
});

test('migration metadata, append order, and immutability are enforced', () => {
  const before = migrations([{ version: 1 }]);
  assert.match(analyzeMigrations(before, migrations([{ version: 1 }, { version: 3 }]), true).violations.join(' '), /must append as v2/);
  assert.match(analyzeMigrations(before, migrations([{ version: 1 }, { version: 2, flag: null }]), true).violations.join(' '), /declare backwardCompatible/);
  assert.match(analyzeMigrations(before, migrations([{ version: 1, body: 'db.exec("changed")' }]), false).violations.join(' '), /mutated/);
  assert.match(analyzeMigrations(before, before, true).violations.join(' '), /without an appended migration/);
});

test('runtime, schema, and docs changes map to patch, minor, and no release', () => {
  const firstRelease = { major: 1, minor: 0, patch: 0, tag: 'v1.0.0' };
  const patch = evaluatePolicy({ changedFiles: ['backend/src/index.ts'], baseMajor: 1, declaredMajor: 1, previous: firstRelease, migrations: noMigrations });
  assert.equal(patch.version, '1.0.1');
  const additive = { violations: [], added: [15], additive: [15], oneWay: [] };
  const minor = evaluatePolicy({ changedFiles: ['backend/src/db/migrations.ts'], baseMajor: 1, declaredMajor: 1, previous: { ...firstRelease, patch: 7, tag: 'v1.0.7' }, migrations: additive });
  assert.equal(minor.version, '1.1.0');
  const docs = evaluatePolicy({ changedFiles: ['README.md', '.github/workflows/ci.yml'], baseMajor: 1, declaredMajor: 1, previous: firstRelease, migrations: noMigrations });
  assert.equal(docs.releaseClass, 'none');
  assert.equal(docs.version, null);
});
