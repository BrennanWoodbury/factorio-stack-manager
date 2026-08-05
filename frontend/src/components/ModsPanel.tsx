import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ModEntry, ModProblem, Server } from '../types';
import { run, toastError, toastSuccess } from '../ui';
import { modJobServerKey, useModJob } from '../useModJob';
import { ModSearchBox } from './ModSearchBox';
import { ApplyModpack } from './ApplyModpack';

export function ModsPanel({ server }: { server: Server }) {
  const [mods, setMods] = useState<ModEntry[]>([]);
  const [problems, setProblems] = useState<ModProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Downloads run server-side as a job; this follows it instead of blocking the UI.
  const download = useModJob();
  // "Saving" covers the request; the job covers the download that outlives it.
  const busy = saving || download.busy;

  const load = useCallback(async () => {
    try {
      const r = await api.getMods(server.id);
      setMods(r.mods);
      setProblems((await api.getModProblems(server.id).catch(() => null))?.problems ?? []);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A download started before a reload (or in another tab) is still running on the
  // server — rejoin it so the button isn't offering to start a second one.
  useEffect(() => {
    void download.adopt(modJobServerKey(server.id)).then((done) => {
      if (done) void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt once per server
  }, [server.id]);

  const addByName = (name: string) => {
    if (!name || mods.some((m) => m.name === name)) return;
    setMods((m) => [...m, { name, enabled: true }]);
  };

  const save = async () => {
    setSaving(true);
    try {
      // The list is already saved when this resolves; only the zips are still coming.
      const r = await api.putMods(server.id, mods);
      setMods(r.mods);
      setProblems(r.problems ?? []);
      const done = await download.track(r.job);
      if (done.state === 'error') {
        toastError(done.error ?? 'Downloading mods failed');
      } else if (done.errors.length > 0) {
        toastError(`Some mods failed: ${done.errors.map((e) => `${e.name} (${e.error})`).join('; ')}`);
      } else {
        toastSuccess(
          done.downloaded.length > 0
            ? `Saved. Downloaded: ${done.downloaded.map((d) => `${d.name}@${d.version}`).join(', ')}`
            : 'Mod list saved',
        );
      }
      // Re-check now the zips are on disk: "not installed" clears only once they are.
      await load();
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
            disabled={busy}
            onClick={async () => {
              const r = await api.updateMods(server.id).catch((err) => {
                toastError((err as Error).message);
                return null;
              });
              if (!r) return;
              setMods(r.mods);
              const done = await download.track(r.job);
              if (done.state === 'error') {
                toastError(done.error ?? 'Updating mods failed');
              } else {
                toastSuccess(
                  done.downloaded.length
                    ? `Updated: ${done.downloaded.map((u) => `${u.name}@${u.version}`).join(', ')}`
                    : 'Nothing to update',
                );
              }
              await load();
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
          <button className="primary" disabled={busy} onClick={() => void run(save)}>
            {busy ? (download.label ?? 'Applying…') : 'Save & download'}
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <div
          className="small"
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 6,
            border: '1px solid var(--red)',
            background: 'rgba(229,83,60,0.10)',
          }}
        >
          <strong style={{ color: 'var(--red)' }}>
            This mod set won&apos;t load — the server will refuse to start:
          </strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {problems.map((p, i) => (
              <li key={`${p.mod}-${i}`}>
                <span className="mono">{p.mod}</span> — {p.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

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

      <ApplyModpack
        serverId={server.id}
        appliedModpackId={server.appliedModpackId}
        onApplied={load}
      />
    </div>
  );
}
