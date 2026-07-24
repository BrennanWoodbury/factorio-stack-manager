#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLine } from './next-version.mjs';
import { isReleasePrepared } from './release-state.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/verify-prepared-release.mjs X.Y.Z');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const backendPackage = readJson('backend/package.json');
const backendLock = readJson('backend/package-lock.json');
const frontendPackage = readJson('frontend/package.json');
const frontendLock = readJson('frontend/package-lock.json');
const manifestVersions = [
  backendPackage.version,
  backendLock.version,
  backendLock.packages?.['']?.version,
  frontendPackage.version,
  frontendLock.version,
  frontendLock.packages?.['']?.version,
];
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const template = fs.readFileSync(path.join(root, 'templates/factorio-tools-manager.xml'), 'utf8');
const { major, minor } = readLine();

if (!version.startsWith(`${major}.${minor}.`)) {
  console.error(`✗ v${version} is not on the ${major}.${minor} line declared by .version`);
  process.exit(1);
}
if (!isReleasePrepared(version, manifestVersions, changelog, template)) {
  console.error(`✗ package manifests, changelog, and Unraid template do not all describe v${version}`);
  process.exit(1);
}

console.log(`✓ merged tree is fully prepared for v${version}`);
