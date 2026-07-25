import type { ServerManager } from '../services/serverManager.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('backup');

/**
 * Scheduled-backup job. Wakes up on a fixed tick and asks the manager to back up
 * any auto-backup server whose interval has elapsed. Per-server interval/retention
 * live on the server row; this only provides the clock.
 */
export class BackupJob {
  private timer?: NodeJS.Timeout;
  private readonly tickMs = 60_000; // check once a minute

  constructor(private readonly manager: ServerManager) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.manager
        .runDueBackups()
        .catch((err) => log.warn(`tick failed: ${(err as Error).message}`));
    }, this.tickMs);
    log.info('scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
