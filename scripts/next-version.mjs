#!/usr/bin/env node
/**
 * Resolve the next version: MAJOR.MINOR from `.version`, PATCH from git tags.
 *
 * The patch number is derived rather than stored. Tags are already the record of
 * what shipped, so deriving from them means no bot commit, no write access to
 * main, and no race between two merges landing seconds apart — creating a tag is
 * atomic and a duplicate fails loudly.
 *
 * Usage:
 *   node scripts/next-version.mjs          # -> 1.2.3
 *   node scripts/next-version.mjs --line   # -> 1.2
 *   node scripts/next-version.mjs --json   # -> {"major":1,"minor":2,"patch":3,...}
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the `KEY=value` pairs out of .version, ignoring comments. */
export function readLine(file = path.join(root, '.version')) {
  const text = fs.readFileSync(file, 'utf8');
  const read = (key) => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(\\d+)\\s*$`, 'm'));
    if (!m) throw new Error(`.version is missing ${key}`);
    return Number.parseInt(m[1], 10);
  };
  return { major: read('MAJOR'), minor: read('MINOR') };
}

/**
 * Highest patch already released on this line, or -1 when the line is new.
 * Only tags matching this exact MAJOR.MINOR count, which is what makes a MINOR
 * bump restart at .0 with no extra bookkeeping.
 */
export function highestPatch(major, minor, tags) {
  const re = new RegExp(`^v${major}\\.${minor}\\.(\\d+)$`);
  return tags.reduce((max, tag) => {
    const m = tag.match(re);
    return m ? Math.max(max, Number.parseInt(m[1], 10)) : max;
  }, -1);
}

function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Running as a script rather than being imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { major, minor } = readLine();
  const patch = highestPatch(major, minor, gitTags()) + 1;
  const version = `${major}.${minor}.${patch}`;

  if (process.argv.includes('--line')) console.log(`${major}.${minor}`);
  else if (process.argv.includes('--json'))
    console.log(JSON.stringify({ major, minor, patch, version, tag: `v${version}` }));
  else console.log(version);
}
