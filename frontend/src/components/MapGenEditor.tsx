import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { MapGenSettings, MapGenTemplate } from '../types';
import { run, toastError } from '../ui';
import { ExperimentalNote } from './ExperimentalNote';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- tiny immutable path helpers over the raw settings object ----

export function getPath(obj: any, path: (string | number)[]): any {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj: any, path: (string | number)[], value: any): any {
  const [k, ...rest] = path;
  const clone: any = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) };
  clone[k] = rest.length ? setPath(clone[k], rest, value) : value;
  return clone;
}

/** Qualitative label for a frequency/size/richness multiplier (matches the game's feel). */
export function levelLabel(v: number): string {
  if (v <= 0) return 'None';
  if (v < 0.5) return 'Very low';
  if (v < 0.95) return 'Low';
  if (v <= 1.05) return 'Normal';
  if (v <= 2.5) return 'High';
  return 'Very high';
}

function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 6,
  step = 0.05,
  showLevel = true,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showLevel?: boolean;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginBottom: 10, opacity: disabled ? 0.45 : 1 }}>
      <div className="spread" style={{ marginBottom: 2 }}>
        <span className="small">{label}</span>
        <span className="small muted mono">
          ×{value.toFixed(2)}
          {showLevel ? ` · ${levelLabel(value)}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}

/** A titled, bordered, tinted box grouping one thing's sliders (e.g. one ore). */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--panel-2)',
        borderRadius: 'var(--radius)',
        padding: '12px 14px',
        marginBottom: 12,
      }}
    >
      <div className="mono" style={{ fontWeight: 600, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

type Ctrl = { key: string; label: string; richness?: boolean };
type Planet = { key: string; label: string; controls: Ctrl[] };

// Curated Space Age control schema (from --dump-data): each planet's autoplace
// controls, keyed by their globally-unique names. Vanilla shows only Nauvis.
const PLANETS: Planet[] = [
  {
    key: 'nauvis',
    label: 'Nauvis',
    controls: [
      { key: 'iron-ore', label: 'Iron ore', richness: true },
      { key: 'copper-ore', label: 'Copper ore', richness: true },
      { key: 'coal', label: 'Coal', richness: true },
      { key: 'stone', label: 'Stone', richness: true },
      { key: 'uranium-ore', label: 'Uranium ore', richness: true },
      { key: 'crude-oil', label: 'Oil', richness: true },
      { key: 'water', label: 'Water' },
      { key: 'trees', label: 'Trees' },
      { key: 'enemy-base', label: 'Enemy bases' },
    ],
  },
  {
    key: 'vulcanus',
    label: 'Vulcanus',
    controls: [
      { key: 'tungsten_ore', label: 'Tungsten', richness: true },
      { key: 'calcite', label: 'Calcite', richness: true },
      { key: 'vulcanus_coal', label: 'Coal', richness: true },
      { key: 'sulfuric_acid_geyser', label: 'Sulfuric acid', richness: true },
    ],
  },
  {
    key: 'gleba',
    label: 'Gleba',
    controls: [
      { key: 'gleba_stone', label: 'Stone', richness: true },
      { key: 'gleba_plants', label: 'Plants' },
      { key: 'gleba_water', label: 'Water' },
      { key: 'gleba_enemy_base', label: 'Enemy bases' },
    ],
  },
  {
    key: 'fulgora',
    label: 'Fulgora',
    controls: [
      { key: 'scrap', label: 'Scrap', richness: true },
      { key: 'fulgora_islands', label: 'Islands' },
    ],
  },
  {
    key: 'aquilo',
    label: 'Aquilo',
    controls: [
      { key: 'aquilo_crude_oil', label: 'Oil', richness: true },
      { key: 'lithium_brine', label: 'Lithium brine', richness: true },
      { key: 'fluorine_vent', label: 'Fluorine vent', richness: true },
    ],
  },
];

/** Any mode whose mod set — a modpack, or an uploaded save — owns the mod list. */
export function isModdedMode(mode: string): boolean {
  return mode.startsWith('modded');
}

function planetsForMode(mode: string): Planet[] {
  if (mode === 'vanilla' || mode === 'modded_vanilla') {
    return PLANETS.filter((p) => p.key === 'nauvis');
  }
  return PLANETS; // space_age (+ no-quality, + modded) — same planets
}

/**
 * Planets that can be previewed for a mode: Nauvis for vanilla, all Space Age planets
 * for SA and for mods sitting on top of it. A bare "Modded" is Nauvis-only, because
 * without a named base we can't know a pack's surfaces.
 */
export function previewPlanetsForMode(mode: string): { key: string; label: string }[] {
  if (mode === 'modded') return [{ key: 'nauvis', label: 'Nauvis' }];
  return planetsForMode(mode).map((p) => ({ key: p.key, label: p.label }));
}

/** Turn an autoplace-control name into a readable label (e.g. tungsten_ore → Tungsten ore). */
function prettify(key: string): string {
  const s = key.replace(/[-_]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Modded: derive the control list dynamically from whatever's in the settings. */
function dynamicControls(value: MapGenSettings): Ctrl[] {
  const ac = (value.autoplace_controls as Record<string, any>) ?? {};
  return Object.entries(ac).map(([key, v]) => ({
    key,
    label: prettify(key),
    richness: !!v && typeof v === 'object' && 'richness' in v,
  }));
}

/**
 * Controlled editor for a map-gen-settings object, presented as the in-game
 * map-generation sliders, grouped per planet according to the game mode. The parent
 * owns persistence — this only reads `value` and emits `onChange`.
 */
/**
 * Whether two settings objects mean the same thing. Compared through a
 * key-sorted serialisation rather than `JSON.stringify` alone, because the same
 * settings arrive with different key order depending on where they came from —
 * the template endpoint, a resumed draft, or the editor's own writes.
 */
export function sameSettings(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  // Distinct tokens: JSON.stringify renders undefined as undefined, which would
  // otherwise make it indistinguishable from null.
  if (v === undefined) return '?';
  if (v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v) as string;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`;
}

// The seed is deliberately absent here: it belongs to an individual server, not to a
// reusable template or the slider set, so it's owned by <MapPreview> (which renders the
// seed box in the server contexts) and never stored on a template.
export function MapGenEditor({
  value,
  onChange,
  showTemplates = true,
  mode = 'space_age',
}: {
  value: MapGenSettings;
  onChange: (v: MapGenSettings) => void;
  showTemplates?: boolean;
  mode?: string;
}) {
  const [templates, setTemplates] = useState<MapGenTemplate[]>([]);
  const [bulk, setBulk] = useState(false);
  // Which template is currently loaded, and what it looked like when it was — so
  // the picker can name it, and say when the sliders have since moved away from it.
  const [loaded, setLoaded] = useState<{ id: string; snapshot: string } | null>(null);
  // Settings often arrive with no record of where they came from: a resumed wizard
  // draft, or the global default template applied at creation. Recognising them
  // means the picker names the template instead of claiming none is loaded.
  const derived = useMemo(() => {
    if (loaded) return null;
    const match = templates.find((t) => sameSettings(t.settings, value));
    return match ? { id: match.id, snapshot: JSON.stringify(match.settings) } : null;
  }, [loaded, templates, value]);
  const current = loaded ?? derived;

  const loadTemplates = useCallback(async () => {
    if (!showTemplates) return;
    try {
      setTemplates((await api.listMapGenTemplates()).templates);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [showTemplates]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const modded = mode === 'modded';
  const planets = modded ? [] : planetsForMode(mode);
  const modCtrls = modded ? dynamicControls(value) : [];
  // Every resource control (richness-bearing) shown, for the "set all" master.
  const resourceKeys = modded
    ? modCtrls.filter((c) => c.richness).map((c) => c.key)
    : planets.flatMap((p) => p.controls.filter((c) => c.richness).map((c) => c.key));

  const g = (path: (string | number)[], dflt = 1): number => {
    const v = getPath(value, path);
    return typeof v === 'number' ? v : dflt;
  };
  const sg = (path: (string | number)[], v: number | boolean | null) => onChange(setPath(value, path, v));
  const control = (key: string, field: 'frequency' | 'size' | 'richness') =>
    g(['autoplace_controls', key, field]);
  const setControl = (key: string, field: 'frequency' | 'size' | 'richness', v: number) =>
    sg(['autoplace_controls', key, field], v);

  const setAllResources = (field: 'frequency' | 'size' | 'richness', v: number) => {
    let next = value;
    for (const k of resourceKeys) next = setPath(next, ['autoplace_controls', k, field], v);
    onChange(next);
  };
  const toggleBulk = (on: boolean) => {
    setBulk(on);
    if (!on || resourceKeys.length === 0) return;
    let next = value;
    for (const field of ['frequency', 'size', 'richness'] as const) {
      const v = control(resourceKeys[0], field);
      for (const k of resourceKeys) next = setPath(next, ['autoplace_controls', k, field], v);
    }
    onChange(next);
  };

  const cliffInterval = g(['cliff_settings', 'cliff_elevation_interval'], 40);
  const cliffFreq = cliffInterval > 0 ? 40 / cliffInterval : 0;
  const cliffRichness = g(['cliff_settings', 'richness']);
  const setCliffFreq = (freq: number) =>
    onChange(setPath(value, ['cliff_settings', 'cliff_elevation_interval'], freq > 0 ? 40 / freq : 40));

  const peaceful = getPath(value, ['peaceful_mode']) === true;

  const applyTemplate = async (id: string) => {
    if (!id) {
      setLoaded(null);
      return;
    }
    try {
      const t = await api.getMapGenTemplate(id);
      onChange(t.settings);
      setLoaded({ id, snapshot: JSON.stringify(t.settings) });
    } catch (err) {
      // Leave the picker showing whatever is really loaded, not the failed pick.
      toastError((err as Error).message);
    }
  };
  const saveAsTemplate = async () => {
    const name = prompt('Save current settings as a template named:');
    if (!name?.trim()) return;
    const ok = await run(
      () => api.createMapGenTemplate({ name: name.trim(), settings: value }),
      `Saved template "${name.trim()}"`,
    );
    if (ok) await loadTemplates();
  };

  // Settings have been edited since the template was loaded. Compared by value
  // because every edit path rebuilds the object rather than mutating it.
  const drifted = current !== null && !sameSettings(value, JSON.parse(current.snapshot));

  const controlSliders = (c: Ctrl) => (
    <Group key={c.key} title={c.label}>
      <Slider
        label="Frequency"
        disabled={bulk && !!c.richness}
        value={control(c.key, 'frequency')}
        onChange={(v) => setControl(c.key, 'frequency', v)}
      />
      <Slider
        label={c.key.includes('water') ? 'Coverage' : 'Size'}
        disabled={bulk && !!c.richness}
        value={control(c.key, 'size')}
        onChange={(v) => setControl(c.key, 'size', v)}
      />
      {c.richness && (
        <Slider
          label="Richness"
          disabled={bulk}
          value={control(c.key, 'richness')}
          onChange={(v) => setControl(c.key, 'richness', v)}
        />
      )}
    </Group>
  );

  return (
    <div>
      {showTemplates && (
        <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <select
            aria-label="World generation template"
            value={current?.id ?? ''}
            onChange={(e) => void applyTemplate(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">Load a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {/* Re-selecting the same option fires no change event, so an explicit
              reload is the only way back to the template once sliders have moved. */}
          {current && drifted && (
            <>
              <span className="small muted">modified</span>
              <button type="button" className="small ghost" onClick={() => void applyTemplate(current.id)}>
                Reload
              </button>
            </>
          )}
          <button type="button" className="small" onClick={() => void saveAsTemplate()}>
            Save as template
          </button>
        </div>
      )}

      {/* Master control: when checked, every resource inherits these values. */}
      <Group title="All resources">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: bulk ? 12 : 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={bulk} onChange={(e) => toggleBulk(e.target.checked)} />
          Set values for every resource at once
        </label>
        {resourceKeys.length > 0 && (
          <>
            <Slider label="Frequency" disabled={!bulk} value={control(resourceKeys[0], 'frequency')} onChange={(v) => setAllResources('frequency', v)} />
            <Slider label="Size" disabled={!bulk} value={control(resourceKeys[0], 'size')} onChange={(v) => setAllResources('size', v)} />
            <Slider label="Richness" disabled={!bulk} value={control(resourceKeys[0], 'richness')} onChange={(v) => setAllResources('richness', v)} />
          </>
        )}
      </Group>

      {!modded &&
        planets.map((p) => (
          <div key={p.key} style={{ marginBottom: 6 }}>
            {planets.length > 1 && <h3 style={{ margin: '4px 0 10px' }}>{p.label}</h3>}
            {p.controls.map(controlSliders)}
          </div>
        ))}

      {modded &&
        (modCtrls.length > 0 ? (
          <>
            <h3 style={{ margin: '4px 0 10px' }}>Resources &amp; terrain (from this server's mods)</h3>
            <ExperimentalNote style={{ marginBottom: 10 }}>
              Detected from your mods — controls a mod adds at runtime may be missing.
            </ExperimentalNote>
            {modCtrls.map(controlSliders)}
          </>
        ) : (
          <div className="small muted" style={{ marginBottom: 12 }}>
            No resources detected yet — use <strong>Detect resources from mods</strong> above (or
            import an exchange string) to load this modpack's controls.
          </div>
        ))}

      <h3 style={{ marginBottom: 12 }}>Global</h3>
      <Group title="Cliffs">
        <Slider label="Frequency" value={cliffFreq} onChange={setCliffFreq} />
        <Slider label="Continuity" value={cliffRichness} max={10} onChange={(v) => sg(['cliff_settings', 'richness'], v)} />
      </Group>
      <Group title="Starting area">
        <Slider label="Size" value={g(['starting_area'])} onChange={(v) => sg(['starting_area'], v)} />
      </Group>
      <Group title="World options">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={peaceful} onChange={(e) => sg(['peaceful_mode'], e.target.checked)} />
          Peaceful mode (enemies don't attack unless provoked)
        </label>
      </Group>
    </div>
  );
}
