#!/usr/bin/env node

import fs from 'node:fs';

export const GOVERNANCE_PATHS = new Set(['MAINTAINERS.md', '.github/CODEOWNERS']);
const REQUIRED_CODEOWNER_PATTERNS = ['*', '/MAINTAINERS.md', '/.github/CODEOWNERS'];

const canonical = (handle) => handle.toLowerCase();

const sameSet = (left, right) =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** Parse the deliberately small, machine-readable roster in MAINTAINERS.md. */
export function parseMaintainers(source) {
  const start = '<!-- maintainers:start -->';
  const end = '<!-- maintainers:end -->';
  const starts = source.split(start).length - 1;
  const ends = source.split(end).length - 1;
  if (starts !== 1 || ends !== 1 || source.indexOf(start) > source.indexOf(end)) {
    throw new Error('MAINTAINERS.md must contain exactly one ordered maintainer roster block');
  }

  const block = source.slice(source.indexOf(start) + start.length, source.indexOf(end));
  const maintainers = new Map();
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*-\s+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s*$/);
    if (!match) {
      throw new Error(`invalid maintainer roster entry: ${line.trim()}`);
    }
    const key = canonical(match[1]);
    if (maintainers.has(key)) throw new Error(`duplicate maintainer: @${match[1]}`);
    maintainers.set(key, match[1]);
  }

  if (maintainers.size < 2) {
    throw new Error('the active roster must contain at least two distinct maintainers');
  }
  return maintainers;
}

/** Validate that every CODEOWNERS rule names exactly the active maintainer roster. */
export function validateCodeowners(source, maintainers) {
  const patterns = new Set();
  let rules = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) throw new Error(`CODEOWNERS rule has no owners: ${fields[0]}`);

    const owners = new Set();
    for (const owner of fields.slice(1)) {
      const match = owner.match(/^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/);
      if (!match) throw new Error(`CODEOWNERS must use individual GitHub handles: ${owner}`);
      const key = canonical(match[1]);
      if (owners.has(key)) throw new Error(`duplicate owner ${owner} on rule ${fields[0]}`);
      owners.add(key);
    }

    if (!sameSet(owners, new Set(maintainers.keys()))) {
      throw new Error(`CODEOWNERS rule ${fields[0]} does not match the active maintainer roster`);
    }
    patterns.add(fields[0]);
    rules += 1;
  }

  if (rules === 0) throw new Error('CODEOWNERS contains no ownership rules');
  for (const pattern of REQUIRED_CODEOWNER_PATTERNS) {
    if (!patterns.has(pattern)) throw new Error(`CODEOWNERS is missing required rule: ${pattern}`);
  }
}

const reviewOrder = (review) => {
  const timestamp = Date.parse(review.submitted_at ?? review.submittedAt ?? '') || 0;
  return [timestamp, Number(review.id) || 0];
};

const isLater = (candidate, current) => {
  const a = reviewOrder(candidate);
  const b = reviewOrder(current);
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
};

/** Return distinct trusted maintainers whose latest review approves the current head. */
export function currentApprovers({ reviews, trustedMaintainers, author, headSha }) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    const key = canonical(login);
    if (!trustedMaintainers.has(key) || key === canonical(author)) continue;
    const prior = latest.get(key);
    if (!prior || isLater(review, prior)) latest.set(key, review);
  }

  return [...latest.entries()]
    .filter(([, review]) =>
      review.state?.toUpperCase() === 'APPROVED' && review.commit_id === headSha,
    )
    .map(([login]) => login)
    .sort();
}

/** Allow an explicit post-merge release bypass only for a CODEOWNER or repository admin. */
export function authorizedReleaseBypass({ actor, trustedMaintainers, repositoryPermission }) {
  if (!actor) return { authorized: false };
  const login = canonical(actor);
  if (trustedMaintainers.has(login)) {
    // Governance validation keeps the active maintainer roster synchronized with every
    // CODEOWNERS rule, so an active maintainer is a CODEOWNER for all repository paths.
    return { authorized: true, reason: 'CODEOWNER' };
  }
  if (repositoryPermission?.toLowerCase() === 'admin') {
    return { authorized: true, reason: 'repository admin' };
  }
  return { authorized: false };
}

export function evaluateGovernance({
  changedFiles,
  trustedMaintainers,
  candidateMaintainers,
  candidateCodeowners,
  reviews,
  author,
  headSha,
}) {
  const governanceChanged = changedFiles.some((file) => GOVERNANCE_PATHS.has(file));
  if (!governanceChanged) {
    return { ok: true, governanceChanged: false, description: 'No governance files changed' };
  }

  try {
    const candidateRoster = parseMaintainers(candidateMaintainers);
    validateCodeowners(candidateCodeowners, candidateRoster);
  } catch (error) {
    return {
      ok: false,
      governanceChanged: true,
      description: error instanceof Error ? error.message : String(error),
    };
  }

  const approvals = currentApprovers({ reviews, trustedMaintainers, author, headSha });
  if (approvals.length < 2) {
    return {
      ok: false,
      governanceChanged: true,
      approvals,
      description: `Governance change has ${approvals.length}/2 current-maintainer approvals`,
    };
  }
  return {
    ok: true,
    governanceChanged: true,
    approvals,
    description: 'Governance rosters match and 2 current maintainers approved',
  };
}

const decodeContent = (response, path) => {
  const data = response.data;
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
    throw new Error(`${path} is not a readable file in the candidate commit`);
  }
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
};

export async function checkPullRequest({ github, context, core }) {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error('governance check requires a pull request event');

  const baseMaintainers = fs.readFileSync('MAINTAINERS.md', 'utf8');
  const baseCodeowners = fs.readFileSync('.github/CODEOWNERS', 'utf8');
  const trustedMaintainers = parseMaintainers(baseMaintainers);
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pull.number;
  const headOwner = pull.head.repo?.owner?.login;
  const headRepo = pull.head.repo?.name;
  if (!headOwner || !headRepo) throw new Error('pull request head repository is unavailable');

  // Read both protected files directly at the immutable PR head. Comparing their content to the
  // checked-out base avoids the GitHub list-files API's 3,000-file ceiling becoming an evasion.
  const readCandidate = async (path) => {
    try {
      return decodeContent(
        await github.rest.repos.getContent({
          owner: headOwner,
          repo: headRepo,
          path,
          ref: pull.head.sha,
        }),
        path,
      );
    } catch (error) {
      if (error?.status === 404) throw new Error(`${path} must exist in the candidate commit`);
      throw error;
    }
  };
  const [reviews, candidateMaintainers, candidateCodeowners] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber }),
    readCandidate('MAINTAINERS.md'),
    readCandidate('.github/CODEOWNERS'),
  ]);
  const changedFiles = [];
  if (candidateMaintainers !== baseMaintainers) changedFiles.push('MAINTAINERS.md');
  if (candidateCodeowners !== baseCodeowners) changedFiles.push('.github/CODEOWNERS');

  const result = evaluateGovernance({
    changedFiles,
    trustedMaintainers,
    candidateMaintainers,
    candidateCodeowners,
    reviews,
    author: pull.user.login,
    headSha: pull.head.sha,
  });

  core.info(result.description);
  if (result.approvals) core.info(`Counted approvals: ${result.approvals.join(', ') || '(none)'}`);
  return result;
}
