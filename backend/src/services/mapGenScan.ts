import AdmZip from 'adm-zip';

/**
 * Finds mods that shape the world from `control.lua` rather than from prototypes.
 *
 * `--generate-map-preview` renders the data stage: prototypes, autoplace controls and
 * noise expressions. That covers most terrain and ore mods (Alien Biomes, Krastorio,
 * Bob's ores), and since previews load the server's mods those now render truthfully.
 *
 * It does not cover mods that let the map generate normally and then rewrite it at
 * runtime — RSO deleting and re-placing every ore patch on chunk generation, maze mods
 * carving terrain in `on_chunk_generated`, mods conjuring surfaces with `create_surface`.
 * For those the preview is the "before" picture and no amount of mod loading fixes it,
 * because the rewrite happens after the world starts ticking.
 *
 * So we detect them and say so, rather than showing a confident picture that lies.
 *
 * This is a heuristic on Lua source, deliberately biased toward false positives: a mod
 * naming one of these APIs in a branch it never takes gets flagged, which costs the user
 * a sentence of caution. Missing a real one costs them a world they didn't choose.
 */

/** A runtime API whose use means the rendered world is not the played world. */
interface Marker {
  /** Matched as a whole word against Lua source. */
  api: string;
  /** What the user is told this mod does. */
  effect: string;
}

const MARKERS: readonly Marker[] = [
  { api: 'on_chunk_generated', effect: 'rewrites chunks as they generate' },
  { api: 'create_surface', effect: 'creates surfaces at runtime' },
  { api: 'set_tiles', effect: 'rewrites terrain tiles' },
  { api: 'regenerate_entity', effect: 're-rolls resource placement' },
  { api: 'set_chunk_generated_status', effect: 'forces chunks to regenerate' },
];

/** Lua files above this are assets or data tables, not control logic worth scanning. */
const MAX_FILE_BYTES = 2_000_000;
/** Ceiling on how much of one mod we read, so a huge pack can't stall the request. */
const MAX_MOD_BYTES = 16_000_000;

export interface RuntimeMapGenMod {
  name: string;
  version: string;
  /** Human-readable effects, de-duplicated, in MARKERS order. */
  effects: string[];
}

/**
 * Which markers appear in a chunk of Lua source. Whole-word matched so `set_tiles`
 * doesn't fire on `offset_tiles` and `create_surface` doesn't fire on a field named
 * `recreate_surfaces`.
 */
export function scanLuaSource(source: string): string[] {
  const hits: string[] = [];
  for (const { api } of MARKERS) {
    if (new RegExp(`\\b${api}\\b`).test(source)) hits.push(api);
  }
  return hits;
}

/** Turn matched API names into the effect sentences shown to the user. */
export function effectsFor(apis: readonly string[]): string[] {
  return MARKERS.filter((m) => apis.includes(m.api)).map((m) => m.effect);
}

/**
 * Scan every `.lua` file in a mod zip. Mods split their logic across `scripts/`, not
 * just `control.lua`, so restricting this to the entry point would miss most of them.
 * Returns the matched API names, empty when the mod is prototype-only.
 */
export function scanModZip(data: Buffer): string[] {
  const found = new Set<string>();
  let budget = MAX_MOD_BYTES;
  for (const entry of new AdmZip(data).getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.lua')) continue;
    const size = entry.header.size;
    if (size > MAX_FILE_BYTES) continue;
    if (budget - size < 0) break;
    budget -= size;
    for (const api of scanLuaSource(entry.getData().toString('utf8'))) found.add(api);
  }
  return MARKERS.filter((m) => found.has(m.api)).map((m) => m.api);
}
