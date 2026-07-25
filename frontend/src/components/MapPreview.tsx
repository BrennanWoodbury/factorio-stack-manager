import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MapGenSettings } from '../types';
import { toastError } from '../ui';
import { isModdedMode, previewPlanetsForMode } from './MapGenEditor';
import { ExperimentalNote } from './ExperimentalNote';

/**
 * Renders a map preview PNG for the given (unsaved) settings via a backend one-shot.
 * For Space Age, each planet (Nauvis, Vulcanus, Fulgora, …) can be previewed; the world
 * seed is held across planets so they show the same world. Click the image to expand;
 * "Reroll" previews a fresh random seed.
 */
export function MapPreview({
  serverId,
  mapGen,
  mode = 'vanilla',
}: {
  serverId: string;
  mapGen: MapGenSettings;
  mode?: string;
}) {
  const planets = previewPlanetsForMode(mode);
  const [planet, setPlanet] = useState('nauvis');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);
  const seedRef = useRef<number | undefined>(undefined);

  // Revoke the previous object URL whenever it changes / on unmount.
  useEffect(() => {
    urlRef.current = url;
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [url]);

  const generate = async (which: string, seed?: number) => {
    setBusy(true);
    if (seed !== undefined) seedRef.current = seed;
    try {
      const blob = await api.previewMap(serverId, { mapGen, planet: which, seed: seedRef.current, size: 1024 });
      setUrl(URL.createObjectURL(blob));
      setPlanet(which);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = planets.find((p) => p.key === planet)?.label ?? 'Nauvis';

  return (
    <div style={{ marginBottom: 12 }}>
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
        {url && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => void generate(planet, Math.floor(Math.random() * 2 ** 31))}
          >
            🎲 Reroll seed
          </button>
        )}
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
