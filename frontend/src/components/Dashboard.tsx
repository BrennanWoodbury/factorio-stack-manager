import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { DraftDto, Server, ServerStatus, SystemStatus } from '../types';
import { toastError } from '../ui';
import { CreateServerForm } from './CreateServerForm';
import { StatusBadge } from './StatusBadge';
import { LifecycleControls } from './LifecycleControls';

/** "expires in 22h" / "expires in 8 min" from an absolute deadline. */
function expiresLabel(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expiring…';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `expires in ${h}h`;
  return `expires in ${Math.max(1, Math.floor(ms / 60_000))} min`;
}
const SOURCE_LABEL: Record<string, string> = {
  generate: 'Generate',
  import: 'Import string',
  save: 'From save',
};

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [drafts, setDrafts] = useState<DraftDto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      setDrafts((await api.listDrafts()).drafts);
    } catch {
      /* non-critical */
    }
  }, []);

  const refresh = useCallback(async () => {
    const { servers } = await api.listServers();
    setServers(servers);
    const results = await Promise.all(
      servers.map((s) => api.status(s.id).catch(() => null)),
    );
    const map: Record<string, ServerStatus> = {};
    results.forEach((r, i) => {
      if (r) map[servers[i].id] = r;
    });
    setStatuses(map);
    void loadDrafts();
  }, [loadDrafts]);

  const openNew = () => {
    setResumeId(null);
    setShowCreate(true);
  };
  const resumeDraft = (id: string) => {
    setResumeId(id);
    setShowCreate(true);
  };
  const discardDraft = async (id: string) => {
    try {
      await api.discardDraft(id);
      await loadDrafts();
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    void api.systemStatus().then(setSystem).catch(() => {});
    const t = setInterval(() => void refresh(), 5000);
    const t2 = setInterval(() => void api.systemStatus().then(setSystem).catch(() => {}), 10000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [refresh]);

  return (
    <>
      {system && <SystemPanel system={system} />}

      <div className="spread" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Servers ({servers.length})</h2>
        <button className="primary" onClick={openNew}>
          + New server
        </button>
      </div>

      {servers.length === 0 && drafts.length === 0 && (
        <div className="panel muted">No servers yet. Create one to get started.</div>
      )}

      {servers.map((s) => {
        const st = statuses[s.id];
        const running = st?.running ?? s.status === 'running';
        return (
          <div key={s.id} className="server-card" onClick={() => onOpen(s.id)}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{s.name}</div>
              <div className="small muted mono">
                {s.connectHost ?? `port ${s.gamePort}`}
                {' · '}
                {s.subdomain}
              </div>
            </div>
            <div className="row" style={{ alignItems: 'center' }}>
              {running && st?.players && (
                <span className="small muted">
                  👥 {st.players.count}
                  {s.maxPlayers > 0 ? ` / ${s.maxPlayers}` : ''}
                </span>
              )}
              <StatusBadge running={running} />
              <LifecycleControls id={s.id} running={running} onChanged={refresh} small />
            </div>
          </div>
        );
      })}

      {drafts.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="spread" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>New server drafts ({drafts.length})</h2>
          </div>
          <div className="small muted" style={{ marginBottom: 12 }}>
            Unfinished — not created yet. Pick up where you left off, or discard.
          </div>
          <div className="panel" style={{ borderStyle: 'dashed' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {drafts.map((d) => (
                <div key={d.id} className="spread" style={{ gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{d.name || 'Untitled draft'}</span>
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      {SOURCE_LABEL[d.source] ?? d.source}
                      {d.expiresAt ? ` · ${expiresLabel(d.expiresAt)}` : ''}
                    </span>
                  </div>
                  <div className="row" style={{ flex: '0 0 auto' }}>
                    <button onClick={() => resumeDraft(d.id)}>Continue</button>
                    <button
                      className="danger ghost"
                      title="Discard this draft"
                      onClick={() => void discardDraft(d.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateServerForm
          dnsEnabled={system?.dns.enabled ?? false}
          baseDomain={system?.dns.baseDomain ?? null}
          resumeDraftId={resumeId ?? undefined}
          onClose={() => {
            setShowCreate(false);
            setResumeId(null);
            void loadDrafts(); // a dismissed draft may now exist / have changed
          }}
          onCreated={(id) => {
            setShowCreate(false);
            setResumeId(null);
            void refresh();
            onOpen(id);
          }}
        />
      )}
    </>
  );
}

function SystemPanel({ system }: { system: SystemStatus }) {
  return (
    <div className="panel">
      <div className="row" style={{ gap: 12 }}>
        <div className="stat">
          <div className="n" style={{ color: system.docker.ok ? 'var(--green)' : 'var(--red)' }}>
            {system.docker.ok ? 'OK' : 'DOWN'}
          </div>
          <div className="l">Docker</div>
        </div>
        <div className="stat">
          <div className="n">
            {system.ports.game.used}
            <span className="muted" style={{ fontSize: 14 }}>
              /{system.ports.game.total}
            </span>
          </div>
          <div className="l">Game ports used</div>
        </div>
        <div className="stat">
          <div className="n">{system.ports.rcon.free}</div>
          <div className="l">RCON ports free</div>
        </div>
        <div className="stat">
          <div className="n" style={{ color: system.dns.enabled ? 'var(--green)' : 'var(--muted)' }}>
            {system.dns.enabled ? 'ON' : 'OFF'}
          </div>
          <div className="l">DNS automation</div>
        </div>
        {system.version && (
          <div className="stat" title="Include this in any bug report">
            <div className="n mono" style={{ fontSize: 15 }}>
              {system.version}
            </div>
            <div className="l">Version</div>
          </div>
        )}
        {system.dns.enabled && (
          <div className="stat">
            <div className="n mono" style={{ fontSize: 15 }}>
              {system.ddns.lastIp ?? '—'}
            </div>
            <div className="l">Public IP {system.ddns.lastError ? '(error)' : ''}</div>
          </div>
        )}
      </div>
      {system.dns.enabled && (
        <div className="small muted" style={{ marginTop: 10 }}>
          SRV target: <span className="mono">{system.dns.hostRecord}</span> · base domain{' '}
          <span className="mono">{system.dns.baseDomain}</span>
          {system.ddns.lastError && (
            <span style={{ color: 'var(--red)' }}> · DDNS: {system.ddns.lastError}</span>
          )}
        </div>
      )}
      {!system.docker.ok && system.docker.error && (
        <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>
          Docker: {system.docker.error}
        </div>
      )}
    </div>
  );
}
