import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ModEntry } from '../types';
import { toastError, toastSuccess } from '../ui';
import { ModSearchBox } from './ModSearchBox';

/**
 * Mods stage for the new-server wizard (Generate flow). A trimmed mod editor pointed at
 * the draft: search + add from the portal, toggle/remove, then "Save & download" writes
 * the mod-list and pulls the zips into the draft's dir — so the Test & Create probe boots
 * with the real mod set. `onSaved` lets the wizard record the chosen mods on the draft.
 */
export function WizardMods({
  draftId,
  onSaved,
}: {
  draftId: string;
  onSaved?: (mods: ModEntry[]) => void;
}) {
  const [mods, setMods] = useState<ModEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setMods((await api.getMods(draftId)).mods);
    } catch {
      /* draft may have no mod list yet */
    }
  }, [draftId]);

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
      const r = await api.putMods(draftId, mods);
      setMods(r.mods);
      onSaved?.(r.mods);
      if (r.errors.length > 0) {
        toastError(`Some mods failed: ${r.errors.map((e) => `${e.name} (${e.error})`).join('; ')}`);
      } else {
        toastSuccess(
          r.downloaded.length > 0
            ? `Saved. Downloaded: ${r.downloaded.map((d) => `${d.name}@${d.version}`).join(', ')}`
            : 'Mods saved',
        );
      }
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="small muted">
          Enabled mods download via the global Factorio.com account (Settings).
        </span>
        <button className="primary small" disabled={saving} onClick={() => void save()}>
          {saving ? 'Downloading…' : 'Save & download'}
        </button>
      </div>

      {mods.length > 0 && (
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
                        setMods((cur) => cur.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))
                      }
                    />
                    enabled
                  </label>
                </td>
                <td style={{ width: 50 }}>
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
      )}

      <div style={{ marginTop: 12 }}>
        <ModSearchBox onAdd={addByName} installed={mods.map((m) => m.name)} />
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        Added mods need <strong>Save &amp; download</strong> before they're included in the test.
      </div>
    </div>
  );
}
