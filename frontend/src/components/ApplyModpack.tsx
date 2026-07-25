import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Modpack } from '../types';
import { toastError, toastSuccess } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';

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
  const [confirmMissing, setConfirmMissing] = useState<string[] | null>(null);

  useEffect(() => {
    void api
      .listModpacks()
      .then((r) => setPacks(r.modpacks))
      .catch(() => {});
  }, []);

  const applied = packs.find((p) => p.id === appliedModpackId);

  /**
   * Ask before applying when mods would have to be fetched. Applying writes the
   * mod list and only then downloads, so a failure part-way leaves a server whose
   * list names mods it doesn't have — worth a question rather than a surprise.
   */
  const start = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { missing } = await api.planModpack(selected, serverId);
      if (missing.length > 0) {
        setConfirmMissing(missing);
        return;
      }
      await apply();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.applyModpack(selected, serverId);
      if (r.errors.length > 0) {
        // The reason, not just the count: "applied with errors" over a list of
        // names is what left a broken mod set with nothing to act on.
        toastError(
          `Applied, but ${r.errors.length} mod(s) failed to download — ` +
            r.errors.map((e) => `${e.name}: ${e.error}`).join('; '),
        );
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
        <button className="primary" disabled={!selected || busy} onClick={() => void start()}>
          {busy ? 'Applying…' : 'Apply & download'}
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Applying replaces the mod list with the pack's, then downloads the mods. Takes effect on
        next start.
      </div>

      {confirmMissing && (
        <ConfirmDialog
          title="Download missing mods?"
          danger={false}
          confirmLabel="Download & apply"
          body={
            <>
              {confirmMissing.length} mod(s) in this pack aren&apos;t downloaded yet:{' '}
              <span className="mono">{confirmMissing.join(', ')}</span>. They&apos;ll be fetched
              from the mod portal now.
            </>
          }
          onCancel={() => {
            setConfirmMissing(null);
            toastError(
              `Modpack not applied — ${confirmMissing.length} mod(s) still need downloading.`,
            );
          }}
          onConfirm={() => {
            setConfirmMissing(null);
            void apply();
          }}
        />
      )}
    </div>
  );
}
