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
  /** Portal releases oldest-first, as `[version, factorio_version]` pairs. */
  releases?: [string, string | undefined][];
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
    const short = /\/api\/mods\/([^/]+)$/.exec(url);
    if (short) {
      const name = decodeURIComponent(short[1]);
      const mod = portal[name];
      if (!mod) return json(404, {});
      const releases = (mod.releases ?? [['1.0.0', '2.0']]).map(([version, fv]) => ({
        version,
        download_url: `/download/${name}/${version}`,
        file_name: `${name}_${version}.zip`,
        info_json: fv === undefined ? {} : { factorio_version: fv },
      }));
      return json(200, { name, releases });
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

/* ------------------------------------------------------------------ *
 * Dependency resolution
 * ------------------------------------------------------------------ */

const DEPS: Portal = {
  alpha: {
    title: 'Alpha',
    downloads: 100,
    deps: [
      'base >= 2.0.0',
      'beta >= 1.2.0',
      '~ gamma',
      '+ delta >= 0.5.0',
      '? epsilon',
      '(?) zeta',
      '! omega',
      'ghost >= 1.0.0',
    ],
  },
  beta: { title: 'Beta', downloads: 80, deps: ['base', 'theta >= 2.0.0'] },
  gamma: { title: 'Gamma', downloads: 60, deps: [] },
  theta: { title: 'Theta', downloads: 40, deps: ['? iota'] },
  delta: { title: 'Delta', downloads: 30 },
  epsilon: { title: 'Epsilon', downloads: 20 },
  zeta: { title: 'Zeta', downloads: 10 },
  iota: { title: 'Iota', downloads: 5 },
  omega: { title: 'Omega', downloads: 1 },
  // In the catalog, but its detail endpoint 404s.
  hollow: { title: 'Hollow', downloads: 1, noDetail: true },
  loopa: { title: 'Loop A', deps: ['loopb'] },
  loopb: { title: 'Loop B', deps: ['loopa'] },
};

test('resolve walks hard dependencies transitively and reports what pulled each in', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('alpha');
    assert.deepEqual(
      r.required.map((d) => d.name),
      ['beta', 'gamma', 'theta'],
      '`~` counts as required; transitive deps are included',
    );
    assert.equal(r.required.find((d) => d.name === 'theta')?.via, 'beta');
    assert.equal(r.required.find((d) => d.name === 'beta')?.via, 'alpha');
    assert.equal(r.title, 'Alpha');
  } finally {
    h.restore();
  }
});

test('resolve reports version constraints verbatim without enforcing them', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('alpha');
    assert.equal(r.required.find((d) => d.name === 'beta')?.constraint, '>= 1.2.0');
    assert.equal(r.required.find((d) => d.name === 'gamma')?.constraint, undefined);
  } finally {
    h.restore();
  }
});

test('optional dependencies come from the requested mod only, and carry their prefix', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('alpha');
    assert.deepEqual(
      r.optional.map((d) => d.name),
      ['delta', 'epsilon', 'zeta'],
      "theta's optional `iota` is not surfaced — the user didn't ask for theta",
    );
    const delta = r.optional.find((d) => d.name === 'delta');
    assert.equal(delta?.defaultEnabled, true, '`+` is enabled by default');
    assert.equal(r.optional.find((d) => d.name === 'zeta')?.hidden, true, '`(?)` is hidden');
    assert.equal(delta?.constraint, '>= 0.5.0');
  } finally {
    h.restore();
  }
});

test('installed and game-bundled dependencies are satisfied, not offered again', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('alpha', ['beta', 'delta']);
    assert.deepEqual(
      r.required.map((d) => d.name),
      ['gamma'],
      'beta is installed, and its own deps are not re-walked',
    );
    assert.ok(r.satisfied.includes('base'), 'base ships with the game');
    assert.ok(r.satisfied.includes('beta'));
    assert.deepEqual(
      r.optional.map((d) => d.name),
      ['epsilon', 'zeta'],
      'an installed optional is not offered',
    );
  } finally {
    h.restore();
  }
});

test('incompatible dependencies are flagged, and marked when already installed', async () => {
  const h = harness(DEPS);
  try {
    const clean = await h.mods.resolveDependencies('alpha');
    assert.deepEqual(
      clean.incompatible.map((d) => d.name),
      ['omega'],
    );
    assert.equal(clean.incompatible[0].installed, false);

    const conflict = await h.mods.resolveDependencies('alpha', ['omega']);
    assert.equal(conflict.incompatible[0].installed, true, 'a live conflict is called out');
    assert.ok(
      !conflict.required.some((d) => d.name === 'omega'),
      'an incompatible mod is never added',
    );
  } finally {
    h.restore();
  }
});

test('dependencies with no portal entry are reported rather than silently dropped', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('alpha');
    assert.deepEqual(r.missing, ['ghost']);
    assert.ok(!r.required.some((d) => d.name === 'ghost'));
  } finally {
    h.restore();
  }
});

test('a mod whose detail endpoint 404s resolves to no dependencies', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('beta');
    assert.ok(r.required.some((d) => d.name === 'theta'));
    await assert.rejects(
      () => h.mods.resolveDependencies('hollow'),
      /not found on the mod portal/,
      'the requested mod itself missing is an error, not an empty dialog',
    );
  } finally {
    h.restore();
  }
});

test('a dependency cycle terminates', async () => {
  const h = harness(DEPS);
  try {
    const r = await h.mods.resolveDependencies('loopa');
    assert.deepEqual(
      r.required.map((d) => d.name),
      ['loopb'],
    );
    assert.equal(r.truncated, false);
  } finally {
    h.restore();
  }
});

test('detail lookups are cached across resolves', async () => {
  const h = harness(DEPS);
  try {
    await h.mods.resolveDependencies('alpha');
    const first = h.calls.full.length;
    await h.mods.resolveDependencies('alpha');
    assert.equal(h.calls.full.length, first, 'second resolve hits the cache');
    assert.equal(
      new Set(h.calls.full).size,
      first,
      'each mod is fetched at most once within a resolve',
    );
  } finally {
    h.restore();
  }
});

test('a pathological graph is truncated instead of walked forever', async () => {
  const chain: Portal = {};
  for (let i = 0; i < 150; i++) {
    chain[`m${i}`] = { title: `M${i}`, downloads: 150 - i, deps: [`m${i + 1}`] };
  }
  chain.m150 = { title: 'M150' };
  const h = harness(chain);
  try {
    const r = await h.mods.resolveDependencies('m0');
    assert.equal(r.truncated, true);
    assert.ok(r.required.length <= 150, 'the walk stopped short of the whole chain');
    assert.ok(h.calls.full.length < 150, 'and stopped requesting');
  } finally {
    h.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Release selection
 * ------------------------------------------------------------------ */

const RELEASES: Portal = {
  // Kept current: has a build for each series.
  maintained: { releases: [['1.0.0', '1.1'], ['2.0.0', '2.0'], ['3.0.0', '2.1']] },
  // Abandoned before 2.0 — its newest release is the wrong one to install.
  abandoned: { releases: [['0.9.0', '1.1'], ['1.0.0', '1.1']] },
  // Moved on to 2.1, so a 2.0 server must not take the newest either.
  ahead: { releases: [['1.0.0', '2.0'], ['2.0.0', '2.1']] },
  // Ancient mod with no declared version in its release manifest.
  undeclared: { releases: [['1.0.0', undefined]] },
};

test('the newest release for the server\'s Factorio series is chosen, not the newest overall', async () => {
  const h = harness(RELEASES);
  try {
    assert.equal((await h.mods.latestRelease('maintained', '2.0')).version, '2.0.0');
    assert.equal((await h.mods.latestRelease('maintained', '2.1')).version, '3.0.0');
    assert.equal((await h.mods.latestRelease('ahead', '2.0')).version, '1.0.0');
    assert.equal(
      (await h.mods.latestRelease('maintained')).version,
      '3.0.0',
      'with no series known, behaviour is unchanged',
    );
  } finally {
    h.restore();
  }
});

test('a mod with nothing built for this Factorio is refused, naming both versions', async () => {
  const h = harness(RELEASES);
  try {
    await assert.rejects(
      () => h.mods.latestRelease('abandoned', '2.0'),
      /no release for Factorio 2\.0 \(newest is 1\.0\.0 for 1\.1\)/,
    );
  } finally {
    h.restore();
  }
});

test('a release that declares no Factorio version is taken as usable', async () => {
  const h = harness(RELEASES);
  try {
    assert.equal((await h.mods.latestRelease('undeclared', '2.0')).version, '1.0.0');
  } finally {
    h.restore();
  }
});

test('a pin to a release built for another Factorio is refused, not honoured', async () => {
  const h = harness(RELEASES);
  try {
    assert.equal((await h.mods.getRelease('maintained', '2.0.0', '2.0')).version, '2.0.0');
    await assert.rejects(
      () => h.mods.getRelease('maintained', '1.0.0', '2.0'),
      /pinned to 1\.0\.0, which is built for Factorio 1\.1, not 2\.0/,
    );
    await assert.rejects(
      () => h.mods.getRelease('maintained', '9.9.9', '2.0'),
      /has no release 9\.9\.9/,
    );
  } finally {
    h.restore();
  }
});
