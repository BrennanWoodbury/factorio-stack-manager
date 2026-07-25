import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Modpack } from '../types';
import { toastError, toastSuccess } from '../ui';

/**
 * Apply a shared modpack to a server or to a new-server wizard draft — both are
 * server rows as far as the API is concerned, so this takes an id rather than a
 * whole Server, which a draft doesn't have.
 */
export function ApplyModpack({
  serverId,
  appliedModpackId,
  onApplied,
}: {
  serverId: string;
  /** Shown as "currently applied" when known; a draft doesn't track it. */
  appliedModpackId?: string | null;
  onApplied: () => void;
}) {
  const [packs, setPacks] = useState<Modpack[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .listModpacks()
      .then((r) => setPacks(r.modpacks))
      .catch(() => {});
  }, []);

  const applied = packs.find((p) => p.id === appliedModpackId);

  const apply = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.applyModpack(selected, serverId);
      if (r.errors.length > 0) {
        toastError(`Applied with errors: ${r.errors.map((e) => e.name).join(', ')}`);
      } else {
        toastSuccess(`Applied modpack (${r.downloaded.length} mods downloaded)`);
      }
      onApplied();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (packs.length === 0) return null;

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="spread">
        <div>
          <strong>Apply a shared modpack</strong>
          {applied && (
            <span className="small muted" style={{ marginLeft: 8 }}>
              currently applied: <span className="badge running">{applied.name}</span>
            </span>
          )}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <select className="grow" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a modpack…</option>
          {packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.modCount} mods)
            </option>
          ))}
        </select>
        <button className="primary" disabled={!selected || busy} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply & download'}
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Applying replaces the mod list with the pack's, then downloads the mods. Takes effect on
        next start.
      </div>
    </div>
  );
}
