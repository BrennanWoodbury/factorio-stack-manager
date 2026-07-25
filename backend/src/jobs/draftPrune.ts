import type { ServerManager } from '../services/serverManager.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('draft');

/**
 * Draft-pruning job. Sweeps new-server wizard drafts whose 24h TTL has passed
 * (row + on-disk dir). Coarse timing is fine — a draft lingering a few extra
 * minutes past expiry costs nothing.
 */
export class DraftPruneJob {
  private timer?: NodeJS.Timeout;
  private readonly tickMs = 15 * 60_000; // every 15 minutes

  constructor(private readonly manager: ServerManager) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      try {
        this.manager.pruneDrafts();
      } catch (err) {
        log.warn(`prune tick failed: ${(err as Error).message}`);
      }
    };
    tick(); // sweep once at startup (clears drafts abandoned before a restart)
    this.timer = setInterval(tick, this.tickMs);
    log.info('prune scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
