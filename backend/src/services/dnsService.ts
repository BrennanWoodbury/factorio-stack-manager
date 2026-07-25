import type { DB } from '../db/index.js';
import { kvGet, kvSet } from '../db/index.js';
import type { DnsRecordRow, ServerRow } from '../db/models.js';
import { CloudflareClient, type SrvData } from '../lib/cloudflare.js';
import {
  dnsEnabled,
  getDnsSettings,
  type DnsSettings,
  type DnsSettingsPatch,
} from './dnsSettings.js';

const KV_HOST_A_RECORD_ID = 'host_a_record_id';
const KV_LAST_PUBLIC_IP = 'last_public_ip';

/**
 * Owns all Cloudflare DNS state for the app:
 *  - one SRV record per server: `_factorio._udp.<subdomain>.<base>` → host:port
 *  - one shared A record `host.<base>` that every SRV target points at, kept in
 *    sync with the current public IP by the DDNS job.
 *
 * All settings live in the DB (edited from the dashboard) and are read on each
 * call, so config changes take effect without a restart. When DNS isn't fully
 * configured, every method is a safe no-op so the app runs fine with players
 * connecting by IP:port.
 */
export class DnsService {
  constructor(private readonly db: DB) {}

  /** Current settings snapshot. */
  settings(): DnsSettings {
    return getDnsSettings(this.db);
  }

  get enabled(): boolean {
    return dnsEnabled(this.settings());
  }

  /** A Cloudflare client from current settings, or undefined when DNS is off. */
  private cf(s: DnsSettings = this.settings()): CloudflareClient | undefined {
    if (!dnsEnabled(s)) return undefined;
    return new CloudflareClient(s.cloudflareToken, s.cloudflareZoneId);
  }

  /** The hostname players connect to for a given server. */
  connectHost(subdomain: string): string | undefined {
    const { baseDomain } = this.settings();
    if (!baseDomain) return undefined;
    return `${subdomain}.${baseDomain}`;
  }

  private srvData(s: DnsSettings, subdomain: string, port: number): SrvData {
    return {
      service: '_factorio',
      proto: '_udp',
      name: `${subdomain}.${s.baseDomain}`,
      priority: 0,
      weight: 0,
      port,
      target: s.hostRecordName,
    };
  }

  private fullSrvName(s: DnsSettings, subdomain: string): string {
    return `_factorio._udp.${subdomain}.${s.baseDomain}`;
  }

  private srvRowFor(serverId: string): DnsRecordRow | undefined {
    return this.db
      .prepare<DnsRecordRow>(
        "SELECT * FROM dns_records WHERE server_id = ? AND type = 'SRV' ORDER BY id DESC LIMIT 1",
      )
      .get(serverId);
  }

  /** Create the SRV record for a newly-created server. */
  async createServerSrv(server: ServerRow): Promise<void> {
    const s = this.settings();
    const cf = this.cf(s);
    if (!cf) return;
    const record = await cf.createSrv(this.srvData(s, server.subdomain, server.game_port));
    this.db
      .prepare(
        `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
         VALUES (?, 'SRV', ?, ?, ?)`,
      )
      .run(
        server.id,
        this.fullSrvName(s, server.subdomain),
        record.id,
        `${s.hostRecordName}:${server.game_port}`,
      );
  }

  /**
   * Update a server's SRV record after a subdomain rename and/or port change.
   * If no record is tracked yet (e.g. created while DNS was off) it creates one.
   */
  async updateServerSrv(server: ServerRow): Promise<void> {
    const s = this.settings();
    const cf = this.cf(s);
    if (!cf) return;
    const existing = this.srvRowFor(server.id);
    const data = this.srvData(s, server.subdomain, server.game_port);
    if (existing?.cloudflare_record_id) {
      await cf.updateSrv(existing.cloudflare_record_id, data);
      this.db
        .prepare('UPDATE dns_records SET name = ?, content = ? WHERE id = ?')
        .run(
          this.fullSrvName(s, server.subdomain),
          `${s.hostRecordName}:${server.game_port}`,
          existing.id,
        );
    } else {
      await this.createServerSrv(server);
    }
  }

  /** Remove a server's SRV record from Cloudflare and our bookkeeping. */
  async deleteServerSrv(serverId: string): Promise<void> {
    const cf = this.cf();
    const rows = this.db
      .prepare<DnsRecordRow>("SELECT * FROM dns_records WHERE server_id = ? AND type = 'SRV'")
      .all(serverId);
    for (const row of rows) {
      if (cf && row.cloudflare_record_id) {
        // Best-effort: if the record was already removed at Cloudflare, ignore.
        try {
          await cf.deleteRecord(row.cloudflare_record_id);
        } catch (err) {
          console.warn(`[dns] failed to delete SRV ${row.name}: ${(err as Error).message}`);
        }
      }
      this.db.prepare('DELETE FROM dns_records WHERE id = ?').run(row.id);
    }
  }

  /**
   * Ensure the shared host A record matches `ip`. Creates it if missing, updates
   * it if changed, no-ops if already correct. Returns whether a change was made.
   */
  async ensureHostARecord(ip: string): Promise<boolean> {
    const s = this.settings();
    const cf = this.cf(s);
    if (!cf) return false;
    const lastIp = kvGet(this.db, KV_LAST_PUBLIC_IP);
    let recordId = kvGet(this.db, KV_HOST_A_RECORD_ID);

    // Reconcile our cached record id against Cloudflare if we don't have one.
    if (!recordId) {
      const found = await cf.findRecords('A', s.hostRecordName);
      if (found.length > 0) {
        recordId = found[0].id;
        kvSet(this.db, KV_HOST_A_RECORD_ID, recordId);
        if (found[0].content === ip) {
          kvSet(this.db, KV_LAST_PUBLIC_IP, ip);
          return false;
        }
      }
    } else if (lastIp === ip) {
      return false; // fast path: nothing changed since last check
    }

    if (recordId) {
      await cf.updateA(recordId, s.hostRecordName, ip);
    } else {
      const created = await cf.createA(s.hostRecordName, ip);
      kvSet(this.db, KV_HOST_A_RECORD_ID, created.id);
    }
    kvSet(this.db, KV_LAST_PUBLIC_IP, ip);
    return true;
  }

  /**
   * Validate an unsaved candidate configuration without persisting it or changing
   * DNS. Omitted values fall back to the stored settings, which lets an admin test
   * edits without re-entering the masked token.
   */
  async testConnection(
    candidate: DnsSettingsPatch = {},
  ): Promise<{ ok: boolean; zoneName?: string; publicIp?: string; error?: string }> {
    const current = this.settings();
    const s: DnsSettings = {
      baseDomain:
        candidate.baseDomain === undefined
          ? current.baseDomain
          : candidate.baseDomain.trim().toLowerCase().replace(/\.$/, ''),
      hostRecordName:
        candidate.hostRecordName === undefined
          ? current.hostRecordName
          : candidate.hostRecordName.trim().toLowerCase().replace(/\.$/, ''),
      cloudflareZoneId:
        candidate.cloudflareZoneId === undefined
          ? current.cloudflareZoneId
          : candidate.cloudflareZoneId.trim(),
      cloudflareToken:
        candidate.cloudflareToken === undefined
          ? current.cloudflareToken
          : candidate.cloudflareToken.trim(),
      ddnsIntervalSeconds: candidate.ddnsIntervalSeconds ?? current.ddnsIntervalSeconds,
      ipCheckUrl:
        candidate.ipCheckUrl === undefined ? current.ipCheckUrl : candidate.ipCheckUrl.trim(),
    };

    if (!s.cloudflareToken || !s.cloudflareZoneId || !s.baseDomain || !s.hostRecordName) {
      return {
        ok: false,
        error: 'Server domain, host record, API token and Zone ID are required',
      };
    }
    try {
      const cf = new CloudflareClient(s.cloudflareToken, s.cloudflareZoneId);
      const zone = await cf.getZone();
      const zoneName = zone.name.trim().toLowerCase().replace(/\.$/, '');
      const belongsToZone = (name: string) => name === zoneName || name.endsWith(`.${zoneName}`);
      if (!belongsToZone(s.baseDomain)) {
        return {
          ok: false,
          zoneName,
          error: `Server domain must belong to Cloudflare zone ${zoneName}`,
        };
      }
      if (!belongsToZone(s.hostRecordName)) {
        return {
          ok: false,
          zoneName,
          error: `Host record must belong to Cloudflare zone ${zoneName}`,
        };
      }

      // A read proves that the token is scoped to DNS in this zone without making
      // the test itself mutate customer records.
      await cf.findRecords('A', s.hostRecordName);

      const response = await fetch(s.ipCheckUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`IP check returned HTTP ${response.status}`);
      const publicIp = (await response.text()).trim();
      const octets = publicIp.split('.');
      if (
        octets.length !== 4 ||
        octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
      ) {
        throw new Error(`Unexpected IP check response: ${publicIp.slice(0, 64)}`);
      }
      return { ok: true, zoneName, publicIp };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
