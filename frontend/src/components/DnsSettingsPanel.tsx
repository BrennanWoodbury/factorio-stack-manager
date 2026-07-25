import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { DnsReconcileResult, DnsSettings } from '../types';
import { run, toastError, toastSuccess } from '../ui';

/**
 * Cloudflare / DNS settings, edited entirely here (nothing in env). Configuring
 * server domain, zone ID and API token enables automatic SRV records per server
 * plus the DDNS A-record sync. The shared A-record name is derived automatically.
 */
export function DnsSettingsPanel() {
  const [dns, setDns] = useState<DnsSettings | null>(null);
  const [baseDomain, setBaseDomain] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [zoneName, setZoneName] = useState('');
  const [token, setToken] = useState('');
  const [interval, setIntervalSecs] = useState(300);
  const [ipCheckUrl, setIpCheckUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<DnsReconcileResult | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);

  const fingerprint = (hasStoredToken: boolean) =>
    JSON.stringify([
      baseDomain.trim().toLowerCase().replace(/\.$/, ''),
      zoneId.trim(),
      token.trim() || (hasStoredToken ? '<stored>' : ''),
      ipCheckUrl.trim(),
    ]);

  const load = useCallback(async () => {
    try {
      const { dns, reconciliation } = await api.getDns();
      setDns(dns);
      setBaseDomain(dns.baseDomain);
      setZoneId(dns.cloudflareZoneId);
      setZoneName(dns.cloudflareZoneName);
      setIntervalSecs(dns.ddnsIntervalSeconds);
      setIpCheckUrl(dns.ipCheckUrl);
      setToken('');
      setTestResult(null);
      setReconciliation(reconciliation ?? null);
      setValidatedFingerprint(
        dns.enabled
          ? JSON.stringify([
              dns.baseDomain,
              dns.cloudflareZoneId,
              '<stored>',
              dns.ipCheckUrl,
            ])
          : null,
      );
    } catch (err) {
      toastError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!dns) return null;

  const save = async () => {
    setBusy(true);
    let settingsConflict = false;
    const patch: Record<string, unknown> = {
      expectedRevision: dns.revision,
      baseDomain,
      cloudflareZoneId: zoneId,
      ddnsIntervalSeconds: interval,
      ipCheckUrl,
    };
    // Only send the token when the admin actually typed one (blank keeps the current).
    if (token.trim()) patch.cloudflareToken = token.trim();
    const ok = await run(async () => {
      try {
        const r = await api.setDns(patch);
        setDns(r.dns);
        setReconciliation(r.reconciliation ?? null);
        setToken('');
      } catch (err) {
        settingsConflict = err instanceof ApiError && err.code === 'DNS_SETTINGS_CONFLICT';
        throw err;
      }
    }, 'DNS settings saved');
    setBusy(false);
    if (ok || settingsConflict) await load();
  };

  const clearToken = async () => {
    if (!confirm('Remove the Cloudflare API token? This disables DNS automation.')) return;
    await run(
      () => api.setDns({ cloudflareToken: '', expectedRevision: dns.revision }),
      'Token cleared',
    );
    await load();
  };

  const test = async () => {
    setTesting(true);
    setTestResult('Testing…');
    try {
      const candidate: Record<string, unknown> = {
        baseDomain,
        cloudflareZoneId: zoneId,
        ipCheckUrl,
      };
      if (token.trim()) candidate.cloudflareToken = token.trim();
      const r = await api.testDns(candidate);
      setZoneName(r.zoneName ?? '');
      if (r.ok) {
        setValidatedFingerprint(fingerprint(dns.hasToken));
        setTestResult(`✓ Public IP ${r.publicIp}`);
        toastSuccess('DNS configuration test passed');
      } else {
        setValidatedFingerprint(null);
        setTestResult(`✗ ${r.error}`);
      }
    } catch (err) {
      setValidatedFingerprint(null);
      setTestResult(`✗ ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const reconcile = async () => {
    setSyncing(true);
    try {
      const { reconciliation } = await api.reconcileDns();
      setReconciliation(reconciliation);
      if (reconciliation.ok) toastSuccess('DNS records synchronized');
      else toastError('DNS synchronization completed with errors');
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const configurationComplete = Boolean(
    baseDomain.trim() &&
      zoneId.trim() &&
      (token.trim() || dns.hasToken) &&
      ipCheckUrl.trim(),
  );
  const tested = configurationComplete && validatedFingerprint === fingerprint(dns.hasToken);

  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>
          DNS / Cloudflare{' '}
          <span className={`badge ${dns.enabled ? 'running' : 'stopped'}`} style={{ marginLeft: 6 }}>
            <span className="dot" />
            {dns.enabled ? 'Active' : 'Off'}
          </span>
        </h2>
        <button className="primary" disabled={busy || !tested} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save & enable DNS'}
        </button>
      </div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        Test the configuration before enabling automatic per-server SRV records + DDNS. Settings
        are stored in the app's database (not env). Use a token with{' '}
        <span className="mono">Zone:DNS:Edit</span> for the selected zone.
      </div>

      <div className="row">
        <div className="grow">
          <label>Server domain</label>
          <input
            className="mono"
            aria-label="Server domain"
            placeholder="mydomain.com"
            value={baseDomain}
            onChange={(e) => setBaseDomain(e.target.value)}
          />
          <div className="small muted" style={{ marginTop: 4 }}>
            The zone itself or a namespace beneath it, such as games.mydomain.com.
          </div>
        </div>
        <div className="grow">
          <label>Generated host record (SRV target + A record)</label>
          <input
            className="mono"
            aria-label="Generated host record"
            value={derivedHostRecord(baseDomain)}
            readOnly
          />
          <div className="small muted" style={{ marginTop: 4 }}>
            Generated automatically and shared by every server instance.
          </div>
        </div>
      </div>

      <DnsRecordsPreview baseDomain={baseDomain} />

      <div className="row">
        <div className="grow">
          <label>Cloudflare Zone ID</label>
          <input
            className="mono"
            aria-label="Cloudflare Zone ID"
            value={zoneId}
            onChange={(e) => {
              setZoneId(e.target.value);
              setZoneName('');
            }}
          />
        </div>
        <div className="grow">
          <label>Cloudflare zone name (verified)</label>
          <input
            className="mono"
            aria-label="Cloudflare zone name"
            placeholder="Populated after a successful test"
            value={zoneName}
            readOnly
          />
        </div>
      </div>

      <div className="row">
        <div className="grow">
          <label>API token {dns.hasToken ? '(set — blank keeps it)' : '(not set)'}</label>
          <input
            type="password"
            aria-label="API token"
            autoComplete="new-password"
            placeholder={dns.hasToken ? '••••••••' : 'Cloudflare API token'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="grow" />
      </div>

      <div
        className="small muted"
        style={{
          margin: '4px 0 12px',
          padding: 10,
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        <strong>Finding your Zone ID:</strong> In Cloudflare, open your account and select the
        domain. On its Overview page, find the API section and click <strong>Click to copy</strong>{' '}
        beside <strong>Zone ID</strong>. Do not use the Account ID.{' '}
        <a
          href="https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/"
          target="_blank"
          rel="noreferrer"
        >
          Cloudflare instructions
        </a>
        .
      </div>

      <div className="row">
        <div className="grow">
          <label>DDNS check interval (seconds)</label>
          <input
            type="number"
            aria-label="DDNS check interval"
            min={30}
            value={interval}
            onChange={(e) => setIntervalSecs(Number(e.target.value))}
          />
        </div>
        <div className="grow">
          <label>Public-IP check URL</label>
          <input
            className="mono"
            aria-label="Public-IP check URL"
            value={ipCheckUrl}
            onChange={(e) => setIpCheckUrl(e.target.value)}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 14, alignItems: 'center' }}>
        <button onClick={() => void test()} disabled={testing || !configurationComplete}>
          {testing ? 'Testing…' : 'Test configuration'}
        </button>
        {dns.hasToken && (
          <button className="danger ghost" onClick={() => void clearToken()}>
            Clear token (disable)
          </button>
        )}
        {testResult && (
          <span
            className="small"
            style={{ color: testResult.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}
          >
            {testResult}
          </span>
        )}
        {!tested && configurationComplete && !testing && (
          <span className="small muted">Test the current values before saving.</span>
        )}
      </div>

      {dns.enabled && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div className="spread" style={{ alignItems: 'center' }}>
            <div>
              <strong>DNS synchronization</strong>
              {reconciliation && (
                <span
                  className={`badge ${reconciliation.ok ? 'running' : 'stopped'}`}
                  style={{ marginLeft: 8 }}
                >
                  {reconciliation.ok ? 'Healthy' : 'Errors'}
                </span>
              )}
            </div>
            <button onClick={() => void reconcile()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync DNS now'}
            </button>
          </div>
          {!reconciliation && (
            <div className="small muted" style={{ marginTop: 8 }}>
              No synchronization has run since the manager started.
            </div>
          )}
          {reconciliation && (
            <div className="small" style={{ marginTop: 8 }}>
              <div className="muted">
                Last run {new Date(reconciliation.lastRun).toLocaleString()}
                {reconciliation.publicIp ? ` · public IP ${reconciliation.publicIp}` : ''}
              </div>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {reconciliation.records.map((record) => (
                  <div
                    key={`${record.type}:${record.serverId ?? record.name}`}
                    style={{ color: record.ok ? 'var(--green)' : 'var(--red)' }}
                  >
                    {record.ok ? '✓' : '✗'} {record.type}{' '}
                    <span className="mono">{record.name}</span>
                    {record.action ? ` · ${record.action}` : ''}
                    {record.error ? ` · ${record.error}` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Live preview of the DNS records that will be created. The shared host target
 * is derived from the base domain and updates as the user types.
 */
const derivedHostRecord = (baseDomain: string) => {
  const base = baseDomain.trim().toLowerCase().replace(/\.$/, '');
  return base ? `factorio-tools-manager.${base}` : '';
};

function DnsRecordsPreview({ baseDomain }: { baseDomain: string }) {
  const base = baseDomain.trim().toLowerCase();
  if (!base) {
    return (
      <div className="small muted" style={{ margin: '4px 0 12px' }}>
        Set a base domain to preview the DNS records that will be created.
      </div>
    );
  }
  const host = derivedHostRecord(base);
  return (
    <div className="small muted" style={{ margin: '4px 0 12px', lineHeight: 1.7 }}>
      <div>
        <strong>Preview</strong> (updates as you type):
      </div>
      <div>
        A record <span className="mono">{host}</span> → your public IP
      </div>
      <div>
        Example server <span className="mono">factory1</span> connects to{' '}
        <span className="mono">factory1.{base}</span>
      </div>
      <div>
        via SRV <span className="mono">_factorio._udp.factory1.{base}</span> →{' '}
        <span className="mono">{host}:34197</span>
      </div>
    </div>
  );
}
