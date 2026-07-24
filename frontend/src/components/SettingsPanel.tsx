import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DnsSettings, GlobalDefaults, Server } from '../types';
import { run, toast } from '../ui';
import { AdvancedSettings } from './AdvancedSettings';
import { WhitelistPanel } from './WhitelistPanel';
import { FactorioTagSelect } from './FactorioTagSelect';
import { DnsNamePreview } from './DnsNamePreview';
import { OverridableField } from './OverridableField';

export function SettingsPanel({
  server,
  onChanged,
  onDeleted,
}: {
  server: Server;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(server.name);
  const [subdomain, setSubdomain] = useState(server.subdomain);
  const [maxPlayers, setMaxPlayers] = useState(server.maxPlayers);
  const [description, setDescription] = useState(server.description);
  const [factorioTag, setFactorioTag] = useState(server.factorioTag);
  const [dns, setDns] = useState<DnsSettings | null>(null);
  const [defaults, setDefaults] = useState<GlobalDefaults | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getDns().then((r) => setDns(r.dns)).catch(() => {});
    api.getGlobalDefaults().then((r) => setDefaults(r.defaults)).catch(() => {});
  }, []);

  const running = server.status === 'running';

  const save = async () => {
    setBusy(true);
    const patch: Record<string, unknown> = {
      name,
      subdomain,
      maxPlayers,
      description,
      factorioTag,
    };
    const ok = await run(() => api.updateServer(server.id, patch), 'Settings saved');
    if (ok && server.autoRestart && running) {
      toast('Auto-restarting the server to apply changes…', 'info');
    }
    setBusy(false);
    onChanged();
  };

  const remove = async () => {
    if (!confirm(`Delete server "${server.name}"? This removes the container, DNS record, ports and all data.`))
      return;
    const ok = await run(() => api.deleteServer(server.id), 'Server deleted');
    if (ok) onDeleted();
  };

  return (
    <>
      <div className="panel">
        <h2>Settings</h2>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />

        <label>Subdomain (changing this updates the SRV record)</label>
        <input value={subdomain} onChange={(e) => setSubdomain(e.target.value.toLowerCase())} />
        <DnsNamePreview
          subdomain={subdomain}
          baseDomain={dns?.baseDomain}
          enabled={dns?.enabled ?? false}
        />

        <label>Max players (0 = unlimited)</label>
        <input type="number" min={0} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />

        <label>Description</label>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />

        <FactorioTagSelect value={factorioTag} onChange={setFactorioTag} />
        <div className="small muted" style={{ marginTop: 4 }}>
          Currently runs <span className="mono">{server.factorioImage ?? 'the default image'}</span>.
          The image is pulled (checking for updates) on every start/restart.
        </div>

        <div style={{ marginTop: 14 }}>
          {defaults && (
            <OverridableField
              label="Auto-restart this server when settings change"
              kind="bool"
              value={server.autoRestart}
              globalValue={defaults.autoRestart}
              overridden={server.overrides.autoRestart}
              onCommit={(v) =>
                void run(() => api.updateServer(server.id, { autoRestart: v }), 'Saved').then(
                  (ok) => ok && onChanged(),
                )
              }
              onReset={() =>
                void run(() => api.resetServerSetting(server.id, 'autoRestart'), 'Reset to global default').then(
                  (ok) => ok && onChanged(),
                )
              }
            />
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            When on, saving a change that needs a restart (version/tag, server settings, mods,
            whitelist) automatically restarts the server if it's running — otherwise changes apply on
            the next manual start.
          </div>
        </div>

        <div className="small muted" style={{ marginTop: 12 }}>
          Factorio.com credentials (mods & public listing) are a global setting on the Servers
          dashboard — {server.hasFactorioCredentials ? 'currently set' : 'not set yet'}.
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          <span className="small muted" style={{ alignSelf: 'center' }}>
            Name/players/description apply on next start.
          </span>
        </div>
      </div>

      <AdvancedSettings serverId={server.id} />

      <WhitelistPanel
        title="Player whitelist"
        description="Only these Factorio usernames may join this server (in addition to the global whitelist). Applies on next start/restart."
        load={async () => (await api.getWhitelist(server.id)).whitelist}
        save={async (names) => (await api.setWhitelist(server.id, names)).whitelist}
      />

      <WhitelistPanel
        title="Server admins"
        description="These Factorio usernames are admins on this server (in addition to the global admin list). Applies on next start/restart."
        addLabel="Add user to admin list"
        saveLabel="Save admin list"
        hint={(n) => (n === 0 ? 'No admins set.' : `${n} admin${n === 1 ? '' : 's'}.`)}
        load={async () => (await api.getAdminlist(server.id)).adminlist}
        save={async (names) => (await api.setAdminlist(server.id, names)).adminlist}
      />

      <div className="panel" style={{ borderColor: 'var(--red)' }}>
        <h2 style={{ color: 'var(--red)' }}>Danger zone</h2>
        <div className="spread">
          <span className="muted small">
            Permanently delete this server, its container, DNS record, port allocation and data.
          </span>
          <button className="danger" onClick={() => void remove()}>
            Delete server
          </button>
        </div>
      </div>
    </>
  );
}
