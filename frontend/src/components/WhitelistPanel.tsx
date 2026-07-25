import { useCallback, useEffect, useState } from 'react';
import { run, toastError } from '../ui';

/**
 * Reusable Factorio user-list editor: one text input per username, a button to add
 * another entry, and a per-row remove. Used for whitelist and admin-list settings;
 * the parent supplies the labels and load/save calls.
 */
export function WhitelistPanel({
  title,
  description,
  load,
  save,
  addLabel = 'Add user to whitelist',
  saveLabel = 'Save whitelist',
  hint,
}: {
  title: string;
  description?: string;
  load: () => Promise<string[]>;
  save: (names: string[]) => Promise<string[]>;
  addLabel?: string;
  saveLabel?: string;
  /** Footer text given the current count; defaults to whitelist wording. */
  hint?: (count: number) => string;
}) {
  // Keep at least one (empty) row so there's always something to type into.
  const [rows, setRows] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false);

  const hydrate = useCallback(async () => {
    try {
      const names = await load();
      setRows(names.length > 0 ? names : ['']);
    } catch (err) {
      toastError((err as Error).message);
    }
    // load identity is stable enough for our use (defined inline by parent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const setAt = (i: number, v: string) =>
    setRows((r) => r.map((x, j) => (j === i ? v : x)));
  const removeAt = (i: number) =>
    setRows((r) => {
      const next = r.filter((_, j) => j !== i);
      return next.length > 0 ? next : [''];
    });
  const add = () => setRows((r) => [...r, '']);

  const onSave = async () => {
    setSaving(true);
    const cleaned = rows.map((s) => s.trim()).filter(Boolean);
    await run(async () => {
      const saved = await save(cleaned);
      setRows(saved.length > 0 ? saved : ['']);
    }, `${title} saved`);
    setSaving(false);
  };

  const count = rows.map((s) => s.trim()).filter(Boolean).length;

  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button className="primary" disabled={saving} onClick={() => void onSave()}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
      {description && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          {description}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((name, i) => (
          <div key={i} className="row" style={{ alignItems: 'center' }}>
            <input
              className="grow mono"
              placeholder="Factorio username"
              value={name}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <button
              className="danger ghost"
              title="Remove"
              onClick={() => removeAt(i)}
              style={{ flex: '0 0 auto' }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
        <button onClick={add}>{addLabel}</button>
        <span className="small muted">
          {hint
            ? hint(count)
            : count === 0
              ? 'Empty = whitelist off (everyone may join).'
              : `${count} player${count === 1 ? '' : 's'} whitelisted.`}
        </span>
      </div>
    </div>
  );
}
