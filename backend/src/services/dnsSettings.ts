import { kvGet, kvSet, type DB } from '../db/index.js';

/**
 * DNS / Cloudflare settings, persisted in the DB (kv) and edited entirely from the
 * dashboard — there are no DNS environment variables. The shared A-record name is
 * derived from the server domain so users cannot accidentally reuse a player-facing
 * hostname or an existing CNAME.
 */
export interface DnsSettings {
  baseDomain: string;
  hostRecordName: string;
  cloudflareZoneId: string;
  cloudflareZoneName: string;
  cloudflareToken: string;
  ddnsIntervalSeconds: number;
  ipCheckUrl: string;
}

const K = {
  baseDomain: 'dns_base_domain',
  // Retained as a migration marker for installations that previously chose
  // this value manually. Runtime settings always use deriveHostRecordName().
  hostRecordName: 'dns_host_record',
  zoneId: 'dns_zone_id',
  zoneName: 'dns_zone_name',
  token: 'dns_token',
  interval: 'dns_ddns_interval_seconds',
  ipCheckUrl: 'dns_ip_check_url',
} as const;

export const DEFAULT_DDNS_INTERVAL = 300;
export const DEFAULT_IP_CHECK_URL = 'https://api.ipify.org';
export const DNS_HOST_LABEL = 'factorio-tools-manager';

export function deriveHostRecordName(baseDomain: string): string {
  const base = baseDomain.trim().toLowerCase().replace(/\.$/, '');
  return base ? `${DNS_HOST_LABEL}.${base}` : '';
}

export function storedHostRecordName(db: DB): string {
  return kvGet(db, K.hostRecordName) ?? '';
}

export function getDnsSettings(db: DB): DnsSettings {
  const interval = Number(kvGet(db, K.interval));
  const baseDomain = kvGet(db, K.baseDomain) ?? '';
  return {
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
  baseDomain?: string;
  cloudflareZoneId?: string;
  /** Verified name returned by Cloudflare; never accepted from the public API. */
  cloudflareZoneName?: string;
  cloudflareToken?: string; // '' clears it (disables DNS)
  ddnsIntervalSeconds?: number;
  ipCheckUrl?: string;
}

export function setDnsSettings(db: DB, patch: DnsSettingsPatch): void {
  if (patch.baseDomain !== undefined) {
    const baseDomain = patch.baseDomain.trim().toLowerCase().replace(/\.$/, '');
    kvSet(db, K.baseDomain, baseDomain);
    kvSet(db, K.hostRecordName, deriveHostRecordName(baseDomain));
  }
  if (patch.cloudflareZoneId !== undefined) {
    kvSet(db, K.zoneId, patch.cloudflareZoneId.trim());
    if (patch.cloudflareZoneName === undefined) kvSet(db, K.zoneName, '');
  }
  if (patch.cloudflareZoneName !== undefined)
    kvSet(db, K.zoneName, patch.cloudflareZoneName.trim().toLowerCase().replace(/\.$/, ''));
  if (patch.cloudflareToken !== undefined) kvSet(db, K.token, patch.cloudflareToken.trim());
  if (patch.ddnsIntervalSeconds !== undefined)
    kvSet(db, K.interval, String(Math.max(30, Math.floor(patch.ddnsIntervalSeconds))));
  if (patch.ipCheckUrl !== undefined) kvSet(db, K.ipCheckUrl, patch.ipCheckUrl.trim());
}

/** DNS automation is on only when everything it needs is present. */
export function dnsEnabled(s: DnsSettings): boolean {
  return Boolean(s.cloudflareToken && s.cloudflareZoneId && s.baseDomain && s.hostRecordName);
}

/** UI-facing view: token is never returned, only whether it's set. */
export function dnsSettingsDto(s: DnsSettings) {
  return {
    baseDomain: s.baseDomain,
    hostRecordName: s.hostRecordName,
    cloudflareZoneId: s.cloudflareZoneId,
    cloudflareZoneName: s.cloudflareZoneName,
    hasToken: s.cloudflareToken !== '',
    ddnsIntervalSeconds: s.ddnsIntervalSeconds,
    ipCheckUrl: s.ipCheckUrl,
    enabled: dnsEnabled(s),
  };
}
