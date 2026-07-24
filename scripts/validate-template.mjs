#!/usr/bin/env node
/**
 * Validate the Unraid Community Applications template and repository profile.
 *
 * This runs in CI on every push and pull request for a specific reason: CA reads
 * these files straight off the default branch's raw URLs. There is no publish
 * step to catch a mistake in — whatever lands on main is immediately what users
 * see, so a malformed template is a live outage rather than a failed build.
 *
 * Usage: node scripts/validate-template.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = 'templates/factorio-tools-manager.xml';
const PROFILE = 'ca_profile.xml';
const REPO = 'BrennanWoodbury/factorio-tools-manager';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;

const errors = [];
const fail = (msg) => errors.push(msg);

/** Contents of the root element, so child parsing isn't swallowed by the wrapper. */
function innerOf(xml, rootName) {
  const m = xml.match(new RegExp(`<${rootName}\\b[^>]*>([\\s\\S]*)</${rootName}>`));
  return m ? m[1] : xml;
}

/** Minimal XML reader: enough for these flat documents, and keeps CI dependency-free. */
function parse(xml, rootName) {
  const tags = {};
  for (const [, name, attrs, body] of innerOf(xml, rootName).matchAll(
    /<([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g,
  )) {
    const attrMap = {};
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) attrMap[k] = v;
    (tags[name] ??= []).push({ attrs: attrMap, text: (body ?? '').trim() });
  }
  return tags;
}

function readFile(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    fail(`${rel} is missing — Community Applications requires it`);
    return null;
  }
  return fs.readFileSync(p, 'utf8');
}

// ---- Template -------------------------------------------------------------
const templateXml = readFile(TEMPLATE);
if (templateXml) {
  // Cheap well-formedness proxy: every opened tag must close, in order.
  const stack = [];
  for (const [full, closing, name] of templateXml.matchAll(/<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>/g)) {
    if (full.startsWith('<?') || full.endsWith('/>')) continue;
    if (closing) {
      if (stack.pop() !== name) fail(`${TEMPLATE}: tag <${name}> closes out of order`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) fail(`${TEMPLATE}: unclosed tag <${stack[stack.length - 1]}>`);

  const t = parse(templateXml, 'Container');
  const one = (n) => t[n]?.[0]?.text ?? '';

  // CA's own minimum, plus what makes a listing usable.
  for (const required of ['Name', 'Repository', 'Overview', 'Category', 'Icon', 'TemplateURL']) {
    if (!one(required)) fail(`${TEMPLATE}: <${required}> is required and empty/missing`);
  }
  if (!one('Support') && !one('Project')) {
    fail(`${TEMPLATE}: CA requires at least one of <Support> or <Project>`);
  }

  // Self-referential URLs must point at this file, or CA silently serves a stale one.
  const expectedTemplateUrl = `${RAW}/${TEMPLATE}`;
  if (one('TemplateURL') !== expectedTemplateUrl) {
    fail(`${TEMPLATE}: <TemplateURL> should be ${expectedTemplateUrl}, got "${one('TemplateURL')}"`);
  }
  for (const [tag, file] of [
    ['Icon', 'icon.png'],
    ['ReadMe', 'README.md'],
  ]) {
    const url = one(tag);
    if (!url) continue;
    if (!url.startsWith(RAW)) fail(`${TEMPLATE}: <${tag}> must be a raw URL on ${REPO}@main`);
    const rel = url.slice(RAW.length + 1);
    if (rel !== file) fail(`${TEMPLATE}: <${tag}> points at "${rel}", expected "${file}"`);
    if (!fs.existsSync(path.join(root, rel))) fail(`${TEMPLATE}: <${tag}> target ${rel} is missing`);
  }

  // The template tracks the moving release tag; pinning it here would strand users
  // on whatever version happened to be current when the template last changed.
  const repository = one('Repository');
  if (!/^[\w.-]+\/[\w.-]+:latest$/.test(repository)) {
    fail(`${TEMPLATE}: <Repository> should track ":latest", got "${repository}"`);
  }

  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(one('Date'))) {
    fail(`${TEMPLATE}: <Date> must be YYYY-MM-DD, got "${one('Date')}"`);
  }

  // Every Config needs the full attribute set; Unraid's form renders from these.
  const REQUIRED_ATTRS = ['Name', 'Target', 'Default', 'Description', 'Type', 'Display', 'Required', 'Mask'];
  const TYPES = new Set(['Port', 'Path', 'Variable', 'Device', 'Label']);
  const configs = t.Config ?? [];
  if (configs.length === 0) fail(`${TEMPLATE}: no <Config> entries`);
  for (const c of configs) {
    const label = c.attrs.Name ?? '(unnamed)';
    for (const a of REQUIRED_ATTRS) {
      if (!(a in c.attrs)) fail(`${TEMPLATE}: Config "${label}" is missing ${a}=`);
    }
    if (c.attrs.Type && !TYPES.has(c.attrs.Type)) {
      fail(`${TEMPLATE}: Config "${label}" has unknown Type="${c.attrs.Type}"`);
    }
    if (c.attrs.Required === 'true' && c.attrs.Display === 'advanced') {
      fail(`${TEMPLATE}: Config "${label}" is required but hidden behind advanced view`);
    }
  }

  // The settings a user cannot discover on their own must be present and visible.
  const byTarget = new Map(configs.map((c) => [c.attrs.Target, c.attrs]));
  for (const target of ['ADMIN_PASSWORD', 'GAME_PORT_RANGE', '/var/run/docker.sock', '/data']) {
    if (!byTarget.has(target)) fail(`${TEMPLATE}: no Config targets ${target}`);
  }
  // DATA_DIR and the appdata mount are two halves of one setting; a mismatch
  // sends the database somewhere that isn't persisted.
  const dataDir = byTarget.get('DATA_DIR');
  const appdata = byTarget.get('/data');
  if (dataDir && appdata && dataDir.Default !== appdata.Target) {
    fail(
      `${TEMPLATE}: DATA_DIR default "${dataDir.Default}" must equal the appdata ` +
        `mount's container path "${appdata.Target}"`,
    );
  }
}

// ---- Repository profile ---------------------------------------------------
const profileXml = readFile(PROFILE);
if (profileXml) {
  const p = parse(profileXml, 'CommunityApplications');
  if (!(p.Profile?.[0]?.text ?? '')) fail(`${PROFILE}: <Profile> is required and must be non-empty`);
}

// ---- Repository-level CA requirements -------------------------------------
if (!fs.existsSync(path.join(root, 'LICENSE'))) {
  fail('LICENSE is missing — CA requires an OSI-approved licence at the repository root');
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('✓ Unraid template and profile look good');
