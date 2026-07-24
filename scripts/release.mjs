#!/usr/bin/env node
/**
 * Cut a release: `node scripts/release.mjs`
 *
 * The version is resolved, not typed: MAJOR.MINOR comes from `.version` (human,
 * reviewed in the PR that needed the bump) and PATCH from the existing tags for
 * that line. Pass an explicit version only to override.
 *
 * Everything a release touches lives in the repository, so this does the edits and
 * leaves you with a commit and a tag to push. Nothing is published until the tag
 * lands — that is what keeps merging to main from reaching users.
 *
 * It updates:
 *   - both package.json versions
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(root, 'templates/factorio-tools-manager.xml');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const REPO_URL = 'https://github.com/BrennanWoodbury/factorio-tools-manager';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const override = args.find((a) => !a.startsWith('--'));

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

const tags = git('tag', '--list').split('\n').map((t) => t.trim()).filter(Boolean);
const { major, minor } = readLine();
const version = override ?? `${major}.${minor}.${highestPatch(major, minor, tags) + 1}`;
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`version must be MAJOR.MINOR.PATCH, got "${version}"`);
console.log(`Releasing v${version}${override ? ' (overridden)' : ` (.version says ${major}.${minor})`}`);

// ---- Preconditions --------------------------------------------------------
if (!dryRun) {
  if (git('status', '--porcelain')) die('working tree is dirty — commit or stash first');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') die(`releases are cut from main, currently on "${branch}"`);
  if (tags.includes(`v${version}`)) die(`tag v${version} already exists`);
}

const today = new Date().toISOString().slice(0, 10);

// ---- CHANGELOG ------------------------------------------------------------
let changelog = fs.readFileSync(CHANGELOG, 'utf8');
const unreleased = changelog.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/);
if (!unreleased) die('could not find an [Unreleased] section in CHANGELOG.md');

const notes = unreleased[1].trim();
if (!notes) die('[Unreleased] is empty — describe the release before tagging it');

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

// ---- package.json ---------------------------------------------------------
const pkgEdits = ['backend/package.json', 'frontend/package.json'].map((rel) => {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  return [file, `${JSON.stringify(json, null, 2)}\n`];
});

// ---- Unraid template ------------------------------------------------------
let template = fs.readFileSync(TEMPLATE, 'utf8');
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
  console.log(`\n--- files: CHANGELOG.md, templates/…xml, ${pkgEdits.length} package.json ---`);
  process.exit(0);
}

fs.writeFileSync(CHANGELOG, changelog);
fs.writeFileSync(TEMPLATE, template);
for (const [file, body] of pkgEdits) fs.writeFileSync(file, body);

execFileSync('node', [path.join(root, 'scripts/validate-template.mjs')], { stdio: 'inherit' });

git('add', 'CHANGELOG.md', 'templates/factorio-tools-manager.xml', 'backend/package.json', 'frontend/package.json');
git('commit', '-m', `chore(release): v${version}`);
git('tag', '-a', `v${version}`, '-m', `v${version}`);

console.log(`\n✓ committed and tagged v${version}`);
console.log('  Review, then publish with:  git push --follow-tags origin main');
