import type { ReactNode } from 'react';

/**
 * Dims its children and overlays a spinner while `busy`, so a long-running action
 * reads as "working" rather than as a frozen page. Blocking the host is the point:
 * mod downloads can take minutes, and leaving the controls live invites a second
 * click on top of the first.
 *
 * `label` is worth setting whenever the wait can outlast a user's patience — a bare
 * spinner says something is happening, not what.
 */
export function BusyOverlay({
  busy,
  label,
  className,
  onClick,
  children,
}: {
  busy: boolean;
  label?: string;
  className?: string;
  /** Pass-through so a host inside a clickable card can stop propagation. */
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className={`busy-host ${busy ? 'busy' : ''} ${className ?? ''}`.trim()} onClick={onClick}>
      {children}
      {busy && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <span className="spinner" />
          {label && <span className="busy-label">{label}</span>}
        </div>
      )}
    </div>
  );
}
