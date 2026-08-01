import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MapGenSettings } from '../types';
import { toastError, toastSuccess } from '../ui';
import { getPath, isModdedMode, previewPlanetsForMode, setPath } from './MapGenEditor';
import { ExperimentalNote } from './ExperimentalNote';

/**
 * Renders a map preview PNG for the given (unsaved) settings via a backend one-shot.
 * For Space Age, each planet (Nauvis, Vulcanus, Fulgora, …) can be previewed; the world
 * seed is held in the settings so every planet shows the same world. Click the image to
 * expand.
 *
 * The seed input box lives here so the preview and the seed stay in lockstep: whatever
 * seed a render uses is written back into the box (via `onChange`), and whatever the box
 * holds is what the next render uses.
 */
export function MapPreview({
  serverId,
  mapGen,
  onChange,
  mode = 'vanilla',
}: {
  serverId: string;
  mapGen: MapGenSettings;
  onChange: (v: MapGenSettings) => void;
  mode?: string;
}) {
  const planets = previewPlanetsForMode(mode);
  const [planet, setPlanet] = useState('nauvis');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);

  const seedRaw = getPath(mapGen, ['seed']);
  const seed = typeof seedRaw === 'number' ? String(seedRaw) : '';

  // Revoke the previous object URL whenever it changes / on unmount.
  useEffect(() => {
    urlRef.current = url;
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [url]);

  const setSeed = (value: number | null) => onChange(setPath(mapGen, ['seed'], value));

  const generate = async (which: string, opts?: { reroll?: boolean }) => {
    setBusy(true);
    // Reroll always mints a fresh seed; otherwise reuse the box value, and only pick a
    // random one when the box is empty. Either way we render with an explicit seed and
    // write it back, so the box always shows the seed the preview actually used.
    const current = typeof seedRaw === 'number' ? seedRaw : undefined;
    const effective =
      opts?.reroll || current === undefined ? Math.floor(Math.random() * 2 ** 31) : current;
    if (effective !== current) setSeed(effective);
    try {
      const blob = await api.previewMap(serverId, { mapGen, planet: which, seed: effective, size: 1024 });
      setUrl(URL.createObjectURL(blob));
      setPlanet(which);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copySeed = async () => {
    try {
      await navigator.clipboard.writeText(seed);
      toastSuccess('Copied seed to clipboard');
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  const activeLabel = planets.find((p) => p.key === planet)?.label ?? 'Nauvis';

  return (
    <div style={{ marginBottom: 12 }}>
      <label className="small">Map seed (blank = random)</label>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <input
          type="number"
          value={seed}
          placeholder="random"
          onChange={(e) => {
            const val = e.target.value.trim();
            setSeed(val === '' ? null : Number(val));
          }}
        />
        <button type="button" className="small" disabled={!seed} onClick={() => void copySeed()}>
          Copy seed
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={busy}
          onClick={() => void generate(planet, { reroll: true })}
        >
          🎲 Reroll seed
        </button>
      </div>

      {planets.length > 1 && (
        <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {planets.map((p) => (
            <button
              key={p.key}
              className={p.key === planet ? 'primary small' : 'ghost small'}
              disabled={busy}
              onClick={() => void generate(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <button disabled={busy} onClick={() => void generate(planet)}>
          {busy ? 'Rendering…' : url ? 'Refresh preview' : 'Preview map'}
        </button>
        <span className="small muted">{activeLabel} · renders your current (unsaved) settings</span>
      </div>

      {isModdedMode(mode) && (
        <ExperimentalNote style={{ marginTop: 8 }}>
          Previews render with this server's mods loaded — some mod sets won't render.
        </ExperimentalNote>
      )}

      {url && (
        <div style={{ marginTop: 10 }}>
          <img
            src={url}
            alt="Map preview"
            title="Click to expand"
            onClick={() => setExpanded(true)}
            style={{
              width: 260,
              height: 260,
              objectFit: 'cover',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              cursor: 'zoom-in',
              imageRendering: 'pixelated',
            }}
          />
        </div>
      )}

      {expanded && url && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            cursor: 'zoom-out',
            padding: 24,
          }}
        >
          <img
            src={url}
            alt="Map preview (expanded)"
            style={{ maxWidth: '95vw', maxHeight: '95vh', imageRendering: 'pixelated', borderRadius: 8 }}
          />
        </div>
      )}
    </div>
  );
}
