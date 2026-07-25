import { CloudflareError } from './errors.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface SrvData {
  service: string; // "_factorio"
  proto: string; // "_udp"
  name: string; // the subdomain the service lives under, e.g. "factory1.example.com"
  priority: number;
  weight: number;
  port: number;
  target: string; // e.g. "host.example.com"
}

export interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

/**
 * Minimal Cloudflare DNS API client (REST via fetch). Only the operations this
 * app needs: create/update/delete a record, and find records by type+name.
 */
export class CloudflareClient {
  constructor(
    private readonly token: string,
    private readonly zoneId: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (DNS, TLS, connection refused, ...)
      throw new CloudflareError(`request failed: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !json || !json.success) {
      const detail =
        json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`;
      throw new CloudflareError(detail);
    }
    return json.result;
  }

  /** Fetch the configured zone (used to verify token + zone access). */
  async getZone(): Promise<{ id: string; name: string; status: string }> {
    return this.call<{ id: string; name: string; status: string }>(
      'GET',
      `/zones/${this.zoneId}`,
    );
  }

  /** Find records of a given type and exact (full) name. */
  async findRecords(type: string, name: string): Promise<CloudflareRecord[]> {
    const params = new URLSearchParams({ type, name });
    return this.call<CloudflareRecord[]>(
      'GET',
      `/zones/${this.zoneId}/dns_records?${params.toString()}`,
    );
  }

  /** Find every record type at an exact name (used for CNAME collision checks). */
  async findRecordsByName(name: string): Promise<CloudflareRecord[]> {
    const params = new URLSearchParams({ name });
    return this.call<CloudflareRecord[]>(
      'GET',
      `/zones/${this.zoneId}/dns_records?${params.toString()}`,
    );
  }

  async createSrv(data: SrvData, ttl = 60): Promise<CloudflareRecord> {
    return this.call<CloudflareRecord>('POST', `/zones/${this.zoneId}/dns_records`, {
      type: 'SRV',
      ttl,
      data,
    });
  }

  async updateSrv(recordId: string, data: SrvData, ttl = 60): Promise<CloudflareRecord> {
    return this.call<CloudflareRecord>(
      'PUT',
      `/zones/${this.zoneId}/dns_records/${recordId}`,
      { type: 'SRV', ttl, data },
    );
  }

  /** Create or update an A record. `proxied` MUST be false for game traffic. */
  async createA(name: string, ip: string, ttl = 60): Promise<CloudflareRecord> {
    return this.call<CloudflareRecord>('POST', `/zones/${this.zoneId}/dns_records`, {
      type: 'A',
      name,
      content: ip,
      ttl,
      proxied: false,
    });
  }

  async updateA(recordId: string, name: string, ip: string, ttl = 60): Promise<CloudflareRecord> {
    return this.call<CloudflareRecord>('PUT', `/zones/${this.zoneId}/dns_records/${recordId}`, {
      type: 'A',
      name,
      content: ip,
      ttl,
      proxied: false,
    });
  }

  async deleteRecord(recordId: string): Promise<void> {
    await this.call<{ id: string }>('DELETE', `/zones/${this.zoneId}/dns_records/${recordId}`);
  }
}
