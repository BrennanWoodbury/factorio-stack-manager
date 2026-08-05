import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ModJob } from './types';

/** Job keys as the backend forms them (see modJobService). */
export const modJobServerKey = (serverId: string) => `server:${serverId}`;
export const modJobModpackKey = (modpackId: string) => `modpack:${modpackId}`;

/** How often a running job is polled. Fast enough to feel live, cheap enough to ignore. */
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows a mod download running on the server.
 *
 * Mod downloads used to happen inside the request, so a big modpack froze the whole
 * UI for however long the portal took — the button greyed out and nothing else
 * responded. Now the request returns a job, and this hook polls it: the caller
 * awaits `track` exactly as it used to await the download, but the page stays alive
 * and can say which mod is downloading and how far along it is.
 *
 * `adopt` picks up a job started elsewhere (another tab, or this one before a
 * reload), so a refresh mid-download shows progress instead of an idle button.
 */
export function useModJob() {
  const [job, setJob] = useState<ModJob | null>(null);
  // Polling outlives the component when a user navigates away mid-download, so
  // every state write is gated on the component still being mounted.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Poll `started` to completion, returning the finished job. */
  const track = useCallback(async (started: ModJob): Promise<ModJob> => {
    let current = started;
    if (mounted.current) setJob(current);
    while (current.state === 'running') {
      await sleep(POLL_MS);
      try {
        current = (await api.getModJob(current.id)).job;
      } catch {
        // A job that can't be polled any more (server restart, pruned) is not worth
        // reporting as a mod failure — stop watching and let the caller refresh.
        break;
      }
      if (mounted.current) setJob(current);
    }
    if (mounted.current) setJob(current.state === 'running' ? null : current);
    return current;
  }, []);

  /**
   * Rejoin a download already in flight for `key`, if there is one. Resolves to the
   * finished job, or null when nothing was running.
   */
  const adopt = useCallback(
    async (key: string): Promise<ModJob | null> => {
      const running = await api
        .listModJobs(key)
        .then((r) => r.jobs.find((j) => j.state === 'running'))
        .catch(() => undefined);
      return running ? track(running) : null;
    },
    [track],
  );

  const busy = job?.state === 'running';

  return {
    job,
    busy,
    track,
    adopt,
    /** "Downloading 3/12 — flib", or null when there is nothing to say. */
    label: busy ? progressLabel(job) : null,
  };
}

function progressLabel(job: ModJob | null): string | null {
  if (!job) return null;
  const counted = job.total > 0 ? ` ${job.completed + 1}/${job.total}` : '';
  return `Downloading${counted}${job.current ? ` — ${job.current}` : '…'}`;
}
