import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpdateAvailable } from '../src/jobs/updateCheck.js';

test('isUpdateAvailable', async (t) => {
  await t.test('flags a newer patch/minor/major release', () => {
    assert.equal(isUpdateAvailable('1.0.0', '1.0.1'), true);
    assert.equal(isUpdateAvailable('1.0.0', '1.1.0'), true);
    assert.equal(isUpdateAvailable('1.0.0', '2.0.0'), true);
  });

  await t.test('does not flag an equal or older release', () => {
    assert.equal(isUpdateAvailable('1.2.3', '1.2.3'), false);
    assert.equal(isUpdateAvailable('1.2.3', '1.2.2'), false);
  });

  await t.test('an unstripped leading "v" fails to parse as a number, not as newer', () => {
    // The job always strips "v" from the GitHub tag before storing latestVersion;
    // this just documents what happens if it didn't.
    assert.equal(isUpdateAvailable('1.0.0', 'v1.0.1'), false);
  });

  await t.test('never flags an update for an untagged dev build', () => {
    assert.equal(isUpdateAvailable('dev', '1.0.0'), false);
  });

  await t.test('has nothing to compare when no release has been fetched yet', () => {
    assert.equal(isUpdateAvailable('1.0.0', undefined), false);
  });
});
