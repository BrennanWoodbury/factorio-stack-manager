import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MapGenSettings, MapGenTemplate } from '../types';
import { run, toastError } from '../ui';
import { MapGenEditor } from './MapGenEditor';

type Draft = { id: string | null; name: string; description: string; settings: MapGenSettings };

export function MapGenTemplatesView() {
  const [templates, setTemplates] = useState<MapGenTemplate[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api.listMapGenTemplates()).templates);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = async () => {
    try {
      const { settings } = await api.mapGenDefaults();
      setDraft({ id: null, name: '', description: '', settings });
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  const startEdit = async (id: string) => {
    try {
      const t = await api.getMapGenTemplate(id);
      setDraft({ id: t.id, name: t.name, description: t.description, settings: t.settings });
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  const saveDraft = async () => {
    if (!draft || !draft.name.trim()) {
      toastError('Template name is required');
      return;
    }
    setBusy(true);
    const ok = await run(
      () =>
        draft.id
          ? api.updateMapGenTemplate(draft.id, {
              name: draft.name.trim(),
              description: draft.description,
              settings: draft.settings,
            })
          : api.createMapGenTemplate({
              name: draft.name.trim(),
              description: draft.description,
              settings: draft.settings,
            }),
      draft.id ? 'Template saved' : 'Template created',
    );
    setBusy(false);
    if (ok) {
      setDraft(null);
      await load();
    }
  };

  const remove = async (t: MapGenTemplate) => {
    if (!confirm(`Delete template "${t.name}"?`)) return;
    const ok = await run(() => api.deleteMapGenTemplate(t.id), 'Template deleted');
    if (ok) await load();
  };

  const importFile = async (file: File) => {
    try {
      const manifest = JSON.parse(await file.text());
      const ok = await run(() => api.importMapGenTemplate(manifest), 'Template imported');
      if (ok) await load();
    } catch {
      toastError('Not a valid template JSON file');
    }
  };

  return (
    <>
      <div className="panel">
        <div className="spread">
          <div>
            <h2 style={{ margin: 0 }}>World Generation Templates</h2>
            <div className="small muted" style={{ marginTop: 4 }}>
              Reusable world-generation presets (terrain, resources, enemies). Pick one when
              creating a server, or save the current settings from a server's Map gen tab. Export
              to share; import a shared JSON.
            </div>
          </div>
          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
            <button className="ghost" onClick={() => fileRef.current?.click()}>
              Import JSON
            </button>
            <button className="primary" onClick={() => void startNew()}>
              + New template
            </button>
          </div>
        </div>
      </div>

      {draft && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>{draft.id ? 'Edit template' : 'New template'}</h3>
          <label>Name *</label>
          <input
            value={draft.name}
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <label>Description</label>
          <textarea
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <div style={{ marginTop: 12 }}>
            <MapGenEditor
              value={draft.settings}
              onChange={(settings) => setDraft({ ...draft, settings })}
              showTemplates={false}
            />
          </div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={() => void saveDraft()}>
              {busy ? 'Saving…' : draft.id ? 'Save template' : 'Create template'}
            </button>
          </div>
        </div>
      )}

      {templates.length === 0 && !draft && (
        <div className="panel muted small">No templates yet. Create one, or import a shared JSON.</div>
      )}

      {templates.map((t) => (
        <div key={t.id} className="panel">
          <div className="spread">
            <div>
              <strong>{t.name}</strong>
              {t.description && (
                <div className="small muted" style={{ marginTop: 2 }}>
                  {t.description}
                </div>
              )}
            </div>
            <div className="row">
              <button className="small" onClick={() => void startEdit(t.id)}>
                Edit
              </button>
              <a href={api.exportMapGenTemplateUrl(t.id)}>
                <button className="small">Export</button>
              </a>
              <button className="danger small" onClick={() => void remove(t)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
