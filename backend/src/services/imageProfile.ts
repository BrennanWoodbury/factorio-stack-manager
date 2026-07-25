import type { DockerService } from './dockerService.js';
import type { ServerRow } from '../db/models.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('image');

/**
 * What a Factorio image actually ships — read from the image itself rather than
 * hardcoded here.
 *
 * The motivation is concrete: 2.0's `space-age` hard-requires `quality`, so the
 * "Space Age without Quality" mode cannot load. 2.1 relaxed that to an
 * enable-by-default `+ quality` *and* split the recycler into a new bundled
 * `recycler` mod that both `space-age` and `quality` hard-require. A hardcoded
 * mod list gets exactly one release cycle before it is wrong again, and the
 * failure shows up as a cryptic mod error in a user's container log.
 *
 * So we read every `info.json` out of the image's data dir once per image ID and
 * derive enablement from the real dependency graph. A future release that splits
 * out another mod needs no code change.
 *
 * This module deliberately has no runtime imports — it stays cheap to unit-test
 * and safe to import from the save parser.
 */

/** A mod shipped inside the image's data dir. */
export interface BundledMod {
  name: string;
  version: string;
  /** Names of hard (non-optional) dependencies. */
  requires: string[];
}

export interface ImageProfile {
  /** Docker image ID this was read from — the cache key. */
  imageId: string;
  /** Factorio version, e.g. "2.0.77". */
  gameVersion: string;
  /** Mods shipped in the image, keyed by name. Excludes the engine's `core`. */
  mods: Map<string, BundledMod>;
  /** True when read from the image; false when we fell back to built-in knowledge. */
  derived: boolean;
}

/**
 * Mods that ship with the game and must never be fetched from the mod portal.
 * A superset across supported versions — used where no `ImageProfile` is at hand
 * (a portal download must not depend on which image a server happens to run).
 * Code that has a profile should prefer its `mods` keys.
 */
export const KNOWN_BUNDLED_MODS: ReadonlySet<string> = new Set([
  'base',
  'space-age',
  'quality',
  'elevated-rails',
  'recycler',
]);

/** The engine's own pseudo-mod: present in the data dir, never in mod-list.json. */
const CORE = 'core';

/* ------------------------------------------------------------------ *
 * Dependency parsing
 * ------------------------------------------------------------------ */

export type DependencyKind = 'required' | 'optional' | 'incompatible';

/** One parsed entry of an info.json `dependencies` array. */
export interface ModDependency {
  name: string;
  kind: DependencyKind;
  /** `+` — optional, but the game enables it by default. */
  defaultEnabled: boolean;
  /** `(?)` — optional and hidden from the game's mod GUI. */
  hidden: boolean;
  /** Version constraint exactly as written, e.g. ">= 0.14.0". Never enforced here. */
  constraint?: string;
}

/**
 * `[prefix] name [constraint]`, where the `(?)` alternative must precede `?` so
 * the longer prefix wins.
 */
const DEPENDENCY_RE = /^(!|\(\?\)|\?|\+|~)?\s*([^<>=\s]+)\s*(.*)$/;

/**
 * Parse one dependency string. Returns undefined for junk and for `core`, the
 * engine pseudo-mod that is never a real dependency.
 *
 * Factorio prefixes: `!` incompatible, `?` optional, `(?)` hidden optional,
 * `+` optional but enabled by default (2.1's `space-age` → `quality`), `~`
 * required but does not affect load order. Only bare and `~` entries are
 * requirements. `+` being optional is not just read off the manifest — 2.1.12
 * with quality disabled boots and generates a map.
 */
export function parseDependency(raw: unknown): ModDependency | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = DEPENDENCY_RE.exec(raw.trim());
  if (!m) return undefined;
  const [, prefix, name, rest] = m;
  if (!name || name === CORE) return undefined;
  const kind: DependencyKind =
    prefix === '!' ? 'incompatible' : prefix && prefix !== '~' ? 'optional' : 'required';
  return {
    name,
    kind,
    defaultEnabled: prefix === '+',
    hidden: prefix === '(?)',
    constraint: rest.trim() || undefined,
  };
}

/** Parse a whole `dependencies` array, dropping unparseable entries. */
export function parseDependencies(deps: unknown): ModDependency[] {
  if (!Array.isArray(deps)) return [];
  const out: ModDependency[] = [];
  for (const raw of deps) {
    const dep = parseDependency(raw);
    if (dep) out.push(dep);
  }
  return out;
}

/** Names of the *hard* dependencies in an info.json `dependencies` array. */
export function hardDependencies(deps: unknown): string[] {
  return parseDependencies(deps)
    .filter((d) => d.kind === 'required')
    .map((d) => d.name);
}

/** Marker the introspection script prints after each info.json. */
export const INFO_SEPARATOR = '@@FTM-MOD@@';

/** Parse the introspection script's output into mods (bad chunks are skipped). */
export function parseModInfo(raw: string): BundledMod[] {
  const mods: BundledMod[] = [];
  for (const chunk of raw.split(INFO_SEPARATOR)) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const name = typeof json.name === 'string' ? json.name : '';
      // `core` carries no version and is never listed in mod-list.json.
      if (!name || name === CORE || typeof json.version !== 'string') continue;
      mods.push({ name, version: json.version, requires: hardDependencies(json.dependencies) });
    } catch {
      /* not a complete info.json — ignore */
    }
  }
  return mods;
}

/* ------------------------------------------------------------------ *
 * Enablement
 * ------------------------------------------------------------------ */

/**
 * Every mod reachable from `wanted` through hard dependencies. Names absent from
 * the image are dropped — they can't be enabled and aren't ours to install.
 */
export function dependencyClosure(wanted: readonly string[], profile: ImageProfile): Set<string> {
  const out = new Set<string>();
  const stack = [...wanted];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (out.has(name)) continue;
    const mod = profile.mods.get(name);
    if (!mod) continue;
    out.add(name);
    for (const dep of mod.requires) if (!out.has(dep)) stack.push(dep);
  }
  return out;
}

/**
 * What each game mode asks for. Everything else it needs comes from the
 * dependency closure, which is why `elevated-rails` and `recycler` aren't listed:
 * the image says whether they're required, we don't.
 */
const MODE_WANTS: Record<string, readonly string[] | null> = {
  vanilla: [],
  space_age: ['space-age', 'quality'],
  space_age_no_quality: ['space-age'],
  modded: null, // the applied modpack owns the mod list
  // "+ mods" modes: something other than a game mode decides the bundled set — an
  // uploaded save's own header, or a modpack — so enforcing one here would fight it.
  // They differ from `modded` only in saying which base the mods sit on, which is
  // what the map-gen slider set and the planet list key off.
  modded_vanilla: null,
  modded_space_age: null,
};

/**
 * Which bundled mods a game mode forces on/off in mod-list.json (other mods are
 * preserved by the caller). `null` = don't touch.
 */
export function modEnablementFor(
  mode: string,
  profile: ImageProfile,
): Record<string, boolean> | null {
  const wants = mode in MODE_WANTS ? MODE_WANTS[mode] : MODE_WANTS.space_age;
  if (wants === null) return null;
  const on = dependencyClosure(wants, profile);
  const out: Record<string, boolean> = {};
  for (const name of profile.mods.keys()) {
    if (name === 'base') continue; // always enabled, never toggled
    out[name] = on.has(name);
  }
  return out;
}

/**
 * Why a mode can't run on this image, or null if it can.
 *
 * The only mode that can be impossible is "Space Age without Quality": on 2.0.x
 * `quality` is a hard dependency of `space-age`, so it comes back through the
 * closure no matter what we write to mod-list.json.
 */
export function gameModeIssue(mode: string, profile: ImageProfile): string | null {
  if (mode !== 'space_age_no_quality') return null;
  if (!profile.mods.has('space-age')) return null;
  if (!dependencyClosure(['space-age'], profile).has('quality')) return null;
  return (
    `"Space Age — without Quality" needs Factorio 2.1 or newer. On ${profile.gameVersion} the ` +
    'space-age mod requires quality, so it cannot be disabled. Choose a newer Factorio version ' +
    'or switch to plain Space Age.'
  );
}

/* ------------------------------------------------------------------ *
 * Fallback
 * ------------------------------------------------------------------ */

/** True when `version` ("2.1.12") is at least major.minor. */
export function atLeast(version: string, major: number, minor: number): boolean {
  const [ma, mi] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ma) || !Number.isFinite(mi)) return false;
  return ma > major || (ma === major && mi >= minor);
}

/**
 * Built-in knowledge, used only when the image can't be introspected (an image
 * with no shell, a Docker hiccup). Keeps servers startable rather than blocking
 * them on our ability to read a file, at the cost of being version-guessed.
 */
export function fallbackProfile(imageId: string, gameVersion: string): ImageProfile {
  const modern = atLeast(gameVersion, 2, 1);
  const mods: BundledMod[] = modern
    ? [
        { name: 'base', version: gameVersion, requires: [] },
        { name: 'recycler', version: gameVersion, requires: ['base'] },
        { name: 'elevated-rails', version: gameVersion, requires: ['base'] },
        { name: 'quality', version: gameVersion, requires: ['base', 'recycler'] },
        { name: 'space-age', version: gameVersion, requires: ['base', 'elevated-rails', 'recycler'] },
      ]
    : [
        { name: 'base', version: gameVersion, requires: [] },
        { name: 'elevated-rails', version: gameVersion, requires: ['base'] },
        { name: 'quality', version: gameVersion, requires: ['base'] },
        { name: 'space-age', version: gameVersion, requires: ['base', 'elevated-rails', 'quality'] },
      ];
  return {
    imageId,
    gameVersion,
    mods: new Map(mods.map((m) => [m.name, m])),
    derived: false,
  };
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

/**
 * Shell run inside the image to dump every bundled mod's manifest. Costs ~0.6s
 * and ~1.4 KB, so it is cached per image ID rather than per call.
 */
export const INTROSPECT_SCRIPT =
  'for d in /opt/factorio/data/*/; do ' +
  `if [ -f "$d/info.json" ]; then cat "$d/info.json"; printf '\\n${INFO_SEPARATOR}\\n'; fi; ` +
  'done 2>/dev/null';

/** Reads and caches an image's bundled-mod graph. */
export class ImageProfileService {
  /** Keyed by Docker image ID, so a repulled moving tag invalidates naturally. */
  private readonly cache = new Map<string, ImageProfile>();
  private readonly inFlight = new Map<string, Promise<ImageProfile>>();

  constructor(private readonly docker: DockerService) {}

  forServer(server: ServerRow): Promise<ImageProfile> {
    return this.forImage(this.docker.imageFor(server));
  }

  /** Profile for an image, pulling it first if it isn't local. */
  async forImage(image: string): Promise<ImageProfile> {
    const identity = await this.docker.imageIdentity(image, { pullIfMissing: true });
    if (!identity) throw new Error(`image ${image} is unavailable`);
    return this.resolve(image, identity);
  }

  /**
   * Best-effort profile that never pulls — for UI hints, which must not block on a
   * ~600 MB download. Null when the image isn't local yet; the authoritative check
   * happens server-side at start/probe, where the image is present anyway.
   */
  peekServer(server: ServerRow): Promise<ImageProfile | null> {
    return this.peekImage(this.docker.imageFor(server));
  }

  async peekImage(image: string): Promise<ImageProfile | null> {
    const identity = await this.docker.imageIdentity(image, { pullIfMissing: false });
    if (!identity) return null;
    return this.resolve(image, identity);
  }

  private resolve(
    image: string,
    identity: { id: string; factorioVersion?: string },
  ): Promise<ImageProfile> {
    const cached = this.cache.get(identity.id);
    if (cached) return Promise.resolve(cached);

    const pending = this.inFlight.get(identity.id);
    if (pending) return pending;

    const task = this.read(image, identity).finally(() => this.inFlight.delete(identity.id));
    this.inFlight.set(identity.id, task);
    return task;
  }

  private async read(
    image: string,
    identity: { id: string; factorioVersion?: string },
  ): Promise<ImageProfile> {
    let profile: ImageProfile;
    try {
      const raw = await this.docker.runImageShell(image, INTROSPECT_SCRIPT);
      const mods = parseModInfo(raw);
      if (mods.length === 0) throw new Error('no mod manifests found in the image');
      const version =
        identity.factorioVersion ?? mods.find((m) => m.name === 'base')?.version ?? 'unknown';
      profile = {
        imageId: identity.id,
        gameVersion: version,
        mods: new Map(mods.map((m) => [m.name, m])),
        derived: true,
      };
    } catch (err) {
      const version = identity.factorioVersion ?? 'unknown';
      log.warn(
        `could not read bundled mods from ${image} (${(err as Error).message}); ` +
          `falling back to built-in knowledge for ${version}`,
      );
      profile = fallbackProfile(identity.id, version);
    }
    this.cache.set(identity.id, profile);
    return profile;
  }
}
