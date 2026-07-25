import test from 'node:test';
import assert from 'node:assert/strict';
import type { DB } from '../src/db/index.js';

// ModService transitively imports the env-backed config module, which throws at
// load time when ADMIN_PASSWORD is unset. Nothing under test reads it, so set a
// placeholder and import after.
process.env.ADMIN_PASSWORD ??= 'test-only';
const { ModService } = await import('../src/services/modService.js');

/**
 * A fake mod portal. `listing` entries mirror `/api/mods?page_size=max` results;
 * `deps` mirrors the `dependencies` array of a mod's newest release, served from
 * `/api/mods/<name>/full`.
 *
 * The catalog/search half of these tests is a regression guard: the portal marks
 * library and asset mods `category: "internal"`, and filtering that category out
 * hid flib, stdlib and the Space Exploration graphics parts from search entirely.
 */
interface FakeMod {
  category?: string;
  title?: string;
  owner?: string;
  summary?: string;
  downloads?: number;
  deps?: string[];
  /** Present in the listing but 404s on /full — an unlisted or withdrawn mod. */
  noDetail?: boolean;
}

interface Portal {
  [name: string]: FakeMod;
}

/** Counts requests so caching behaviour is observable. */
interface Harness {
  mods: InstanceType<typeof ModService>;
  calls: { listing: number; full: string[] };
  restore: () => void;
}

function harness(portal: Portal): Harness {
  const calls = { listing: 0, full: [] as string[] };
  const original = globalThis.fetch;

  const json = (status: number, body: unknown): Response =>
    ({ ok: status < 400, status, json: async () => body }) as Response;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('page_size=max')) {
      calls.listing++;
      return json(200, {
        results: Object.entries(portal).map(([name, m]) => ({
          name,
          title: m.title ?? name,
          owner: m.owner ?? 'someone',
          summary: m.summary ?? '',
          downloads_count: m.downloads ?? 0,
          category: m.category ?? 'content',
          latest_release: { version: '1.0.0', info_json: { factorio_version: '2.0' } },
        })),
      });
    }
    const full = /\/api\/mods\/([^/]+)\/full$/.exec(url);
    if (full) {
      const name = decodeURIComponent(full[1]);
      calls.full.push(name);
      const mod = portal[name];
      if (!mod || mod.noDetail) return json(404, {});
      return json(200, {
        name,
        title: mod.title ?? name,
        releases: [
          { version: '0.9.0', info_json: { dependencies: ['base'] } },
          { version: '1.0.0', info_json: { dependencies: mod.deps ?? [] } },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  // The DB is only touched by the download paths, which these tests don't reach.
  return {
    mods: new ModService(undefined as unknown as DB),
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Catalog + search
 * ------------------------------------------------------------------ */

const CATALOG: Portal = {
  flib: {
    title: 'Factorio Library',
    owner: 'raiguard',
    summary: 'Commonly-used utilities for creating Factorio mods.',
    category: 'internal',
    downloads: 1_000_000,
  },
  stdlib: { title: 'Factorio Standard Library', category: 'internal', downloads: 400_000 },
  'space-exploration': { title: 'Space Exploration', owner: 'Earendel', downloads: 900_000 },
  'space-exploration-graphics': {
    title: 'Space Exploration Graphics Part 1',
    category: 'internal',
    downloads: 500_000,
  },
  'belt-visualizer': { title: 'Belt Visualizer', owner: 'raiguard', downloads: 50_000 },
  'flib-fork': { title: 'A flib fork', downloads: 10 },
  'space-age': { title: '[reserved]', category: 'internal' },
  quality: { title: 'quality' },
  'junk-mod': { title: '[placeholder]' },
  untitled: { title: '' },
};

test('search finds library mods, which the portal files under the "internal" category', async () => {
  const h = harness(CATALOG);
  try {
    const byName = await h.mods.search('flib');
    assert.equal(byName[0].name, 'flib');
    const byTitle = await h.mods.search('factorio library');
    assert.equal(byTitle[0].name, 'flib');
    const assets = (await h.mods.search('space exploration')).map((r) => r.name);
    assert.ok(assets.includes('space-exploration-graphics'), 'SE graphics parts are searchable');
  } finally {
    h.restore();
  }
});

test('search drops portal stubs and mods that ship with the game', async () => {
  const h = harness(CATALOG);
  try {
    // Query each stub by its own name — the only way it could surface.
    for (const hidden of ['space-age', 'quality', 'junk-mod', 'untitled']) {
      const names = (await h.mods.search(hidden, 50)).map((r) => r.name);
      assert.ok(!names.includes(hidden), `${hidden} must not be searchable`);
    }
  } finally {
    h.restore();
  }
});

test('search ranks exact name, then prefix, then substring, then owner/summary', async () => {
  const h = harness(CATALOG);
  try {
    const ranked = (await h.mods.search('flib', 10)).map((r) => r.name);
    assert.deepEqual(ranked, ['flib', 'flib-fork']);

    const owner = (await h.mods.search('raiguard', 10)).map((r) => r.name);
    assert.deepEqual(owner, ['flib', 'belt-visualizer'], 'owner matches rank by downloads');

    const summary = (await h.mods.search('utilities', 10)).map((r) => r.name);
    assert.deepEqual(summary, ['flib']);
  } finally {
    h.restore();
  }
});

test('search honours the limit and ignores queries shorter than two characters', async () => {
  const h = harness(CATALOG);
  try {
    assert.deepEqual(await h.mods.search('f'), [], 'one character is not a search');
    assert.deepEqual(await h.mods.search(' '), []);
    assert.equal((await h.mods.search('fl', 50)).length, 2);
    assert.equal((await h.mods.search('fl', 1)).length, 1, 'limit caps the results');
  } finally {
    h.restore();
  }
});

test('the catalog is fetched once and reused across searches', async () => {
  const h = harness(CATALOG);
  try {
    await h.mods.search('flib');
    await h.mods.search('stdlib');
    assert.equal(h.calls.listing, 1);
  } finally {
    h.restore();
  }
});
