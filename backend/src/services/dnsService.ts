import type { DB } from '../db/index.js';
import { kvGet, kvSet } from '../db/index.js';
import type { DnsRecordRow, ServerRow } from '../db/models.js';
import { CloudflareClient, type SrvData } from '../lib/cloudflare.js';
import { CloudflareError } from '../lib/errors.js';
import {
  dnsEnabled,
  getDnsSettings,
  setDnsSettings,
  type DnsSettings,
  type DnsSettingsPatch,
} from './dnsSettings.js';

const KV_HOST_A_RECORD_ID = 'host_a_record_id';
const KV_LAST_PUBLIC_IP = 'last_public_ip';

export interface DnsReconcileRecordResult {
  type: 'A' | 'SRV';
  name: string;
  serverId?: string;
  ok: boolean;
  action?: 'created' | 'updated';
  error?: string;
}

export interface DnsReconcileResult {
  ok: boolean;
  lastRun: string;
  publicIp?: string;
  records: DnsReconcileRecordResult[];
}

interface InternalRecordResult extends DnsReconcileRecordResult {
  recordId?: string;
  content?: string;
  created?: boolean;
}

interface InternalReconcileResult {
  result: DnsReconcileResult;
  records: InternalRecordResult[];
}

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
  private lastReconciliation?: DnsReconcileResult;

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

  private candidateSettings(candidate: DnsSettingsPatch = {}): DnsSettings {
    const current = this.settings();
    return {
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
  }

  private async detectPublicIp(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`IP check returned HTTP ${response.status}`);
    const publicIp = (await response.text()).trim();
    const octets = publicIp.split('.');
    if (
      octets.length !== 4 ||
      octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
    ) {
      throw new Error(`Unexpected IP check response: ${publicIp.slice(0, 64)}`);
    }
    return publicIp;
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
    const s = this.candidateSettings(candidate);

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

      const publicIp = await this.detectPublicIp(s.ipCheckUrl);
      return { ok: true, zoneName, publicIp };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  reconciliationStatus(): DnsReconcileResult | undefined {
    return this.lastReconciliation;
  }

  private async executeReconciliation(
    s: DnsSettings,
    knownPublicIp?: string,
    forceCreate = false,
  ): Promise<InternalReconcileResult> {
    const records: InternalRecordResult[] = [];
    const lastRun = new Date().toISOString();
    if (!dnsEnabled(s)) {
      return { result: { ok: false, lastRun, records }, records };
    }

    const cf = new CloudflareClient(s.cloudflareToken, s.cloudflareZoneId);
    let publicIp: string | undefined = knownPublicIp;
    try {
      publicIp ??= await this.detectPublicIp(s.ipCheckUrl);
      const found = forceCreate ? [] : await cf.findRecords('A', s.hostRecordName);
      if (found.length > 0) {
        await cf.updateA(found[0].id, s.hostRecordName, publicIp);
        records.push({
          type: 'A',
          name: s.hostRecordName,
          ok: true,
          action: 'updated',
          recordId: found[0].id,
          content: publicIp,
        });
      } else {
        const created = await cf.createA(s.hostRecordName, publicIp);
        records.push({
          type: 'A',
          name: s.hostRecordName,
          ok: true,
          action: 'created',
          recordId: created.id,
          content: publicIp,
          created: true,
        });
      }
    } catch (err) {
      records.push({
        type: 'A',
        name: s.hostRecordName,
        ok: false,
        error: (err as Error).message,
      });
    }

    const servers = this.db
      .prepare<ServerRow>("SELECT * FROM servers WHERE lifecycle = 'active' ORDER BY created_at ASC")
      .all();
    for (const server of servers) {
      const name = this.fullSrvName(s, server.subdomain);
      const content = `${s.hostRecordName}:${server.game_port}`;
      try {
        const found = forceCreate ? [] : await cf.findRecords('SRV', name);
        if (found.length > 0) {
          await cf.updateSrv(found[0].id, this.srvData(s, server.subdomain, server.game_port));
          records.push({
            type: 'SRV',
            name,
            serverId: server.id,
            ok: true,
            action: 'updated',
            recordId: found[0].id,
            content,
          });
        } else {
          const created = await cf.createSrv(this.srvData(s, server.subdomain, server.game_port));
          records.push({
            type: 'SRV',
            name,
            serverId: server.id,
            ok: true,
            action: 'created',
            recordId: created.id,
            content,
            created: true,
          });
        }
      } catch (err) {
        records.push({
          type: 'SRV',
          name,
          serverId: server.id,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    const result: DnsReconcileResult = {
      ok: records.every((record) => record.ok),
      lastRun,
      publicIp,
      records: records.map(
        ({ recordId: _recordId, content: _content, created: _created, ...record }) => record,
      ),
    };
    return { result, records };
  }

  private commitBookkeeping(run: InternalReconcileResult): void {
    this.db.transaction(() => {
      const host = run.records.find((record) => record.type === 'A' && record.ok);
      if (host?.recordId && host.content) {
        kvSet(this.db, KV_HOST_A_RECORD_ID, host.recordId);
        kvSet(this.db, KV_LAST_PUBLIC_IP, host.content);
      }
      for (const record of run.records) {
        if (record.type !== 'SRV' || !record.ok || !record.serverId || !record.recordId) continue;
        this.db
          .prepare("DELETE FROM dns_records WHERE server_id = ? AND type = 'SRV'")
          .run(record.serverId);
        this.db
          .prepare(
            `INSERT INTO dns_records (server_id, type, name, cloudflare_record_id, content)
             VALUES (?, 'SRV', ?, ?, ?)`,
          )
          .run(record.serverId, record.name, record.recordId, record.content ?? '');
      }
    })();
  }

  private async deleteCreatedRecords(s: DnsSettings, run: InternalReconcileResult): Promise<void> {
    const cf = new CloudflareClient(s.cloudflareToken, s.cloudflareZoneId);
    for (const record of run.records) {
      if (!record.created || !record.recordId) continue;
      try {
        await cf.deleteRecord(record.recordId);
      } catch (err) {
        console.warn(`[dns] failed to roll back ${record.name}: ${(err as Error).message}`);
      }
    }
  }

  private async deleteStaleTrackedRecords(
    oldSettings: DnsSettings,
    oldARecordId: string | undefined,
    oldSrvRows: DnsRecordRow[],
    run: InternalReconcileResult,
  ): Promise<void> {
    if (!oldSettings.cloudflareToken || !oldSettings.cloudflareZoneId) return;
    const host = run.records.find((record) => record.type === 'A' && record.ok);
    const stale: string[] = [];
    if (oldARecordId && host?.recordId && oldARecordId !== host.recordId) stale.push(oldARecordId);
    for (const row of oldSrvRows) {
      const replacement = run.records.find(
        (record) => record.type === 'SRV' && record.ok && record.serverId === row.server_id,
      );
      if (
        row.cloudflare_record_id &&
        replacement?.recordId &&
        row.cloudflare_record_id !== replacement.recordId
      ) {
        stale.push(row.cloudflare_record_id);
      }
    }
    const cf = new CloudflareClient(oldSettings.cloudflareToken, oldSettings.cloudflareZoneId);
    for (const recordId of new Set(stale)) {
      try {
        await cf.deleteRecord(recordId);
      } catch (err) {
        console.warn(`[dns] failed to delete stale record ${recordId}: ${(err as Error).message}`);
      }
    }
  }

  /** Save and activate a candidate only after every desired DNS record succeeds. */
  async activateSettings(
    patch: DnsSettingsPatch,
  ): Promise<{ settings: DnsSettings; reconciliation?: DnsReconcileResult }> {
    const current = this.settings();
    const candidate = this.candidateSettings(patch);
    if (!dnsEnabled(candidate)) {
      setDnsSettings(this.db, patch);
      this.lastReconciliation = undefined;
      return { settings: this.settings() };
    }

    const tested = await this.testConnection(patch);
    if (!tested.ok) throw new CloudflareError(tested.error ?? 'DNS configuration test failed');

    const oldARecordId = kvGet(this.db, KV_HOST_A_RECORD_ID);
    const oldSrvRows = this.db
      .prepare<DnsRecordRow>("SELECT * FROM dns_records WHERE type = 'SRV'")
      .all();
    // Stage distinct records when the namespace/zone changes. If a later record
    // fails, those new records can be deleted without having mutated the working
    // configuration that is still stored in the database.
    const topologyChanged =
      !dnsEnabled(current) ||
      current.cloudflareZoneId !== candidate.cloudflareZoneId ||
      current.baseDomain !== candidate.baseDomain ||
      current.hostRecordName !== candidate.hostRecordName;
    const run = await this.executeReconciliation(candidate, tested.publicIp, topologyChanged);
    this.lastReconciliation = run.result;
    if (!run.result.ok) {
      await this.deleteCreatedRecords(candidate, run);
      const failures = run.result.records
        .filter((record) => !record.ok)
        .map((record) => `${record.name}: ${record.error}`)
        .join('; ');
      throw new CloudflareError(`DNS activation failed: ${failures}`);
    }

    setDnsSettings(this.db, candidate);
    this.commitBookkeeping(run);
    await this.deleteStaleTrackedRecords(current, oldARecordId, oldSrvRows, run);
    return { settings: this.settings(), reconciliation: run.result };
  }

  /** Re-discover and repair every desired record using the stored settings. */
  async reconcile(): Promise<DnsReconcileResult> {
    const settings = this.settings();
    const oldARecordId = kvGet(this.db, KV_HOST_A_RECORD_ID);
    const oldSrvRows = this.db
      .prepare<DnsRecordRow>("SELECT * FROM dns_records WHERE type = 'SRV'")
      .all();
    const run = await this.executeReconciliation(settings);
    this.commitBookkeeping(run);
    await this.deleteStaleTrackedRecords(settings, oldARecordId, oldSrvRows, run);
    this.lastReconciliation = run.result;
    return run.result;
  }
}
