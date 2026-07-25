import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { run, toastError, toastSuccess } from '../ui';

type Settings = Record<string, unknown>;

/**
 * The global default advanced server-settings. Every server inherits these unless it
 * overrides a field on its own Advanced settings. Typed controls for the common
 * fields plus a raw-JSON escape hatch.
 */
export function GlobalAdvancedSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setS((await api.getGlobalAdvancedSettings()).settings);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!s) return null;

  const set = (k: string, v: unknown) => setS((cur) => ({ ...(cur ?? {}), [k]: v }));
  const num = (k: string, f = 0) => (typeof s[k] === 'number' ? (s[k] as number) : f);
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
  const visibility = (s.visibility ?? {}) as { public?: boolean; lan?: boolean };

  const save = async () => {
    setSaving(true);
    const ok = await run(async () => setS((await api.setGlobalAdvancedSettings(s)).settings), 'Global advanced settings saved');
    setSaving(false);
    if (!ok) return;
    // These settings are baked into server-settings.json only at (re)start, so
    // offer to restart already-running servers rather than leaving them stale
    // until they happen to restart on their own.
    try {
      const { count } = await api.getRunningCount();
      if (count > 0) setConfirmRestart(true);
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  const restartNow = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      const { restarted, failed } = await api.restartRunning();
      if (restarted.length > 0) toastSuccess(`Restarted ${restarted.length} server(s)`);
      if (failed.length > 0) toastError(`${failed.length} server(s) failed to restart`);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Default advanced server settings</h2>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 4, marginBottom: 12 }}>
          Every server inherits these unless it overrides the field on its own Advanced settings.
        </div>

        <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={visibility.public === true} onChange={(e) => set('visibility', { ...visibility, public: e.target.checked })} />
            Public
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={visibility.lan !== false} onChange={(e) => set('visibility', { ...visibility, lan: e.target.checked })} />
            LAN
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={s.require_user_verification === true} onChange={(e) => set('require_user_verification', e.target.checked)} />
            Require factorio.com verification
          </label>
        </div>

        <div className="row" style={{ marginTop: 8, gap: 20, flexWrap: 'wrap' }}>
          <div>
            <label>Allow commands</label>
            <select value={str('allow_commands') || 'admins-only'} onChange={(e) => set('allow_commands', e.target.value)}>
              <option value="true">true (anyone)</option>
              <option value="false">false (nobody)</option>
              <option value="admins-only">admins-only</option>
            </select>
          </div>
          <div>
            <label>Autosave interval (min)</label>
            <input type="number" min={1} style={{ width: 110 }} value={num('autosave_interval', 10)} onChange={(e) => set('autosave_interval', Number(e.target.value))} />
          </div>
          <div>
            <label>Autosave slots</label>
            <input type="number" min={1} style={{ width: 110 }} value={num('autosave_slots', 5)} onChange={(e) => set('autosave_slots', Number(e.target.value))} />
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 20, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={s.auto_pause !== false} onChange={(e) => set('auto_pause', e.target.checked)} />
            Auto-pause when empty
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={s.non_blocking_saving !== false} onChange={(e) => set('non_blocking_saving', e.target.checked)} />
            Non-blocking saving
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          {!rawOpen ? (
            <button className="ghost small" onClick={() => { setRawText(JSON.stringify(s, null, 2)); setRawError(null); setRawOpen(true); }}>
              Edit as raw JSON…
            </button>
          ) : (
            <div>
              <textarea className="mono" rows={12} value={rawText} onChange={(e) => setRawText(e.target.value)} />
              {rawError && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{rawError}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    try {
                      const p = JSON.parse(rawText);
                      if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('Must be a JSON object');
                      setS(p);
                      setRawOpen(false);
                      setRawError(null);
                    } catch (err) {
                      setRawError((err as Error).message);
                    }
                  }}
                >
                  Apply to form
                </button>
                <button className="ghost" onClick={() => setRawOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmRestart && (
        <ConfirmDialog
          title="Restart running servers?"
          danger={false}
          confirmLabel={restarting ? 'Restarting…' : 'Restart now'}
          cancelLabel="Not now"
          body="These settings only take effect the next time a server (re)starts. Restart every currently running server now to apply them?"
          onConfirm={() => void restartNow()}
          onCancel={() => setConfirmRestart(false)}
        />
      )}
    </>
  );
}
