import { randomUUID } from 'node:crypto';
import { ModJobBusyError, NotFoundError } from '../lib/errors.js';

/** Which long download a job is running, for the UI's wording. */
export type ModJobKind = 'save' | 'apply' | 'apply-all' | 'update';

export type ModJobState = 'running' | 'done' | 'error';

export interface ModJob {
  id: string;
  kind: ModJobKind;
  /**
   * What the job holds while it runs, so a second one can't start on top of it:
   * `server:<id>` for anything downloading into one server, `modpack:<id>` for a
   * pack being pushed to every server using it.
   */
  key: string;
  /** The server being downloaded into right now (apply-all walks several). */
  serverId: string | null;
  state: ModJobState;
  /** Mods this job intends to download; 0 until the first progress report. */
  total: number;
  completed: number;
  /** Mod currently downloading, for "Downloading 3/12 — flib". */
  current: string | null;
  downloaded: { name: string; version: string }[];
  errors: { name: string; error: string }[];
  /** Set when the job itself failed, as opposed to individual mods failing. */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What the work function reports back as it goes. */
export interface ModJobProgress {
  (p: { current: string | null; completed: number; total: number }): void;
}

export interface ModJobResult {
  downloaded: { name: string; version: string }[];
  errors: { name: string; error: string }[];
}

/**
 * Runs mod downloads in the background and reports their progress.
 *
 * Downloading a large modpack takes minutes, and doing it inside the request meant
 * the whole app went unresponsive until it finished — the browser was still waiting
 * on that one response while the user tried to click anything else. So the request
 * now starts a job and returns immediately; the UI polls it and stays usable.
 *
 * Jobs live in memory only. They describe work in flight, not history: a restart
 * loses them, which is fine because the mod list and the zips on disk — the things
 * that actually matter — are written as the job runs, and re-saving is idempotent.
 */
export class ModJobService {
  private readonly jobs = new Map<string, ModJob>();

  /** @param retainMs how long a finished job stays pollable before being dropped. */
  constructor(private readonly retainMs = 10 * 60_000) {}

  /** The unfinished job holding `key`, if any. */
  activeFor(key: string): ModJob | undefined {
    return [...this.jobs.values()].find((j) => j.key === key && j.state === 'running');
  }

  /** Every job still worth showing — running, or recently finished. */
  list(): ModJob[] {
    this.prune();
    return [...this.jobs.values()];
  }

  get(id: string): ModJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundError('Mod job');
    return job;
  }

  /**
   * Start `run` in the background under `key`, refusing if that key is already
   * busy. Returns the job as it stands at that moment, so the caller can hand the
   * client an id to poll.
   */
  start(
    input: { kind: ModJobKind; key: string; serverId?: string | null; total?: number },
    run: (progress: ModJobProgress) => Promise<ModJobResult>,
  ): ModJob {
    if (this.activeFor(input.key)) throw new ModJobBusyError();
    this.prune();

    const job: ModJob = {
      id: randomUUID().slice(0, 8),
      kind: input.kind,
      key: input.key,
      serverId: input.serverId ?? null,
      state: 'running',
      total: input.total ?? 0,
      completed: 0,
      current: null,
      downloaded: [],
      errors: [],
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(job.id, job);

    const progress: ModJobProgress = (p) => {
      job.current = p.current;
      job.completed = p.completed;
      job.total = p.total;
    };

    // Deliberately not awaited: the caller responds now and the client polls.
    void (async () => {
      try {
        const result = await run(progress);
        job.downloaded = result.downloaded;
        job.errors = result.errors;
        job.state = 'done';
        job.completed = job.total;
      } catch (err) {
        job.state = 'error';
        job.error = (err as Error).message;
      } finally {
        job.current = null;
        job.finishedAt = new Date().toISOString();
      }
    })();

    return job;
  }

  /** Drop finished jobs nobody is going to poll for any more. */
  private prune(): void {
    const cutoff = Date.now() - this.retainMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/** The busy key for downloads landing in one server. */
export const serverKey = (serverId: string): string => `server:${serverId}`;
/** The busy key for a pack being applied to every server using it. */
export const modpackKey = (modpackId: string): string => `modpack:${modpackId}`;
