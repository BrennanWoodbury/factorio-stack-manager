import type { AppConfig } from '../config.js';
import { compareVersions } from '../services/modCompat.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('update-check');

/** Local hour (0-23) the nightly recheck fires at. */
const NIGHTLY_HOUR = 3;

/** Milliseconds from now until the next occurrence of `hour:00` local time. */
function msUntilNextRun(hour: number): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

/**
 * Whether `latest` should be flagged as an update over `current`. "dev" (an
 * untagged local build) has nothing meaningful to compare against.
 */
export function isUpdateAvailable(current: string, latest: string | undefined): boolean {
  return current !== 'dev' && !!latest && compareVersions(latest, current) > 0;
}

/**
 * Update-check job. Asks GitHub for the latest release once at startup and again
 * every night at {@link NIGHTLY_HOUR} local time, so a long-running instance
 * eventually notices a new tag without needing a restart. Read-only: it never
 * pulls an image or touches a container, just informs the dashboard.
 */
export class UpdateCheckJob {
  private timer?: NodeJS.Timeout;
  private latestVersion?: string;
  private releaseUrl?: string;
  private lastChecked?: string;
  private lastError?: string;

  constructor(private readonly config: AppConfig) {}

  async runOnce(): Promise<void> {
    this.lastChecked = new Date().toISOString();
    try {
      const res = await fetch(
        `https://api.github.com/repos/${this.config.updateCheckRepo}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'factorio-stack-manager' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
      const release = (await res.json()) as GithubRelease;
      this.latestVersion = release.tag_name.replace(/^v/, '');
      this.releaseUrl = release.html_url;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn(`check failed: ${this.lastError}`);
    }
  }

  start(): void {
    if (!this.config.updateCheckEnabled) {
      log.info('disabled (UPDATE_CHECK_ENABLED=false)');
      return;
    }
    if (this.timer) return;
    void this.runOnce();
    this.scheduleNext();
    log.info(`started (nightly at ${NIGHTLY_HOUR}:00 local time)`);
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.runOnce();
      this.scheduleNext();
    }, msUntilNextRun(NIGHTLY_HOUR));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  status() {
    return {
      enabled: this.config.updateCheckEnabled,
      latestVersion: this.latestVersion,
      url: this.releaseUrl,
      updateAvailable: isUpdateAvailable(this.config.appVersion, this.latestVersion),
      lastChecked: this.lastChecked,
      lastError: this.lastError,
    };
  }
}
