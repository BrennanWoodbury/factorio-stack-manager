import fs from 'node:fs';
import zlib from 'node:zlib';
import { KNOWN_BUNDLED_MODS } from './imageProfile.js';

/**
 * Reads what a Factorio save needs — game version, scenario and full mod list —
 * straight out of the save file, without booting Factorio.
 *
 * This exists because the boot log can't tell us: a headless server handed a save
 * whose mods are missing does NOT error. It silently drops them, hosts the game and
 * reports success, so there is nothing to parse and the world comes up gutted. The
 * save's own header is authoritative, available before any container starts, and
 * carries the exact mod versions the world was built with.
 */

export interface SaveMod {
  name: string;
  version: string;
}

export interface SaveHeader {
  /** Factorio version that wrote the save, e.g. "2.0.77". */
  gameVersion: string;
  /** Scenario/level name, e.g. "freeplay". */
  scenario: string;
  /** Every mod recorded in the save, including `base` and the bundled expansions. */
  mods: SaveMod[];
}

/* ------------------------------------------------------------------ *
 * Zip access
 *
 * adm-zip (already a dependency) throws DESCRIPTOR_FAULTY on Factorio saves:
 * entries are written with a streaming data descriptor (general-purpose flag
 * bit 3), so the local header's crc and sizes are zero and its integrity check
 * rejects them. The central directory always holds the true values, so we read
 * from there and inflate the raw deflate stream ourselves.
 * ------------------------------------------------------------------ */

function readZipEntry(zipPath: string, match: (name: string) => boolean): Buffer | null {
  const buf = fs.readFileSync(zipPath);

  // End of central directory record — scan back from the end (comment may follow).
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('malformed zip central directory');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (match(name)) {
      // The local header repeats name/extra with possibly different lengths.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Header decoding
 * ------------------------------------------------------------------ */

interface Cursor {
  p: number;
}

/** Factorio "space optimized" uint: one byte, or 0xFF then a LE uint32. */
function optUint(b: Buffer, o: Cursor): number {
  if (o.p >= b.length) throw new Error('truncated');
  const v = b[o.p++];
  if (v !== 0xff) return v;
  if (o.p + 4 > b.length) throw new Error('truncated');
  const full = b.readUInt32LE(o.p);
  o.p += 4;
  return full;
}

/** Length-prefixed string (length is an optimized uint). */
function readString(b: Buffer, o: Cursor): string {
  const len = optUint(b, o);
  if (o.p + len > b.length) throw new Error('truncated');
  const s = b.toString('utf8', o.p, o.p + len);
  o.p += len;
  return s;
}

const MOD_NAME_RE = /^[A-Za-z0-9_\-. ]{1,100}$/;

/**
 * Attempt to decode the mod list at `pos`. Returns null unless the whole run
 * decodes cleanly — that validation is what lets us recover if the fixed-size
 * block before it ever changes width.
 */
function tryModList(b: Buffer, pos: number): SaveMod[] | null {
  try {
    const o: Cursor = { p: pos };
    const count = optUint(b, o);
    if (count < 1 || count > 500) return null;
    const mods: SaveMod[] = [];
    for (let i = 0; i < count; i++) {
      const name = readString(b, o);
      if (!MOD_NAME_RE.test(name)) return null;
      const version = [optUint(b, o), optUint(b, o), optUint(b, o)].join('.');
      o.p += 4; // crc32
      if (o.p > b.length) return null;
      mods.push({ name, version });
    }
    // Every save records `base`; its absence means we decoded from the wrong offset.
    if (!mods.some((m) => m.name === 'base')) return null;
    return mods;
  } catch {
    return null;
  }
}

/**
 * Decode a save's `level-init.dat` header.
 *
 * Layout (Factorio 2.0.x), little-endian throughout:
 *   u16 x4   version (main, major, minor, patch)
 *   u8       flag
 *   string   campaign      ("")
 *   string   level name    ("freeplay")
 *   string   base mod name ("base")
 *   ...      fixed scenario/difficulty/replay fields — 20 bytes on 2.0.77
 *   optUint  mod count
 *   per mod: string name, optUint x3 version, u32 crc
 *
 * The scenario strings are variable-length, so we walk them rather than seeking to
 * a constant. The fixed block afterwards is the one field whose width could shift
 * between Factorio releases, so instead of trusting it we validate the decode and
 * scan a bounded window for an offset that parses — a version bump costs a few
 * failed attempts instead of silently yielding garbage.
 */
export function parseSaveHeader(dat: Buffer): SaveHeader {
  if (dat.length < 16) throw new Error('save header is truncated');

  const gameVersion = [dat.readUInt16LE(0), dat.readUInt16LE(2), dat.readUInt16LE(4)].join('.');

  const o: Cursor = { p: 8 };
  o.p += 1; // flag
  readString(dat, o); // campaign
  const scenario = readString(dat, o); // level name
  readString(dat, o); // base mod name

  const expected = o.p + 20;
  const candidates = [expected, ...Array.from({ length: 64 }, (_, i) => o.p + i)];
  for (const pos of candidates) {
    if (pos >= dat.length) continue;
    const mods = tryModList(dat, pos);
    if (mods) return { gameVersion, scenario, mods };
  }
  throw new Error('could not locate the mod list in the save header');
}

/** Read a save file's header off disk. */
export function readSaveHeader(savePath: string): SaveHeader {
  const dat = readZipEntry(savePath, (n) => n === 'level-init.dat' || n.endsWith('/level-init.dat'));
  if (!dat) throw new Error('not a Factorio save (no level-init.dat)');
  return parseSaveHeader(dat);
}

/**
 * The mods a save needs that must come from the mod portal — everything except
 * `base` and the expansion mods bundled in the image (those are enabled through
 * mod-list.json instead).
 *
 * `bundled` defaults to the cross-version superset. Callers holding an
 * `ImageProfile` should pass its mod names, so a save from a newer Factorio isn't
 * sent to the portal for a mod that release started shipping (2.1's `recycler`).
 */
export function portalModsFor(
  header: SaveHeader,
  bundled: ReadonlySet<string> = KNOWN_BUNDLED_MODS,
): SaveMod[] {
  return header.mods.filter((m) => !bundled.has(m.name));
}

/** The bundled expansion mods a save uses, e.g. ["space-age","quality"]. */
export function bundledModsFor(
  header: SaveHeader,
  bundled: ReadonlySet<string> = KNOWN_BUNDLED_MODS,
): string[] {
  return header.mods.filter((m) => m.name !== 'base' && bundled.has(m.name)).map((m) => m.name);
}

/**
 * The game mode a server built from this save should run as.
 *
 * Always one of the "+ mods" modes: the save's own header dictates its mod set, so
 * the mode must not enforce a bundled set of its own. Which one it is says whether
 * the world sits on Space Age or plain Nauvis — that's what the map-gen sliders and
 * the planet list read, and what the user sees named in the UI.
 */
export function gameModeForSave(header: SaveHeader): 'modded_vanilla' | 'modded_space_age' {
  return header.mods.some((m) => m.name === 'space-age') ? 'modded_space_age' : 'modded_vanilla';
}
