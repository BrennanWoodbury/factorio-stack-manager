import { useState } from 'react';
import { api } from '../api';
import { run } from '../ui';
import { BusyOverlay } from './BusyOverlay';

/**
 * Start / Stop / Restart controls for a server, shown depending on its running
 * state. While an action is in flight the buttons are disabled and a spinner is
 * overlaid on top of them. Safe to place inside a clickable card — button clicks
 * stop propagation.
 */
export function LifecycleControls({
  id,
  running,
  onChanged,
  small,
}: {
  id: string;
  running: boolean;
  onChanged?: () => void | Promise<void>;
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const act = async (e: React.MouseEvent, fn: () => Promise<unknown>, okMsg: string) => {
    e.stopPropagation();
    setBusy(true);
    await run(fn, okMsg);
    await onChanged?.();
    setBusy(false);
  };

  const cls = small ? 'small' : '';

  return (
    <BusyOverlay busy={busy} className="lifecycle" onClick={(e) => e.stopPropagation()}>
      {running ? (
        <>
          <button
            className={cls}
            disabled={busy}
            onClick={(e) => act(e, () => api.restart(id), 'Restarted')}
          >
            Restart
          </button>
          <button
            className={cls}
            disabled={busy}
            onClick={(e) => act(e, () => api.stop(id), 'Stopped')}
          >
            Stop
          </button>
        </>
      ) : (
        <button
          className={`primary ${cls}`}
          disabled={busy}
          onClick={(e) => act(e, () => api.start(id), 'Started')}
        >
          Start
        </button>
      )}
    </BusyOverlay>
  );
}
