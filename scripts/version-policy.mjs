#!/usr/bin/env node
/**
 * Read-only release preview and CI policy check.
 *
 *   node scripts/version-policy.mjs --base origin/main
 *   node scripts/version-policy.mjs --base origin/main --json
 *
 * The release coordinator adds --head HEAD --reconcile so an interrupted run
 * can safely resume when its calculated tag already exists on the merge commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseMajor(text) {
  const matches = [...(text ?? '').matchAll(/^MAJOR\s*=\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) throw new Error('.version must contain exactly one numeric MAJOR');
  if (/^MINOR\s*=/m.test(text)) throw new Error('.version must not store MINOR; minor is calculated from schema changes');
  return Number.parseInt(matches[0][1], 10);
}

export function parseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) return null;
  return { tag, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function latestTag(tags) {
  return tags.map(parseTag).filter(Boolean).sort(compareVersions).at(-1) ?? null;
}

export function nextVersion(previous, releaseClass, declaredMajor) {
  if (releaseClass === 'none') return null;
  if (!previous || releaseClass === 'major') return `${declaredMajor}.0.0`;
  if (releaseClass === 'minor') return `${declaredMajor}.${previous.minor + 1}.0`;
  return `${declaredMajor}.${previous.minor}.${previous.patch + 1}`;
}

const TEST_FILE = /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test-setup\.[cm]?[jt]sx?$/;

export function classifyPath(file) {
  if (TEST_FILE.test(file)) return null;
  if (/^(backend|frontend)\/package(?:-lock)?\.json$/.test(file)) return 'runtime dependency manifest';
  if (/^backend\/src\/.*\.[cm]?[jt]sx?$/.test(file)) return 'backend runtime source';
  if (/^frontend\/src\/.*\.(?:[cm]?[jt]sx?|css)$/.test(file)) return 'frontend runtime source';
  if (file === 'frontend/index.html' || file.startsWith('frontend/public/')) return 'production frontend asset';
  if (file === 'Dockerfile') return 'production image definition';
  if (file === 'docker-compose.yml') return 'production Compose configuration';
  if (file === 'templates/factorio-stack-manager.xml') return 'Unraid runtime template';
  return null;
}

function neutralManifest(source, lockfile) {
  try {
    const json = JSON.parse(source ?? '');
    delete json.version;
    if (lockfile && json.packages?.['']) delete json.packages[''].version;
    return JSON.stringify(json);
  } catch {
    return source;
  }
}

export function isRuntimeFileChange(file, before, after) {
  if (/^(backend|frontend)\/package\.json$/.test(file)) {
    return neutralManifest(before, false) !== neutralManifest(after, false);
  }
  if (/^(backend|frontend)\/package-lock\.json$/.test(file)) {
    return neutralManifest(before, true) !== neutralManifest(after, true);
  }
  if (file === 'templates/factorio-stack-manager.xml') {
    const neutral = (text) => text?.replace(/<Changes>[\s\S]*?<\/Changes>/, '<Changes/>').replace(/<Date>[^<]*<\/Date>/, '<Date/>');
    return neutral(before) !== neutral(after);
  }
  return before !== after;
}

function migrationEntries(source) {
  const array = source?.match(/const MIGRATIONS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
  const starts = [...array.matchAll(/^\s*\{\s*\n\s*version:\s*(\d+)\s*,/gm)];
  const entries = new Map();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].index;
    const end = starts[i + 1]?.index ?? array.length;
    const body = array.slice(start, end).trim();
    const flag = body.match(/\bbackwardCompatible\s*:\s*(true|false)\s*,/);
    entries.set(Number(starts[i][1]), { body, backwardCompatible: flag?.[1] === 'true', declared: Boolean(flag) });
  }
  return entries;
}

export function analyzeMigrations(before, after, schemaChanged = false) {
  const oldEntries = migrationEntries(before);
  const newEntries = migrationEntries(after);
  const violations = [];
  const changedExisting = [...oldEntries].filter(([version, entry]) => newEntries.get(version)?.body !== entry.body);
  if (changedExisting.length) violations.push(`existing migration(s) mutated: v${changedExisting.map(([v]) => v).join(', v')}`);

  const added = [...newEntries].filter(([version]) => !oldEntries.has(version)).sort(([a], [b]) => a - b);
  const expected = (Math.max(0, ...oldEntries.keys()) || 0) + 1;
  added.forEach(([version, entry], index) => {
    if (version !== expected + index) violations.push(`new migration v${version} must append as v${expected + index}`);
    if (!entry.declared) violations.push(`migration v${version} must declare backwardCompatible`);
  });
  if (schemaChanged && added.length === 0) violations.push('database schema changed without an appended migration');

  const oneWay = added.filter(([, entry]) => entry.declared && !entry.backwardCompatible).map(([v]) => v);
  const additive = added.filter(([, entry]) => entry.declared && entry.backwardCompatible).map(([v]) => v);
  return { violations, added: added.map(([v]) => v), oneWay, additive };
}

function envNames(source) {
  return new Set([...(source ?? '').matchAll(/\b(?:opt|req|intOpt|parseRange)\('([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]));
}

function configTargets(source) {
  return new Set([...(source ?? '').matchAll(/<Config\b[^>]*\bTarget="([^"]*)"/g)].map((m) => m[1]));
}

export function breakingContracts(filesBefore, filesAfter) {
  const findings = [];
  const removed = (before, after) => [...before].filter((item) => !after.has(item));
  const removedEnv = removed(envNames(filesBefore.config), envNames(filesAfter.config));
  if (removedEnv.length) findings.push(`removed environment variable(s): ${removedEnv.join(', ')}`);
  const removedTargets = removed(configTargets(filesBefore.template), configTargets(filesAfter.template));
  if (removedTargets.length) findings.push(`removed or renamed Unraid Config target(s): ${removedTargets.join(', ')}`);

  const range = (source, name) => source?.match(new RegExp(`parseRange\\('${name}', '([^']+)'`))?.[1];
  for (const name of ['GAME_PORT_RANGE', 'RCON_PORT_RANGE']) {
    const before = range(filesBefore.config, name);
    const after = range(filesAfter.config, name);
    if (before && after && before !== after) findings.push(`changed default ${name}: ${before} → ${after}`);
  }
  const mount = (source) => source?.match(/<Config\b[^>]*\bName="Appdata"[^>]*\bTarget="([^"]+)"/)?.[1]
    ?? source?.match(/<Config\b[^>]*\bTarget="(\/data[^"]*)"/)?.[1];
  const oldMount = mount(filesBefore.template);
  const newMount = mount(filesAfter.template);
  if (oldMount && newMount && oldMount !== newMount) findings.push(`moved Unraid data mount: ${oldMount} → ${newMount}`);
  return findings;
}

export function evaluatePolicy({ changedFiles, baseMajor, declaredMajor, previous, migrations, breaking = [] }) {
  const violations = [...migrations.violations];
  if (declaredMajor < baseMajor) violations.push(`MAJOR decreased from ${baseMajor} to ${declaredMajor}`);
  if (declaredMajor > baseMajor + 1) violations.push(`MAJOR skipped from ${baseMajor} to ${declaredMajor}; increase it exactly one step at a time`);
  if (breaking.length || migrations.oneWay.length) {
    if (declaredMajor !== baseMajor + 1) {
      violations.push(`breaking change requires MAJOR=${baseMajor + 1} (found ${declaredMajor})`);
    }
  }

  const reasons = [];
  let versionMajor = declaredMajor;
  const manualMajor = declaredMajor === baseMajor + 1;
  const needsMajor = breaking.length > 0 || migrations.oneWay.length > 0;
  const runtimeReasons = changedFiles
    .filter((file) => !(file === 'backend/src/db/migrations.ts' && migrations.added.length))
    .map((file) => ({ file, rule: classifyPath(file) }))
    .filter((reason) => reason.rule);

  let releaseClass = 'none';
  if (manualMajor || needsMajor) {
    releaseClass = 'major';
    if (manualMajor) reasons.push({ file: '.version', rule: `manual MAJOR increase ${baseMajor} → ${declaredMajor}` });
    else versionMajor = baseMajor + 1;
  } else if (migrations.added.length) {
    releaseClass = 'minor';
  } else if (runtimeReasons.length) {
    releaseClass = 'patch';
  }
  if (migrations.added.length) {
    reasons.push({ file: 'backend/src/db/migrations.ts', rule: `${migrations.added.length} appended ${migrations.oneWay.length ? 'one-way' : 'additive'} migration(s)` });
  }
  reasons.push(...runtimeReasons);
  for (const finding of breaking) reasons.push({ file: 'runtime contract', rule: finding });

  if (previous && declaredMajor !== previous.major && declaredMajor !== previous.major + 1) {
    violations.push(`latest release is ${previous.major}.${previous.minor}.${previous.patch}; MAJOR must remain ${previous.major} or become ${previous.major + 1}`);
  }
  const version = nextVersion(previous, releaseClass, versionMajor);
  const expectedMajor = needsMajor || declaredMajor > baseMajor + 1
    ? baseMajor + 1
    : declaredMajor < baseMajor ? baseMajor : declaredMajor;
  return { releaseClass, reasons, version, tag: version ? `v${version}` : null, expectedMajor, violations };
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function fileAt(ref, rel) {
  try {
    return git(['show', `${ref}:${rel}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function reachableTags(ref) {
  const output = git(['tag', '--merged', ref, '--list']);
  return output ? output.split('\n').filter(Boolean) : [];
}

export function analyzeRepository({ baseRef, headRef = 'HEAD', reconcile = false } = {}) {
  const all = reachableTags(headRef).map(parseTag).filter(Boolean).sort(compareVersions);
  const globalText = git(['tag', '--list']);
  const globalLatest = latestTag(globalText ? globalText.split('\n') : []);
  const headSha = git(['rev-parse', headRef]);
  const exact = all.filter((tag) => git(['rev-list', '-n', '1', tag.tag]) === headSha).at(-1) ?? null;
  const previous = reconcile && exact ? all.filter((tag) => tag.tag !== exact.tag).at(-1) ?? null : all.at(-1) ?? null;
  const comparison = baseRef ?? previous?.tag;
  const base = comparison ?? git(['hash-object', '-t', 'tree', '/dev/null']);
  const changedText = git(['diff', '--name-only', `${base}..${headRef}`]);
  const changedFiles = changedText ? changedText.split('\n').filter(Boolean) : [];
  const beforeVersion = fileAt(base, '.version');
  const afterVersion = fileAt(headRef, '.version');
  const declaredMajor = parseMajor(afterVersion);
  const legacyMajor = beforeVersion?.match(/^MAJOR\s*=\s*(\d+)\s*$/m);
  if (beforeVersion && !legacyMajor) throw new Error(`base ${base} has no numeric MAJOR`);
  const baseMajor = legacyMajor ? Number.parseInt(legacyMajor[1], 10) : previous?.major ?? declaredMajor;
  const beforeMigrations = fileAt(base, 'backend/src/db/migrations.ts') ?? '';
  const afterMigrations = fileAt(headRef, 'backend/src/db/migrations.ts') ?? '';
  const migrations = analyzeMigrations(beforeMigrations, afterMigrations, changedFiles.includes('backend/src/db/schema.ts'));
  const breaking = breakingContracts(
    { config: fileAt(base, 'backend/src/config.ts'), template: fileAt(base, 'templates/factorio-stack-manager.xml') },
    { config: fileAt(headRef, 'backend/src/config.ts'), template: fileAt(headRef, 'templates/factorio-stack-manager.xml') },
  );
  const releaseFiles = changedFiles.filter((file) => {
    if (!classifyPath(file)) return true;
    return isRuntimeFileChange(file, fileAt(base, file), fileAt(headRef, file));
  });
  const result = evaluatePolicy({ changedFiles: releaseFiles, baseMajor, declaredMajor, previous, migrations, breaking });
  if (exact) {
    if (result.tag !== exact.tag) result.violations.push(`existing ${exact.tag} does not match recalculated ${result.tag ?? 'no-release'}`);
    result.version = exact.tag.slice(1);
    result.tag = exact.tag;
    result.existingTag = true;
  }
  const candidate = result.tag ? parseTag(result.tag) : null;
  const candidateReachable = candidate && all.some((tag) => tag.tag === candidate.tag);
  if (globalLatest && candidate && compareVersions(globalLatest, candidate) > 0) {
    if (exact) result.staleReconciliation = true;
    else result.violations.push(`${globalLatest.tag} already exists outside this commit's history; refusing an untagged stale release`);
  } else if (globalLatest && candidate && globalLatest.tag === candidate.tag && !candidateReachable) {
    result.violations.push(`${globalLatest.tag} already exists on another commit; refusing a duplicate release`);
  }
  return { ...result, base: comparison ?? '(repository root)', head: headSha, declaredMajor, previousTag: previous?.tag ?? null, changedFiles };
}

function render(result) {
  const lines = [
    `Release class: ${result.releaseClass}`,
    `Predicted version: ${result.version ?? 'none'}`,
    `Expected MAJOR: ${result.expectedMajor}`,
    `Compared: ${result.base}..${result.head}`,
  ];
  if (result.reasons.length) {
    lines.push('Reasons:');
    for (const reason of result.reasons) lines.push(`- ${reason.file}: ${reason.rule}`);
  }
  if (result.violations.length) {
    lines.push('Policy violations:');
    for (const violation of result.violations) lines.push(`- ${violation}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    const result = analyzeRepository({ baseRef: valueAfter('--base'), headRef: valueAfter('--head') ?? 'HEAD', reconcile: args.includes('--reconcile') });
    const report = render(result);
    console.log(args.includes('--json') ? JSON.stringify(result) : report);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Version policy\n\n${report}\n`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_class=${result.releaseClass}\nversion=${result.version ?? ''}\ntag=${result.tag ?? ''}\nexpected_major=${result.expectedMajor}\nrelease=${result.releaseClass !== 'none'}\nexisting_tag=${Boolean(result.existingTag)}\nstale_reconciliation=${Boolean(result.staleReconciliation)}\nprevious_tag=${result.previousTag ?? ''}\n`);
    }
    if (result.violations.length) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Version policy\n\nPolicy error: ${message}\n`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'release_class=invalid\nversion=\nexpected_major=unknown\nrelease=false\n');
    process.exitCode = 1;
  }
}
