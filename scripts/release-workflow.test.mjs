import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const governance = fs.readFileSync(path.join(root, '.github/workflows/governance.yml'), 'utf8');

test('the release coordinator is main-merge driven, serialized, and manually reconcilable', () => {
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: main-release-coordinator/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /release\/v/);
});

test('validation finishes before the first tag or publication mutation', () => {
  const policy = workflow.indexOf('name: Recalculate version policy');
  const approval = workflow.indexOf('name: Require approval or authorized merge bypass');
  const backend = workflow.indexOf('name: Backend regression tests');
  const frontend = workflow.indexOf('name: Frontend regression tests');
  const template = workflow.indexOf('name: Validate Unraid template');
  const tag = workflow.indexOf('name: Create the calculated annotated tag if needed');
  const docker = workflow.indexOf('name: Publish Docker aliases');
  const release = workflow.indexOf('name: Create generated GitHub release notes if needed');
  assert.ok(policy < approval && approval < backend && backend < frontend && frontend < template && template < tag);
  assert.ok(tag < docker && docker < release);
});

test('release approval permits only an authenticated CODEOWNER or admin merge bypass', () => {
  assert.match(workflow, /github\.rest\.pulls\.get/);
  assert.match(workflow, /core\.setOutput\('merged_by', pull\?\.merged_by\?\.login \|\| ''\)/);
  assert.match(workflow, /getCollaboratorPermissionLevel/);
  assert.match(workflow, /authorizedReleaseBypass/);
  assert.match(workflow, /current non-author maintainer approval or a merge by a CODEOWNER\/repository admin/);
});

test('non-release and invalid-policy paths precede every artifact action', () => {
  assert.match(workflow, /if: steps\.policy\.outputs\.release == 'false'/);
  assert.match(workflow, /if: steps\.policy\.outcome == 'failure'/);
  assert.ok(workflow.indexOf('name: Report invalid main state') < workflow.indexOf('name: Create the calculated annotated tag if needed'));
});

test('stale reconciliation publishes only the immutable version alias', () => {
  assert.match(workflow, /stale_reconciliation == 'true'[\s\S]*?tags: type=raw,value=\$\{\{ steps\.policy\.outputs\.version \}\}/);
  assert.match(workflow, /stale_reconciliation != 'true'[\s\S]*?type=raw,value=latest/);
});

test('the named PR checks cover version, regression, template, impact, and governance policy', () => {
  for (const name of ['Version policy', 'Backend — typecheck & tests', 'Frontend — typecheck, tests & build', 'Unraid template — validate', 'User-facing impact']) {
    assert.ok(ci.includes(`name: ${name}`), name);
  }
  assert.match(governance, /name: Current maintainer approval/);
});
