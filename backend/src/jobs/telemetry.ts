import os from 'node:os';
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';
import { kvGet, kvSet } from '../db/index.js';
import type { ServersRepo } from '../db/serversRepo.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('telemetry');

/** Local hour (0-23) the nightly re-ping fires at. Offset from the update-check
 * job's 3am so the two don't wake the process at the exact same instant. */
const NIGHTLY_HOUR = 4;

const KV_INSTANCE_ID = 'telemetry_instance_id';

/** Milliseconds from now until the next occurrence of `hour:00` local time. */
function msUntilNextRun(hour: number): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * A random id generated once per install and persisted in the `kv` table —
 * never derived from IP, MAC, hostname or anything else identifying. This is
 * the only thing that makes a distinct-installs count possible at all: it's
 * sent as a custom event prop because Aptabase's own server-computed identity
 * (IP+UA hashed, rotated every 24h) is intentionally too short-lived for that.
 */
export function getOrCreateInstanceId(db: DB): string {
  const existing = kvGet(db, KV_INSTANCE_ID);
  if (existing) return existing;
  const id = crypto.randomUUID();
  kvSet(db, KV_INSTANCE_ID, id);
  return id;
}

export interface AptabaseEventBody {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: {
    osName: string;
    osVersion: string;
    appVersion: string;
    sdkVersion: string;
  };
  props: {
    instance_id: string;
    server_count: number;
  };
}

/**
 * Builds the single ping event. Kept pure/exported so the payload shape is
 * unit-testable without a network call — see EventBody validation rules in
 * aptabase/aptabase (EventBody.cs): sessionId just needs to be <=36 chars (a
 * UUID qualifies), sdkVersion is required, string props are visible in
 * plaintext in ClickHouse's string_props column so nothing sensitive belongs here.
 */
export function buildPingEvent(config: AppConfig, instanceId: string, serverCount: number): AptabaseEventBody {
  return {
    timestamp: new Date().toISOString(),
    sessionId: crypto.randomUUID(),
    eventName: 'heartbeat',
    systemProps: {
      osName: process.platform,
      osVersion: os.release(),
      appVersion: config.appVersion,
      sdkVersion: 'fsm-telemetry/1',
    },
    props: {
      instance_id: instanceId,
      server_count: serverCount,
    },
  };
}

/**
 * Telemetry ping job: sends one anonymous "heartbeat" event on startup and
 * again every night at {@link NIGHTLY_HOUR} local time, to a self-hosted
 * Aptabase instance. Purely additive to the dashboard — never blocks startup,
 * never throws. Disabled outright (regardless of TELEMETRY_ENABLED) unless both
 * APTABASE_HOST and APTABASE_APP_KEY are configured, so an unconfigured
 * install never fires requests at a placeholder URL.
 */
export class TelemetryJob {
  private timer?: NodeJS.Timeout;
  private lastSent?: string;
  private lastError?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly db: DB,
    private readonly repo: ServersRepo,
  ) {}

  async runOnce(): Promise<void> {
    const instanceId = getOrCreateInstanceId(this.db);
    const event = buildPingEvent(this.config, instanceId, this.repo.list().length);
    try {
      const res = await fetch(`${this.config.aptabaseHost}/api/v0/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'App-Key': this.config.aptabaseAppKey },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`collector returned HTTP ${res.status}`);
      this.lastSent = new Date().toISOString();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn(`ping failed: ${this.lastError}`);
    }
  }

  start(): void {
    if (!this.config.telemetryEnabled) {
      log.info('disabled (TELEMETRY_ENABLED=false)');
      return;
    }
    if (!this.config.aptabaseHost || !this.config.aptabaseAppKey) {
      log.info('disabled (APTABASE_HOST / APTABASE_APP_KEY not configured)');
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
      enabled: this.config.telemetryEnabled && !!this.config.aptabaseHost && !!this.config.aptabaseAppKey,
      // Read-only here (a GET /api/system/status must not have side effects) —
      // unset until the first ping actually runs and creates it.
      instanceId: kvGet(this.db, KV_INSTANCE_ID),
      lastSent: this.lastSent,
      lastError: this.lastError,
    };
  }
}
