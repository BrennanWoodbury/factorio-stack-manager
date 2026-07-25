import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ModEntry, Server } from '../types';
import { run, toastError, toastSuccess } from '../ui';
import { ModSearchBox } from './ModSearchBox';
import { ApplyModpack } from './ApplyModpack';

export function ModsPanel({ server }: { server: Server }) {
  const [mods, setMods] = useState<ModEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getMods(server.id);
      setMods(r.mods);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const addByName = (name: string) => {
    if (!name || mods.some((m) => m.name === name)) return;
    setMods((m) => [...m, { name, enabled: true }]);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.putMods(server.id, mods);
      setMods(r.mods);
      if (r.errors.length > 0) {
        toastError(`Some mods failed: ${r.errors.map((e) => `${e.name} (${e.error})`).join('; ')}`);
      } else {
        toastSuccess(
          r.downloaded.length > 0
            ? `Saved. Downloaded: ${r.downloaded.map((d) => `${d.name}@${d.version}`).join(', ')}`
            : 'Mod list saved',
        );
      }
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Mods</h2>
        <div className="row">
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const ok = await run(() => api.uploadMod(server.id, f), 'Mod uploaded');
              if (ok) await load();
            }}
          />
          <button onClick={() => fileRef.current?.click()} title="Upload a mod .zip">
            Upload .zip
          </button>
          <button
            onClick={async () => {
              const r = await api.updateMods(server.id).catch((err) => {
                toastError((err as Error).message);
                return null;
              });
              if (r) {
                setMods(r.mods);
                toastSuccess(
                  r.updated.length
                    ? `Updated: ${r.updated.map((u) => `${u.name}@${u.version}`).join(', ')}`
                    : 'Nothing to update',
                );
              }
            }}
            title="Re-download the latest release of every enabled mod"
          >
            Update all
          </button>
          <a href={api.exportModsUrl(server.id)}>
            <button title="Download a shareable manifest">Export</button>
          </a>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Remove ALL mods (reset to base only)?')) return;
              const r = await api.deleteAllMods(server.id).catch((err) => {
                toastError((err as Error).message);
                return null;
              });
              if (r) {
                setMods(r.mods);
                toastSuccess('All mods removed');
              }
            }}
          >
            Delete all
          </button>
          <button className="primary" disabled={saving} onClick={() => void run(save)}>
            {saving ? 'Applying…' : 'Save & download'}
          </button>
        </div>
      </div>

      {!server.hasFactorioCredentials && (
        <div className="small muted" style={{ marginBottom: 10 }}>
          No global Factorio.com account set (Servers dashboard → Factorio.com account). You can still
          edit the list, but enabled mods can't be downloaded until it's provided. Restart the server
          to apply changes.
        </div>
      )}

      <table>
        <tbody>
          {mods.map((m, i) => (
            <tr key={m.name}>
              <td className="mono">
                {m.name}
                {m.name === 'base' && <span className="small muted"> (required)</span>}
              </td>
              <td style={{ width: 90 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={m.enabled}
                    disabled={m.name === 'base'}
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
                {m.name !== 'base' && (
                  <button
                    className="danger ghost"
                    onClick={() => setMods((cur) => cur.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <ModSearchBox onAdd={addByName} installed={mods.map((m) => m.name)} />
      </div>

      <div className="small muted" style={{ marginTop: 12 }}>
        Added mods still need <strong>Save &amp; download</strong> above, then take effect on the
        next server start/restart.
      </div>

      <ApplyModpack server={server} onApplied={load} />
    </div>
  );
}
