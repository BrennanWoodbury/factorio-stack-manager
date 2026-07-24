#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'DOCKERHUB.md');
const MAX_BYTES = 25_000;

const fail = (message) => {
  console.error(`✗ DOCKERHUB.md: ${message}`);
  process.exitCode = 1;
};

if (!fs.existsSync(file)) {
  fail('missing — the Docker Hub overview workflow publishes this file');
} else {
  const body = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BYTES) {
    fail(`${bytes} bytes exceeds Docker Hub's ${MAX_BYTES}-byte overview limit`);
  }

  for (const required of [
    'brennanwoodbury/factorio-manager:latest',
    'https://github.com/BrennanWoodbury/factorio-tools-manager',
    'https://github.com/BrennanWoodbury/factorio-tools-manager/issues',
  ]) {
    if (!body.includes(required)) fail(`missing required reference: ${required}`);
  }

  const relativeLinks = [...body.matchAll(/\[[^\]]*\]\((?!https:\/\/|#)([^)]+)\)/g)]
    .map((match) => match[1]);
  if (relativeLinks.length > 0) {
    fail(`contains relative link(s) Docker Hub cannot resolve: ${relativeLinks.join(', ')}`);
  }

  if (!process.exitCode) console.log(`✓ Docker Hub overview is valid (${bytes}/${MAX_BYTES} bytes)`);
}
