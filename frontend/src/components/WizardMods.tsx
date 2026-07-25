import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api';
import type { ModEntry } from '../types';
import { toastError, toastSuccess } from '../ui';
import { ModSearchBox } from './ModSearchBox';
import { ApplyModpack } from './ApplyModpack';

/** Imperative handle so the wizard can force a save (e.g. before finalizing a draft). */
export interface WizardModsHandle {
  save: () => Promise<void>;
}

/**
 * Mods stage for the new-server wizard (Generate flow). A trimmed mod editor pointed at
 * the draft: apply a saved modpack, and/or search + add from the portal, toggle/remove,
 * then "Save & download" writes the mod-list and pulls the zips into the draft's dir — so
 * the Test & Create probe boots with the real mod set. `onSaved` lets the wizard record
 * the chosen mods on the draft, and `onDirtyChange` reports whether local edits (adds,
 * removes, toggles) haven't been saved & downloaded yet, so the wizard can prompt before
 * creating.
 *
 * A draft is a server row as far as the mod endpoints are concerned, so applying a
 * modpack here downloads into the draft's own dir exactly as it would for a real server.
 */
export const WizardMods = forwardRef<
  WizardModsHandle,
  {
    draftId: string;
    onSaved?: (mods: ModEntry[]) => void;
    onDirtyChange?: (dirty: boolean) => void;
  }
>(function WizardMods({ draftId, onSaved, onDirtyChange }, ref) {
  const [mods, setMods] = useState<ModEntry[]>([]);
  const [saving, setSaving] = useState(false);
  // Last mod list actually saved & downloaded, so we can tell whether `mods` has drifted
  // from it (added/removed/toggled without hitting "Save & download").
  const savedRef = useRef<ModEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const { mods: current } = await api.getMods(draftId);
      setMods(current);
      savedRef.current = current;
      return current;
    } catch {
      /* draft may have no mod list yet */
      return undefined;
    }
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(JSON.stringify(mods) !== JSON.stringify(savedRef.current));
  }, [mods, onDirtyChange]);

  const addByName = (name: string) => {
    if (!name || mods.some((m) => m.name === name)) return;
    setMods((m) => [...m, { name, enabled: true }]);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.putMods(draftId, mods);
      setMods(r.mods);
      savedRef.current = r.mods;
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
      throw err;
    } finally {
      setSaving(false);
    }
  };

  useImperativeHandle(ref, () => ({ save }));

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

      {/* Applying writes and downloads server-side, so the draft is already saved —
          hence onSaved here too, without the user pressing Save & download. */}
      <ApplyModpack
        serverId={draftId}
        onApplied={() => {
          void load().then((applied) => applied && onSaved?.(applied));
        }}
      />
      <div className="small muted" style={{ marginTop: 10 }}>
        Added mods need <strong>Save &amp; download</strong> before they're included in the test.
      </div>
    </div>
  );
});
