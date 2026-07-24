#!/usr/bin/env node
/**
 * Classify a change against the surfaces users depend on, and require the version
 * line and the docs to keep up.
 *
 * The point is not to detect "risky-looking files". A file-level trigger would
 * fire on 13 of this repo's 14 migrations, every one of which was a harmless ADD
 * COLUMN — and a rule that cries wolf that often gets routed around. So each
 * check below reads what actually changed and asks whether a *user* would have to
 * do something about it.
 *
 * Usage: node scripts/impact-check.mjs [baseRef]   (default: origin/main)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'origin/main';

/** A file's contents at `ref`, or null if it didn't exist there (a normal case). */
const at = (ref, rel) => {
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // a missing path is expected, not an error
    });
  } catch {
    return null;
  }
};
const now = (rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/** findings: { level: 'major' | 'minor', what, why } */
const findings = [];
const major = (what, why) => findings.push({ level: 'major', what, why });
const minor = (what, why) => findings.push({ level: 'minor', what, why });

// ---------------------------------------------------------------------------
// 1. Database schema — but only the parts that reach a user.
//
// A migration that adds a nullable column costs nobody anything: an older build
// ignores it, and the compatibility floor lets a rollback proceed. One that is
// marked `backwardCompatible: false` closes the door on rolling back, and that is
// worth a person's attention.
// ---------------------------------------------------------------------------
{
  const rel = 'backend/src/db/migrations.ts';
  const before = at(base, rel) ?? '';
  const after = now(rel) ?? '';
  const versionsIn = (src) => new Set([...src.matchAll(/^\s*version: (\d+),$/gm)].map((m) => m[1]));
  const added = [...versionsIn(after)].filter((v) => !versionsIn(before).has(v));

  if (added.length > 0) {
    // Pair each new `version:` with the compatibility flag that follows it.
    const oneWay = added.filter((v) =>
      new RegExp(`version: ${v},\\s*\\n\\s*backwardCompatible: false`).test(after),
    );
    if (oneWay.length > 0) {
      major(
        `migration v${oneWay.join(', v')} is marked backwardCompatible: false`,
        'a user who rolls back will have to restore a database snapshot — say so in the release notes',
      );
    } else {
      minor(
        `${added.length} additive migration(s): v${added.join(', v')}`,
        'safe to roll back across, but it is still a schema change worth a version bump',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Unraid template Config targets.
//
// Unraid keys a user's saved settings by Target. Rename or remove one and their
// value is silently dropped on the next update — invisible in review, and the
// user gets a container that starts with a default they never chose.
// ---------------------------------------------------------------------------
{
  const rel = 'templates/factorio-tools-manager.xml';
  const targets = (src) =>
    src ? new Set([...src.matchAll(/<Config\b[^>]*\bTarget="([^"]*)"/g)].map((m) => m[1])) : null;
  const before = targets(at(base, rel));
  const after = targets(now(rel));

  if (before && after) {
    const removed = [...before].filter((t) => !after.has(t));
    if (removed.length > 0) {
      major(
        `Unraid template no longer has Config target(s): ${removed.join(', ')}`,
        'existing installs key their saved values by Target — removing one silently discards it',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Environment variables.
//
// Every one of these is written down in somebody's compose file or Unraid
// template. Removing or renaming one changes behaviour on their next restart with
// no error to notice.
// ---------------------------------------------------------------------------
{
  const rel = 'backend/src/config.ts';
  const names = (src) =>
    src ? new Set([...src.matchAll(/\b(?:opt|req|intOpt|parseRange)\('([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1])) : null;
  const before = names(at(base, rel));
  const after = names(now(rel));

  if (before && after) {
    const removed = [...before].filter((n) => !after.has(n));
    if (removed.length > 0) {
      major(
        `environment variable(s) no longer read: ${removed.join(', ')}`,
        'keep the old name working for a major with a startup warning, or document the rename',
      );
    }
    const added = [...after].filter((n) => !before.has(n));
    if (added.length > 0) {
      minor(`new environment variable(s): ${added.join(', ')}`, 'document them in the README table');
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Defaults people have already acted on: forwarded ports, and the data layout.
// ---------------------------------------------------------------------------
{
  const rel = 'backend/src/config.ts';
  const before = at(base, rel);
  const after = now(rel);
  const defaultOf = (src, name) =>
    src?.match(new RegExp(`parseRange\\('${name}', '([^']+)'`))?.[1] ?? null;

  for (const range of ['GAME_PORT_RANGE', 'RCON_PORT_RANGE']) {
    const b = defaultOf(before, range);
    const a = defaultOf(after, range);
    if (b && a && b !== a) {
      major(
        `default ${range} changed ${b} → ${a}`,
        'users forwarded the old range on their router; existing servers keep their allocated ports but new ones move',
      );
    }
  }

  // The container-side data path is half of the Unraid appdata mount; changing it
  // without the template points the database somewhere that is not persisted.
  const tplRel = 'templates/factorio-tools-manager.xml';
  const dataTarget = (src) => src?.match(/<Config\b[^>]*\bTarget="(\/data[^"]*)"/)?.[1] ?? null;
  const tb = dataTarget(at(base, tplRel));
  const ta = dataTarget(now(tplRel));
  if (tb && ta && tb !== ta) {
    major(`Unraid data mount moved ${tb} → ${ta}`, 'existing installs keep the old mount until edited by hand');
  }
}

// ---------------------------------------------------------------------------
// Verdict: does .version reflect what changed?
// ---------------------------------------------------------------------------
const readLine = (src) => {
  if (!src) return null;
  const n = (k) => Number.parseInt(src.match(new RegExp(`^${k}\\s*=\\s*(\\d+)`, 'm'))?.[1] ?? 'NaN', 10);
  const major_ = n('MAJOR');
  const minor_ = n('MINOR');
  return Number.isFinite(major_) && Number.isFinite(minor_) ? { major: major_, minor: minor_ } : null;
};

const lineBefore = readLine(at(base, '.version'));
const lineAfter = readLine(now('.version'));
if (!lineAfter) {
  console.error('✗ .version is missing or unparseable');
  process.exit(1);
}

// A .version that did not exist on the base ref is being introduced by this
// change; there is no previous number to have bumped.
const introducing = lineBefore === null;
const bumpedMajor = introducing || lineAfter.major > lineBefore.major;
const bumpedMinor = introducing || lineAfter.minor > lineBefore.minor;
const bumped = bumpedMajor || bumpedMinor;

const worst = findings.some((f) => f.level === 'major') ? 'major' : findings.length ? 'minor' : 'none';

const render = () => {
  if (findings.length === 0) return;
  console.log('Changes that reach users:\n');
  for (const f of findings) {
    console.log(`  [${f.level.toUpperCase()}] ${f.what}`);
    console.log(`          ${f.why}\n`);
  }
};

render();

if (worst === 'none') {
  console.log('✓ nothing that touches a user-facing contract');
  process.exit(0);
}

// An override exists because these rules cannot know intent — a removed env var
// that was never released, for instance.
if (process.env.IMPACT_OVERRIDE === 'true') {
  console.log('! impact-reviewed label present — accepted without a version bump');
  process.exit(0);
}

if (worst === 'major' && !bumpedMajor) {
  console.error(
    `✗ this needs MAJOR bumped in .version (currently ${lineAfter.major}.${lineAfter.minor}),\n` +
      '  and the upgrade path written into UPGRADING.md / the [Unreleased] changelog section.\n' +
      '  If a listed item is not really breaking, explain why in the PR and ask a maintainer to apply impact-reviewed.',
  );
  process.exit(1);
}
if (worst === 'minor' && !bumped) {
  console.error(
    `✗ this needs at least MINOR bumped in .version (currently ${lineAfter.major}.${lineAfter.minor}).\n` +
      '  If it is genuinely a patch, explain why in the PR and ask a maintainer to apply impact-reviewed.',
  );
  process.exit(1);
}

console.log(`✓ .version is ${lineAfter.major}.${lineAfter.minor}, bumped to match`);
