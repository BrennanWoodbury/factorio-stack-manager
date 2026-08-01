import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ModpackDetail as Detail, ModpackMod } from '../types';
import { ModSearchBox } from './ModSearchBox';
import { run, toastError, toastSuccess } from '../ui';
import { useModJob } from '../useModJob';

/** Edit a shared modpack: rename, edit its mod list, re-apply to servers, export. */
export function ModpackDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mods, setMods] = useState<ModpackMod[]>([]);
  const [saving, setSaving] = useState(false);
  // Re-applying downloads into every server using the pack — a job, not a request.
  const reapply = useModJob();

  const load = useCallback(async () => {
    try {
      const d = await api.getModpack(id);
      setDetail(d);
      setName(d.pack.name);
      setDescription(d.pack.description);
      setMods(d.mods);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) return <div className="muted">Loading…</div>;

  const addMod = (modName: string) => {
    if (mods.some((m) => m.name === modName)) return;
    setMods((m) => [...m, { name: modName, enabled: true, version: null }]);
  };

  const saveMeta = async () => {
    await run(() => api.updateModpack(id, { name, description }), 'Modpack saved');
    await load();
  };

  const saveMods = async () => {
    setSaving(true);
    await run(async () => {
      await api.setModpackMods(id, mods);
    }, 'Mod list saved');
    setSaving(false);
    await load();
  };

  const reapplyAll = async () => {
    if (detail.usedBy.length === 0) return;
    const servers = detail.usedBy.length;
    try {
      const { job } = await api.applyModpackToAll(id);
      const done = await reapply.track(job);
      if (done.state === 'error') toastError(done.error ?? 'Re-applying failed');
      else if (done.errors.length) toastError(`Re-applied with some errors (${done.errors.length})`);
      else toastSuccess(`Re-applied to ${servers} server(s)`);
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  return (
    <>
      <button className="ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Back to modpacks
      </button>

      <div className="panel">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Modpack</h2>
          <a href={api.exportModpackUrl(id)}>
            <button>Export manifest</button>
          </a>
        </div>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Description</label>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void saveMeta()}>
            Save details
          </button>
        </div>

        {detail.usedBy.length > 0 && (
          <div className="small muted" style={{ marginTop: 14 }}>
            Used by {detail.usedBy.map((s) => s.name).join(', ')}.{' '}
            <button
              className="ghost small"
              disabled={reapply.busy}
              onClick={() => void reapplyAll()}
            >
              {reapply.busy
                ? (reapply.label ?? 'Re-applying…')
                : `Re-apply to all (${detail.usedBy.length})`}
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Mods ({mods.length})</h2>
          <button className="primary" disabled={saving} onClick={() => void saveMods()}>
            {saving ? 'Saving…' : 'Save mod list'}
          </button>
        </div>

        {mods.length === 0 && <div className="small muted">No mods yet — search below to add.</div>}

        {mods.length > 0 && (
          <table>
            <tbody>
              {mods.map((m, i) => (
                <tr key={m.name}>
                  <td className="mono">
                    {m.name}
                    {m.version && <span className="small muted"> · pinned v{m.version}</span>}
                  </td>
                  <td style={{ width: 90 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={m.enabled}
                        onChange={(e) =>
                          setMods((cur) =>
                            cur.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)),
                          )
                        }
                      />
                      enabled
                    </label>
                  </td>
                  <td style={{ width: 60 }}>
                    <button
                      className="danger ghost"
                      onClick={() => setMods((cur) => cur.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <ModSearchBox onAdd={addMod} installed={mods.map((m) => m.name)} />
        </div>
      </div>
    </>
  );
}
