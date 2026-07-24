import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLine, highestPatch } from '../../scripts/next-version.mjs';
import { isReleasePrepared } from '../../scripts/release-state.mjs';

/**
 * The release number is half human (.version) and half derived (git tags). These
 * cover the derived half, because getting it wrong means either a collision with
 * an existing tag or a version that silently goes backwards.
 */

test('the patch continues the line', () => {
  assert.equal(highestPatch(1, 2, ['v1.2.0', 'v1.2.1', 'v1.2.2']) + 1, 3);
});

test('a line with no tags starts at .0', () => {
  assert.equal(highestPatch(1, 2, []) + 1, 0);
  assert.equal(highestPatch(1, 2, ['v1.1.9', 'v2.0.0']) + 1, 0);
});

test('bumping MINOR restarts the patch with no other bookkeeping', () => {
  const tags = ['v1.0.0', 'v1.0.1', 'v1.0.2'];
  assert.equal(highestPatch(1, 0, tags) + 1, 3);
  assert.equal(highestPatch(1, 1, tags) + 1, 0);
  assert.equal(highestPatch(2, 0, tags) + 1, 0);
});

test('patches are compared numerically, not as strings', () => {
  // The bug this guards: "9" > "10" lexically, which would reissue v1.0.10.
  assert.equal(highestPatch(1, 0, ['v1.0.9', 'v1.0.10']) + 1, 11);
});

test('tags that are not releases on this line are ignored', () => {
  const tags = ['v1.0.0', 'v1.0.1-rc1', 'v1.0.1+build', 'nightly', 'v11.0.0', 'v1.00.2'];
  assert.equal(highestPatch(1, 0, tags) + 1, 1);
});

test('.version is parsed, comments and all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-ver-'));
  try {
    const file = path.join(dir, '.version');
    fs.writeFileSync(file, '# a comment\n# MAJOR=99 in prose must not count\nMAJOR=3\nMINOR=7\n');
    assert.deepEqual(readLine(file), { major: 3, minor: 7 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed .version fails loudly rather than defaulting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-ver-'));
  try {
    const file = path.join(dir, '.version');
    fs.writeFileSync(file, 'MAJOR=1\n');
    assert.throws(() => readLine(file), /MINOR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the repo’s own .version is valid', () => {
  const line = readLine(path.resolve(import.meta.dirname, '../../.version'));
  assert.ok(Number.isInteger(line.major) && line.major >= 0);
  assert.ok(Number.isInteger(line.minor) && line.minor >= 0);
});

test('a release is taggable only when every generated surface agrees', () => {
  const changelog = '## [Unreleased]\n\n## [1.2.3] - 2026-07-24\n\nNotes\n';
  const template = '<Changes>\n### 1.2.3 - 2026-07-24\n\nNotes\n</Changes>';
  const manifests = ['1.2.3', '1.2.3', '1.2.3', '1.2.3', '1.2.3', '1.2.3'];

  assert.equal(isReleasePrepared('1.2.3', manifests, changelog, template), true);
  assert.equal(isReleasePrepared('1.2.3', [...manifests.slice(0, -1), '1.2.2'], changelog, template), false);
  assert.equal(isReleasePrepared('1.2.3', manifests, changelog.replace('1.2.3', '1.2.2'), template), false);
  assert.equal(isReleasePrepared('1.2.3', manifests, changelog, template.replace('1.2.3', '1.2.2')), false);
});
