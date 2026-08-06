import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Server, ServerStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { Console } from './Console';
import { ContainerLogs } from './ContainerLogs';
import { SavesPanel } from './SavesPanel';
import { BackupsPanel } from './BackupsPanel';
import { ModsPanel } from './ModsPanel';
import { MapGenPanel } from './MapGenPanel';
import { SettingsPanel } from './SettingsPanel';
import { LifecycleControls } from './LifecycleControls';
import { toastError } from '../ui';

type Tab = 'overview' | 'console' | 'logs' | 'saves' | 'mapgen' | 'mods' | 'settings';
const TABS: Tab[] = ['overview', 'console', 'logs', 'saves', 'mapgen', 'mods', 'settings'];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  console: 'Console',
  logs: 'Logs',
  saves: 'Saves',
  mapgen: 'Map gen',
  mods: 'Mods',
  settings: 'Settings',
};

export function ServerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [server, setServer] = useState<Server | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: Tab = (TABS as string[]).includes(requested ?? '') ? (requested as Tab) : 'overview';
  const setTab = (t: Tab) => setSearchParams(t === 'overview' ? {} : { tab: t });

  const load = useCallback(async () => {
    try {
      const [{ server }, st] = await Promise.all([api.getServer(id), api.status(id).catch(() => null)]);
      setServer(server);
      if (st) setStatus(st);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void api.status(id).then(setStatus).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [id, load]);

  if (!server) return <div className="muted">Loading…</div>;
  const running = status?.running ?? server.status === 'running';

  return (
    <>
      <button className="ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Back
      </button>

      <div className="panel">
        <div className="spread">
          <div>
            <div className="row" style={{ alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>{server.name}</h2>
              <StatusBadge status={status?.status ?? server.status} />
            </div>
            <div className="small muted mono" style={{ marginTop: 4 }}>
              {server.connectHost ? (
                <>connect: {server.connectHost} · </>
              ) : null}
              game port {server.gamePort} · rcon 127.0.0.1:{server.rconPort} (loopback)
            </div>
          </div>
          <LifecycleControls id={id} running={running} onChanged={load} />
        </div>
        {running && status?.players && (
          <div className="small muted" style={{ marginTop: 10 }}>
            👥 {status.players.count} online
            {status.players.names.length > 0 ? `: ${status.players.names.join(', ')}` : ''}
          </div>
        )}
        {status?.playersError && (
          <div className="small" style={{ color: 'var(--muted)', marginTop: 8 }}>
            Player list unavailable ({status.playersError})
          </div>
        )}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </div>
        ))}
      </div>

      {tab === 'overview' && <Overview server={server} status={status} />}
      {tab === 'console' && <Console id={id} running={running} />}
      {tab === 'logs' && <ContainerLogs id={id} running={running} />}
      {tab === 'saves' && (
        <>
          <SavesPanel server={server} onChanged={load} />
          <BackupsPanel server={server} onChanged={load} />
        </>
      )}
      {tab === 'mapgen' && <MapGenPanel server={server} />}
      {tab === 'mods' && <ModsPanel server={server} />}
      {tab === 'settings' && <SettingsPanel server={server} onChanged={load} onDeleted={onBack} />}
    </>
  );
}

function Overview({ server, status }: { server: Server; status: ServerStatus | null }) {
  const rows: [string, string][] = [
    ['Subdomain', server.subdomain],
    ['Connect host', server.connectHost ?? '(DNS off — use IP:port)'],
    ['Game port (UDP)', String(server.gamePort)],
    ['RCON port (loopback TCP)', String(server.rconPort)],
    ['Factorio image', server.factorioImage ?? '(default)'],
    ['Container ID', server.containerId ?? 'not created'],
    ['Selected save', server.saveName],
    ['Generate new save on start', server.generateNewSave ? 'yes' : 'no'],
    ['Factorio.com account (global)', server.hasFactorioCredentials ? 'set' : 'not set'],
    ['Container state', status?.status ?? server.status],
    ['Started at', status?.startedAt ? new Date(status.startedAt).toLocaleString() : '—'],
    ['Created', new Date(server.createdAt).toLocaleString()],
  ];
  return (
    <div className="panel">
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 220 }}>{k}</th>
              <td className="mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {server.description && <p className="muted" style={{ marginTop: 14 }}>{server.description}</p>}
    </div>
  );
}
