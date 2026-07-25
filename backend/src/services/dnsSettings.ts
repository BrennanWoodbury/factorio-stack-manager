import { kvGet, kvSet, type DB } from '../db/index.js';

/**
 * DNS / Cloudflare settings, persisted in the DB (kv) and edited entirely from the
 * dashboard — there are no DNS environment variables. The shared A-record name is
 * derived from the server domain so users cannot accidentally reuse a player-facing
 * hostname or an existing CNAME.
 */
export interface DnsSettings {
  revision: number;
  /**
   * The user's on/off switch, independent of whether DNS is configured. Turning
   * automation off must not mean deleting a token and a zone ID the user then has
   * to type back in.
   */
  enabled: boolean;
  baseDomain: string;
  hostRecordName: string;
  cloudflareZoneId: string;
  cloudflareZoneName: string;
  cloudflareToken: string;
  ddnsIntervalSeconds: number;
  ipCheckUrl: string;
}

const K = {
  enabled: 'dns_enabled',
  baseDomain: 'dns_base_domain',
  // Retained as a migration marker for installations that previously chose
  // this value manually, and also written by the one-time host-label rename
  // migration (see DnsService.migrateHostLabelRename). Runtime settings
  // always use deriveHostRecordName().
  hostRecordName: 'dns_host_record',
  zoneId: 'dns_zone_id',
  zoneName: 'dns_zone_name',
  token: 'dns_token',
  interval: 'dns_ddns_interval_seconds',
  ipCheckUrl: 'dns_ip_check_url',
  revision: 'dns_settings_revision',
} as const;

export const DEFAULT_DDNS_INTERVAL = 300;
export const DEFAULT_IP_CHECK_URL = 'https://api.ipify.org';
export const DNS_HOST_LABEL = 'factorio-stack-manager';
/** The label every install used before the "Factorio Stack Manager" rebrand. */
export const LEGACY_DNS_HOST_LABEL = 'factorio-tools-manager';

function hostRecordNameFor(label: string, baseDomain: string): string {
  const base = baseDomain.trim().toLowerCase().replace(/\.$/, '');
  return base ? `${label}.${base}` : '';
}

export function deriveHostRecordName(baseDomain: string): string {
  return hostRecordNameFor(DNS_HOST_LABEL, baseDomain);
}

/** The pre-rebrand host record name, used only by the one-time rename migration. */
export function deriveLegacyHostRecordName(baseDomain: string): string {
  return hostRecordNameFor(LEGACY_DNS_HOST_LABEL, baseDomain);
}

export function storedHostRecordName(db: DB): string {
  return kvGet(db, K.hostRecordName) ?? '';
}

/** Written by the one-time host-label migration once it repoints everything. */
export function setStoredHostRecordName(db: DB, name: string): void {
  kvSet(db, K.hostRecordName, name);
}

export function getDnsSettings(db: DB): DnsSettings {
  const interval = Number(kvGet(db, K.interval));
  const revision = Number(kvGet(db, K.revision));
  const baseDomain = kvGet(db, K.baseDomain) ?? '';
  return {
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    // Absent means on: installations that predate the switch had DNS running
    // whenever it was configured, and an upgrade must not silently stop it.
    enabled: kvGet(db, K.enabled) !== '0',
    baseDomain,
    hostRecordName: deriveHostRecordName(baseDomain),
    cloudflareZoneId: kvGet(db, K.zoneId) ?? '',
    cloudflareZoneName: kvGet(db, K.zoneName) ?? '',
    cloudflareToken: kvGet(db, K.token) ?? '',
    ddnsIntervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DDNS_INTERVAL,
    ipCheckUrl: kvGet(db, K.ipCheckUrl) || DEFAULT_IP_CHECK_URL,
  };
}

export interface DnsSettingsPatch {
  enabled?: boolean;
  baseDomain?: string;
  cloudflareZoneId?: string;
  /** Verified name returned by Cloudflare; never accepted from the public API. */
  cloudflareZoneName?: string;
  cloudflareToken?: string; // '' clears it (disables DNS)
  ddnsIntervalSeconds?: number;
  ipCheckUrl?: string;
}

export function setDnsSettings(db: DB, patch: DnsSettingsPatch): void {
  let changed = false;
  if (patch.enabled !== undefined) {
    changed = true;
    kvSet(db, K.enabled, patch.enabled ? '1' : '0');
  }
  if (patch.baseDomain !== undefined) {
    changed = true;
    const baseDomain = patch.baseDomain.trim().toLowerCase().replace(/\.$/, '');
    kvSet(db, K.baseDomain, baseDomain);
    kvSet(db, K.hostRecordName, deriveHostRecordName(baseDomain));
  }
  if (patch.cloudflareZoneId !== undefined) {
    changed = true;
    kvSet(db, K.zoneId, patch.cloudflareZoneId.trim());
    if (patch.cloudflareZoneName === undefined) kvSet(db, K.zoneName, '');
  }
  if (patch.cloudflareZoneName !== undefined) {
    changed = true;
    kvSet(db, K.zoneName, patch.cloudflareZoneName.trim().toLowerCase().replace(/\.$/, ''));
  }
  if (patch.cloudflareToken !== undefined) {
    changed = true;
    kvSet(db, K.token, patch.cloudflareToken.trim());
  }
  if (patch.ddnsIntervalSeconds !== undefined) {
    changed = true;
    kvSet(db, K.interval, String(Math.max(30, Math.floor(patch.ddnsIntervalSeconds))));
  }
  if (patch.ipCheckUrl !== undefined) {
    changed = true;
    kvSet(db, K.ipCheckUrl, patch.ipCheckUrl.trim());
  }
  if (changed) {
    const currentRevision = Number(kvGet(db, K.revision));
    const revision =
      Number.isSafeInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0;
    kvSet(db, K.revision, String(revision + 1));
  }
}

/** Everything DNS automation needs is present — says nothing about the switch. */
export function dnsConfigured(s: DnsSettings): boolean {
  return Boolean(s.cloudflareToken && s.cloudflareZoneId && s.baseDomain && s.hostRecordName);
}

/** DNS automation actually runs: switched on *and* fully configured. */
export function dnsEnabled(s: DnsSettings): boolean {
  return s.enabled && dnsConfigured(s);
}

/**
 * Whether a single server takes part in DNS. Separate from the global switch: a
 * private or throwaway server can be kept out of public DNS while every other
 * server still gets records. Absent/legacy rows count as participating.
 */
export function serverDnsEnabled(server: { dns_enabled?: number }): boolean {
  return server.dns_enabled !== 0;
}

/** UI-facing view: token is never returned, only whether it's set. */
export function dnsSettingsDto(s: DnsSettings) {
  return {
    revision: s.revision,
    baseDomain: s.baseDomain,
    hostRecordName: s.hostRecordName,
    cloudflareZoneId: s.cloudflareZoneId,
    cloudflareZoneName: s.cloudflareZoneName,
    hasToken: s.cloudflareToken !== '',
    ddnsIntervalSeconds: s.ddnsIntervalSeconds,
    ipCheckUrl: s.ipCheckUrl,
    /** The switch — what the checkbox binds to. */
    enabled: s.enabled,
    /** Whether the settings are complete enough to run. */
    configured: dnsConfigured(s),
    /** Switched on and configured: DNS automation is really running. */
    active: dnsEnabled(s),
  };
}
