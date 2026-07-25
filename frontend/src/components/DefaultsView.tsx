import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { GlobalDefaults, MapGenTemplate, Modpack } from '../types';
import { run, toastError } from '../ui';

/**
 * Global server defaults — the "Server defaults" subsection of the Settings page.
 * The scalar settings (auto-restart + backup config) cascade: saving pushes the new
 * value to every server that hasn't overridden it. The default modpack / map template
 * are creation-time — applied to new servers only.
 */
export function DefaultsView() {
  const [d, setD] = useState<GlobalDefaults | null>(null);
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [templates, setTemplates] = useState<MapGenTemplate[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ defaults }, mp, tp] = await Promise.all([
        api.getGlobalDefaults(),
        api.listModpacks(),
        api.listMapGenTemplates(),
      ]);
      setD(defaults);
      setModpacks(mp.modpacks);
      setTemplates(tp.templates);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!d) return <div className="muted">Loading…</div>;

  const set = <K extends keyof GlobalDefaults>(k: K, v: GlobalDefaults[K]) => setD({ ...d, [k]: v });

  const save = async () => {
    setBusy(true);
    await run(
      () =>
        api.setGlobalDefaults({
          autoRestart: d.autoRestart,
          autoBackup: d.autoBackup,
          backupIntervalMinutes: d.backupIntervalMinutes,
          backupKeep: d.backupKeep,
          backupKeepManual: d.backupKeepManual,
          modpackId: d.modpackId,
          mapTemplateId: d.mapTemplateId,
        }),
      'Defaults saved — pushed to inheriting servers',
    );
    setBusy(false);
    await load();
  };

  return (
    <>
      <div className="panel">
        <div className="spread" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Server defaults</h2>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save defaults'}
          </button>
        </div>
        <div className="small muted" style={{ marginBottom: 16 }}>
          Defaults for every server. The settings below <strong>cascade</strong>: saving updates
          each server that hasn't overridden that setting (a server that overrode it keeps its own
          value until reset). New servers start out inheriting all of these.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={d.autoRestart}
            onChange={(e) => set('autoRestart', e.target.checked)}
          />
          Auto-restart on settings change
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={d.autoBackup}
            onChange={(e) => set('autoBackup', e.target.checked)}
          />
          Automatic backups
        </label>

        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <div>
            <label>Backup every (minutes)</label>
            <input
              type="number"
              min={5}
              style={{ width: 120 }}
              value={d.backupIntervalMinutes}
              onChange={(e) => set('backupIntervalMinutes', Number(e.target.value))}
            />
          </div>
          <div>
            <label>Keep auto (N)</label>
            <input
              type="number"
              min={1}
              style={{ width: 120 }}
              value={d.backupKeep}
              onChange={(e) => set('backupKeep', Number(e.target.value))}
            />
          </div>
          <div>
            <label>Keep manual (N)</label>
            <input
              type="number"
              min={1}
              style={{ width: 120 }}
              value={d.backupKeepManual}
              onChange={(e) => set('backupKeepManual', Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>New-server defaults</h3>
        <div className="small muted" style={{ marginBottom: 12 }}>
          Applied when a server is created (not retroactively). You can still change them per server
          in the create wizard.
        </div>
        <label>Default modpack</label>
        <select
          value={d.modpackId ?? ''}
          onChange={(e) => set('modpackId', e.target.value || null)}
          style={{ maxWidth: 320 }}
        >
          <option value="">None</option>
          {modpacks.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <label style={{ marginTop: 12 }}>Default world generation template</label>
        <select
          value={d.mapTemplateId ?? ''}
          onChange={(e) => set('mapTemplateId', e.target.value || null)}
          style={{ maxWidth: 320 }}
        >
          <option value="">None (game defaults)</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
