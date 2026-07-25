import type { DnsService } from '../services/dnsService.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('ddns');

/**
 * Dynamic-DNS job. On an interval it asks an external "what's my IP" service for
 * the host's current public IP and, if it changed, updates the single shared
 * `host.<base>` A record. Every server's SRV record targets that name, so one
 * update follows the WAN IP for all servers at once.
 *
 * Interval and IP-check URL come from the DB-backed DNS settings, so `reschedule()`
 * (called after the settings change) restarts the job with current values and
 * starts/stops it as DNS is enabled/disabled.
 */
export class DdnsJob {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastError?: string;
  private lastIp?: string;
  private lastCheck?: string;

  constructor(private readonly dns: DnsService) {}

  private async detectPublicIp(): Promise<string> {
    const { ipCheckUrl } = this.dns.settings();
    const res = await fetch(ipCheckUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`IP check returned HTTP ${res.status}`);
    const text = (await res.text()).trim();
    // Accept a bare IPv4 (api.ipify.org default response).
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
      throw new Error(`Unexpected IP check response: ${text.slice(0, 64)}`);
    }
    return text;
  }

  async runOnce(): Promise<void> {
    if (!this.dns.enabled) return;
    this.lastCheck = new Date().toISOString();
    try {
      const ip = await this.detectPublicIp();
      const changed = await this.dns.ensureHostARecord(ip);
      this.lastIp = ip;
      this.lastError = undefined;
      if (changed) log.info(`updated host A record → ${ip}`);
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn(`check failed: ${this.lastError}`);
    }
  }

  start(): void {
    if (!this.dns.enabled) {
      log.info('DNS not configured — DDNS job idle');
      return;
    }
    if (this.running) return;
    this.running = true;
    const intervalMs = this.dns.settings().ddnsIntervalSeconds * 1000;
    // Fire once shortly after start, then on the configured interval.
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    log.info(`started (every ${this.dns.settings().ddnsIntervalSeconds}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  /** Restart with current settings (call after DNS settings change). */
  reschedule(): void {
    this.stop();
    this.start();
  }

  status() {
    return {
      enabled: this.dns.enabled,
      running: this.running,
      lastIp: this.lastIp,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      intervalSeconds: this.dns.settings().ddnsIntervalSeconds,
    };
  }
}
