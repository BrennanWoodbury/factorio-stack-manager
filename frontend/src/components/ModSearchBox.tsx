import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CatalogEntry, DependencyResolution } from '../types';
import { toastError } from '../ui';
import { ModDependencyDialog } from './ModDependencyDialog';

function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * Debounced Factorio Mod Portal search box with a results list. Reused by the
 * per-server Mods tab, the new-server wizard and the modpack editor.
 *
 * Add resolves the mod's dependencies first. When it needs nothing the user
 * doesn't already have, it is added straight away; otherwise a dialog lists what
 * would come with it and `onAdd` fires once per mod only after approval.
 */
export function ModSearchBox({
  onAdd,
  installed,
}: {
  onAdd: (name: string) => void;
  /** Names already in the caller's list — drives "Added" and dependency pruning. */
  installed: string[];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState<string>();
  const [pending, setPending] = useState<DependencyResolution>();
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const isAdded = (name: string) => installed.includes(name);

  /**
   * Resolve, then either add outright or open the dialog. A resolve failure (the
   * portal being down, say) must not block adding the mod itself, so it falls
   * back to the old behaviour with a warning.
   */
  const add = async (name: string) => {
    setResolving(name);
    try {
      const r = await api.resolveModDependencies(name, installed);
      const needsApproval =
        r.required.length > 0 ||
        r.optional.length > 0 ||
        r.missing.length > 0 ||
        r.incompatible.some((d) => d.installed);
      if (needsApproval) setPending(r);
      else onAdd(name);
    } catch (err) {
      toastError(`Couldn't check dependencies: ${(err as Error).message}`);
      onAdd(name);
    } finally {
      setResolving(undefined);
    }
  };

  useEffect(() => {
    clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        const r = await api.searchMods(query);
        setResults(r.results);
      } catch (err) {
        toastError((err as Error).message);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [query]);

  return (
    <div>
      <label style={{ marginTop: 0 }}>Search the mod portal</label>
      <input
        placeholder="e.g. space exploration, bob, logistics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching && <div className="small muted" style={{ marginTop: 8 }}>Searching…</div>}

      {results.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map((r) => {
            const added = isAdded(r.name);
            return (
              <div
                key={r.name}
                className="spread"
                style={{
                  alignItems: 'flex-start',
                  background: 'var(--panel-2)',
                  borderRadius: 6,
                  padding: '10px 12px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div>
                    <strong>{r.title}</strong> <span className="small muted">by {r.owner}</span>
                  </div>
                  <div className="small mono muted">{r.name}</div>
                  {r.summary && (
                    <div
                      className="small muted"
                      style={{
                        marginTop: 4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {r.summary}
                    </div>
                  )}
                  <div className="small muted" style={{ marginTop: 4 }}>
                    ⬇ {fmtDownloads(r.downloadsCount)}
                    {r.latestVersion ? ` · v${r.latestVersion}` : ''}
                    {r.factorioVersion ? ` · Factorio ${r.factorioVersion}` : ''}
                  </div>
                </div>
                <button disabled={added || resolving !== undefined} onClick={() => void add(r.name)}>
                  {added ? 'Added' : resolving === r.name ? 'Checking…' : 'Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>
          No matching mods.
        </div>
      )}

      {pending && (
        <ModDependencyDialog
          resolution={pending}
          onCancel={() => setPending(undefined)}
          onConfirm={(names) => {
            setPending(undefined);
            // One call per mod: the callers own their own list state, and each
            // already ignores names it holds.
            for (const name of names) onAdd(name);
          }}
        />
      )}
    </div>
  );
}
