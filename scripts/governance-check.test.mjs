import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  currentApprovers,
  evaluateGovernance,
  parseMaintainers,
  validateCodeowners,
} from './governance-check.mjs';

const maintainersText = `
<!-- maintainers:start -->
- @BrennanWoodbury
- @OccamsChainsaw42
<!-- maintainers:end -->
`;
const codeownersText = `
* @BrennanWoodbury @OccamsChainsaw42
/MAINTAINERS.md @BrennanWoodbury @OccamsChainsaw42
/.github/CODEOWNERS @BrennanWoodbury @OccamsChainsaw42
`;
const trustedMaintainers = parseMaintainers(maintainersText);
const headSha = 'current-head';

test('repository MAINTAINERS and CODEOWNERS files are synchronized', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const roster = parseMaintainers(fs.readFileSync(`${root}MAINTAINERS.md`, 'utf8'));
  assert.doesNotThrow(() =>
    validateCodeowners(fs.readFileSync(`${root}.github/CODEOWNERS`, 'utf8'), roster),
  );
});

const review = (login, state = 'APPROVED', commit = headSha, id = 1) => ({
  id,
  user: { login },
  state,
  commit_id: commit,
  submitted_at: `2026-07-24T00:00:${String(id).padStart(2, '0')}Z`,
});

const evaluate = (overrides = {}) =>
  evaluateGovernance({
    changedFiles: ['MAINTAINERS.md'],
    trustedMaintainers,
    candidateMaintainers: maintainersText,
    candidateCodeowners: codeownersText,
    reviews: [],
    author: 'contributor',
    headSha,
    ...overrides,
  });

test('parses the roster case-insensitively and rejects duplicates', () => {
  const roster = parseMaintainers(maintainersText);
  assert.deepEqual([...roster.keys()], ['brennanwoodbury', 'occamschainsaw42']);
  assert.throws(
    () => parseMaintainers(maintainersText.replace('@OccamsChainsaw42', '@BRENNANWOODBURY')),
    /duplicate maintainer/,
  );
});

test('requires CODEOWNERS and every rule to match the candidate roster', () => {
  assert.doesNotThrow(() => validateCodeowners(codeownersText, trustedMaintainers));
  assert.throws(
    () => validateCodeowners(codeownersText.replace(/ @OccamsChainsaw42/g, ''), trustedMaintainers),
    /does not match/,
  );
  assert.throws(
    () => validateCodeowners(codeownersText.replace('/MAINTAINERS.md', '/README.md'), trustedMaintainers),
    /missing required rule/,
  );
});

test('ordinary pull requests pass without an additional governance approval', () => {
  assert.deepEqual(
    evaluate({ changedFiles: ['README.md'] }),
    { ok: true, governanceChanged: false, description: 'No governance files changed' },
  );
});

test('governance changes need two distinct current-maintainer approvals', () => {
  assert.equal(evaluate().ok, false);
  assert.equal(evaluate({ reviews: [review('BrennanWoodbury')] }).ok, false);
  assert.equal(
    evaluate({ reviews: [review('BrennanWoodbury'), review('OccamsChainsaw42', 'APPROVED', headSha, 2)] }).ok,
    true,
  );
});

test('case-insensitive handles count, while duplicate, stale, and self approvals do not', () => {
  const reviews = [
    review('BRENNANWOODBURY', 'APPROVED', headSha, 1),
    review('brennanwoodbury', 'APPROVED', headSha, 2),
    review('OccamsChainsaw42', 'APPROVED', 'old-head', 3),
    review('contributor', 'APPROVED', headSha, 4),
  ];
  assert.deepEqual(
    currentApprovers({ reviews, trustedMaintainers, author: 'contributor', headSha }),
    ['brennanwoodbury'],
  );
  assert.deepEqual(
    currentApprovers({ reviews, trustedMaintainers, author: 'BRENNANWOODBURY', headSha }),
    [],
  );
});

test("a maintainer's latest dismissed review replaces an earlier approval", () => {
  const reviews = [
    review('BrennanWoodbury', 'APPROVED', headSha, 1),
    review('BrennanWoodbury', 'DISMISSED', headSha, 2),
    review('OccamsChainsaw42', 'APPROVED', headSha, 3),
  ];
  assert.deepEqual(
    currentApprovers({ reviews, trustedMaintainers, author: 'contributor', headSha }),
    ['occamschainsaw42'],
  );
});

test('a push makes prior approvals stale until both maintainers approve the new head', () => {
  const oldReviews = [
    review('BrennanWoodbury', 'APPROVED', 'old-head', 1),
    review('OccamsChainsaw42', 'APPROVED', 'old-head', 2),
  ];
  assert.equal(evaluate({ reviews: oldReviews }).ok, false);
  assert.equal(
    evaluate({ reviews: [...oldReviews, review('BrennanWoodbury', 'APPROVED', headSha, 3)] }).ok,
    false,
  );
  assert.equal(
    evaluate({
      reviews: [
        ...oldReviews,
        review('BrennanWoodbury', 'APPROVED', headSha, 3),
        review('OccamsChainsaw42', 'APPROVED', headSha, 4),
      ],
    }).ok,
    true,
  );
});

test('a candidate maintainer cannot approve their own addition', () => {
  const candidate = maintainersText.replace(
    '<!-- maintainers:end -->',
    '- @NewMaintainer\n<!-- maintainers:end -->',
  );
  const candidateOwners = codeownersText
    .split('\n')
    .map((line) => (line.trim() && !line.startsWith('#') ? `${line} @NewMaintainer` : line))
    .join('\n');
  const result = evaluate({
    candidateMaintainers: candidate,
    candidateCodeowners: candidateOwners,
    reviews: [
      review('BrennanWoodbury'),
      review('NewMaintainer', 'APPROVED', headSha, 2),
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.approvals, ['brennanwoodbury']);
});

test('a candidate roster and CODEOWNERS disagreement blocks the change', () => {
  const result = evaluate({
    candidateCodeowners: codeownersText.replace(/ @OccamsChainsaw42/g, ''),
    reviews: [review('BrennanWoodbury'), review('OccamsChainsaw42', 'APPROVED', headSha, 2)],
  });
  assert.equal(result.ok, false);
  assert.match(result.description, /does not match/);
});
