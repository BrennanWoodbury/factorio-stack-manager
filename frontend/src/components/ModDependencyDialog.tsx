import { useState } from 'react';
import type { DependencyResolution, ResolvedDependency } from '../types';

/**
 * Approve/cancel gate for adding a mod that pulls in other mods.
 *
 * Required dependencies are listed but not selectable — the mod cannot load
 * without them, so opting out would only produce a server that fails to start.
 * Optional ones are checkboxes, pre-ticked for `+` dependencies because that is
 * what the game itself does. Nothing is added unless the user confirms.
 */
export function ModDependencyDialog({
  resolution,
  onConfirm,
  onCancel,
}: {
  resolution: DependencyResolution;
  /** Every mod name to add, the requested one first. */
  onConfirm: (names: string[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(resolution.optional.filter((d) => d.defaultEnabled).map((d) => d.name)),
  );

  const toggle = (name: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const names = [
    resolution.name,
    ...resolution.required.map((d) => d.name),
    ...resolution.optional.filter((d) => picked.has(d.name)).map((d) => d.name),
  ];
  const conflicts = resolution.incompatible.filter((d) => d.installed);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
      }}
      onClick={onCancel}
    >
      <div
        className="panel"
        style={{ width: 560, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', margin: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Add {resolution.title}</h3>

        {resolution.required.length > 0 && (
          <Section
            title={`Requires ${resolution.required.length} other mod${resolution.required.length === 1 ? '' : 's'}`}
            hint="Added together — the mod won't load without them."
          >
            {resolution.required.map((d) => (
              <DepRow key={d.name} dep={d} showVia={d.via !== resolution.name} />
            ))}
          </Section>
        )}

        {resolution.optional.length > 0 && (
          <Section title="Optional" hint="Tick any you also want.">
            {resolution.optional.map((d) => (
              <label
                key={d.name}
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: 0 }}
              >
                <input
                  type="checkbox"
                  style={{ width: 'auto', marginTop: 3 }}
                  checked={picked.has(d.name)}
                  onChange={() => toggle(d.name)}
                />
                <DepRow dep={d} showVia={false} />
              </label>
            ))}
          </Section>
        )}

        {conflicts.length > 0 && (
          <Section title="Conflicts with mods you already have" tone="danger">
            {conflicts.map((d) => (
              <div key={d.name} className="small">
                <strong>{d.title}</strong> <span className="mono muted">{d.name}</span> — cannot be
                enabled at the same time.
              </div>
            ))}
          </Section>
        )}

        {/* Overhaul mods list dozens of these (Space Exploration: 50). None are
            installed, so name a few and count the rest rather than filling the
            dialog with mods the user has never heard of. */}
        {resolution.incompatible.length > conflicts.length && (
          <div className="small muted" style={{ marginBottom: 12 }}>
            Also incompatible with {summarise(resolution.incompatible.filter((d) => !d.installed))}.
          </div>
        )}

        {resolution.missing.length > 0 && (
          <Section title="Not found on the mod portal" tone="danger">
            <div className="small">
              {resolution.missing.join(', ')} — add these yourself if the mod needs them.
            </div>
          </Section>
        )}

        {resolution.truncated && (
          <div className="small muted" style={{ marginBottom: 12 }}>
            This mod has an unusually deep dependency tree; the list above may be incomplete.
          </div>
        )}

        {resolution.satisfied.length > 0 && (
          <div className="small muted" style={{ marginBottom: 12 }}>
            Already covered: {resolution.satisfied.join(', ')}.
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={() => onConfirm(names)} autoFocus>
            Add {names.length} mod{names.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "a, b, c and 47 others" — a long list of names that are only informational. */
function summarise(deps: ResolvedDependency[], shown = 4): string {
  const names = deps.map((d) => d.name);
  if (names.length <= shown + 1) return names.join(', ');
  const rest = names.length - shown;
  return `${names.slice(0, shown).join(', ')} and ${rest} others`;
}

function Section({
  title,
  hint,
  tone,
  children,
}: {
  title: string;
  hint?: string;
  tone?: 'danger';
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="small" style={{ color: tone === 'danger' ? 'var(--red)' : undefined }}>
        <strong>{title}</strong>
      </div>
      {hint && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          {hint}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {children}
      </div>
    </div>
  );
}

function DepRow({ dep, showVia }: { dep: ResolvedDependency; showVia: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="small">
        <strong>{dep.title}</strong> <span className="mono muted">{dep.name}</span>
        {dep.constraint && <span className="small muted"> {dep.constraint}</span>}
      </div>
      {showVia && <div className="small muted">needed by {dep.via}</div>}
      {dep.summary && (
        <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {dep.summary}
        </div>
      )}
    </div>
  );
}
