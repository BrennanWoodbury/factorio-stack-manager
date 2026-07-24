#!/usr/bin/env node
/**
 * Cut a release: `node scripts/release.mjs`
 *
 * The version is resolved, not typed: MAJOR.MINOR comes from `.version` (human,
 * reviewed in the PR that needed the bump) and PATCH from the existing tags for
 * that line. The script fetches the remote tags before resolving it.
 *
 * This is deliberately a two-pass command so protected main never needs a bypass:
 *   1. On main, it creates release/vX.Y.Z with the release edits and a commit.
 *   2. After that branch is reviewed and merged, run it again on main to tag the
 *      merged commit. Nothing is published until that tag is pushed.
 *
 * It updates:
 *   - both package.json and package-lock.json versions
 *   - CHANGELOG.md: moves [Unreleased] into the new version, dated today
 *   - the Unraid template's <Date> and <Changes> (Community Applications serves
 *     that file straight off main, so it has to describe what users will get)
 *
 * Pass --dry-run to see the edits without writing or committing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLine, highestPatch } from './next-version.mjs';
import { isReleasePrepared } from './release-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(root, 'templates/factorio-tools-manager.xml');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const REPO_URL = 'https://github.com/BrennanWoodbury/factorio-tools-manager';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

const unknownArgs = args.filter((arg) => arg !== '--dry-run');
if (unknownArgs.length > 0) die(`unknown argument(s): ${unknownArgs.join(', ')} — the version is derived, not supplied`);

// Tags decide PATCH, so stale local tags can produce the wrong release number.
// Fetch main at the same time so a real release can prove it starts from the
// exact remote tip rather than a merely clean local branch named main.
try {
  git('fetch', '--tags', '--prune', 'origin', 'main');
} catch {
  die('could not fetch origin/main and release tags');
}

const tags = git('tag', '--list').split('\n').map((t) => t.trim()).filter(Boolean);
const { major, minor } = readLine();
const version = `${major}.${minor}.${highestPatch(major, minor, tags) + 1}`;
console.log(`Releasing v${version} (.version says ${major}.${minor})`);

const today = new Date().toISOString().slice(0, 10);

// ---- CHANGELOG ------------------------------------------------------------
let changelog = fs.readFileSync(CHANGELOG, 'utf8');
const unreleased = changelog.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/);
if (!unreleased) die('could not find an [Unreleased] section in CHANGELOG.md');

const notes = unreleased[1].trim();

const manifestFiles = [
  'backend/package.json',
  'backend/package-lock.json',
  'frontend/package.json',
  'frontend/package-lock.json',
];
const manifestVersions = manifestFiles.flatMap((rel) => {
  const json = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  return rel.endsWith('package-lock.json')
    ? [json.version, json.packages?.['']?.version]
    : [json.version];
});
const templateBefore = fs.readFileSync(TEMPLATE, 'utf8');
const releasePrepared = isReleasePrepared(version, manifestVersions, changelog, templateBefore);

// ---- Preconditions / second pass -----------------------------------------
if (!dryRun && git('status', '--porcelain', '--untracked-files=no')) {
  die('tracked working tree is dirty — commit or stash first');
}

if (releasePrepared) {
  if (dryRun) {
    console.log(`--- would tag the prepared release v${version} ---`);
    process.exit(0);
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    die(`v${version} is prepared; merge its release PR, update main, then run this command again`);
  }
  const head = git('rev-parse', 'HEAD');
  const remoteMain = git('rev-parse', 'origin/main');
  if (head !== remoteMain) die('local main is not exactly origin/main — pull before tagging');
  if (tags.includes(`v${version}`)) die(`tag v${version} already exists`);

  execFileSync('node', [path.join(root, 'scripts/validate-template.mjs')], { stdio: 'inherit' });
  git('tag', '-a', `v${version}`, '-m', `v${version}`);
  console.log(`\n✓ tagged the reviewed main commit as v${version}`);
  console.log(`  Publish it with:  git push origin v${version}`);
  process.exit(0);
}

if (!notes) die('[Unreleased] is empty — describe the release before preparing it');

if (!dryRun) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') die(`release preparation starts from main, currently on "${branch}"`);
  const head = git('rev-parse', 'HEAD');
  const remoteMain = git('rev-parse', 'origin/main');
  if (head !== remoteMain) die('local main is not exactly origin/main — pull before preparing a release');
  if (tags.includes(`v${version}`)) die(`tag v${version} already exists`);

  const releaseBranch = `release/v${version}`;
  try {
    git('show-ref', '--verify', '--quiet', `refs/heads/${releaseBranch}`);
    die(`local branch ${releaseBranch} already exists`);
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  git('switch', '-c', releaseBranch);
}

const previous = changelog.match(/## \[(\d+\.\d+\.\d+)\]/)?.[1];
changelog = changelog.replace(
  /## \[Unreleased\]\s*\n[\s\S]*?(?=\n## \[|\n\[Unreleased\]:)/,
  `## [Unreleased]\n\n## [${version}] - ${today}\n\n${notes}\n`,
);
// Refresh the link definitions at the bottom.
changelog = changelog.replace(
  /\[Unreleased\]: .*/,
  `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`,
);
if (!changelog.includes(`[${version}]: `)) {
  const link = previous
    ? `[${version}]: ${REPO_URL}/compare/v${previous}...v${version}`
    : `[${version}]: ${REPO_URL}/releases/tag/v${version}`;
  changelog = changelog.replace(/(\[Unreleased\]: .*\n)/, `$1${link}\n`);
}

// ---- package manifests ----------------------------------------------------
const pkgEdits = ['backend/package.json', 'frontend/package.json'].map((rel) => {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  return [rel, file, `${JSON.stringify(json, null, 2)}\n`];
});
const lockEdits = ['backend/package-lock.json', 'frontend/package-lock.json'].map((rel) => {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  if (!json.packages?.['']) die(`${rel} has no root package entry`);
  json.packages[''].version = version;
  return [rel, file, `${JSON.stringify(json, null, 2)}\n`];
});
const manifestEdits = [...pkgEdits, ...lockEdits];

// ---- Unraid template ------------------------------------------------------
let template = templateBefore;
template = template.replace(/<Date>[^<]*<\/Date>/, `<Date>${today}</Date>`);
// <Changes> is rendered by CA as the "what's new" for the listing.
const changesBody = [`### ${version} - ${today}`, '', notes].join('\n');
if (!/<Changes>[\s\S]*?<\/Changes>/.test(template)) die('template has no <Changes> block');
template = template.replace(
  /<Changes>[\s\S]*?<\/Changes>/,
  `<Changes>\n${changesBody}\n  </Changes>`,
);

// ---- Apply ----------------------------------------------------------------
if (dryRun) {
  console.log(`--- would release v${version} (${today}) ---\n`);
  console.log(notes);
  console.log(`\n--- files: CHANGELOG.md, templates/…xml, ${manifestEdits.length} package manifests ---`);
  process.exit(0);
}

fs.writeFileSync(CHANGELOG, changelog);
fs.writeFileSync(TEMPLATE, template);
for (const [, file, body] of manifestEdits) fs.writeFileSync(file, body);

execFileSync('node', [path.join(root, 'scripts/validate-template.mjs')], { stdio: 'inherit' });

git('add', 'CHANGELOG.md', 'templates/factorio-tools-manager.xml', ...manifestEdits.map(([rel]) => rel));
git('commit', '-m', `chore(release): v${version}`);

console.log(`\n✓ prepared v${version} on release/v${version}`);
console.log(`  Push the branch and open a PR:  git push -u origin release/v${version}`);
console.log('  After it merges, update main and run this command again to create the tag.');
