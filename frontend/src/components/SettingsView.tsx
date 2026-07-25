import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { DefaultsView } from './DefaultsView';
import { GlobalAdvancedSettings } from './GlobalAdvancedSettings';
import { FactorioAccountPanel } from './FactorioAccountPanel';
import { DnsSettingsPanel } from './DnsSettingsPanel';
import { WhitelistPanel } from './WhitelistPanel';

type Group = 'shared' | 'manager';

interface Subsection {
  key: string;
  label: string;
  group: Group;
  render: () => ReactNode;
}

const GROUPS: { id: Group; label: string; hint: string }[] = [
  { id: 'shared', label: 'Shared across instances', hint: 'Applied to every Factorio server.' },
  { id: 'manager', label: 'Manager config', hint: 'The manager itself.' },
];

/**
 * The settings registry. Each entry reuses an existing panel component unchanged —
 * this page only relocates and groups them. Add future manager-level settings
 * (auth, network/ports, storage) as new `manager` entries.
 */
const SECTIONS: Subsection[] = [
  { key: 'account', label: 'Factorio.com account', group: 'shared', render: () => <FactorioAccountPanel /> },
  { key: 'defaults', label: 'Server defaults', group: 'shared', render: () => <DefaultsView /> },
  { key: 'advanced', label: 'Advanced defaults', group: 'shared', render: () => <GlobalAdvancedSettings /> },
  {
    key: 'whitelist',
    label: 'Global whitelist',
    group: 'shared',
    render: () => (
      <WhitelistPanel
        title="Global whitelist"
        description="These Factorio usernames may join every server, on top of each server's own whitelist. Leave empty to disable. Applies to each server on its next start/restart."
        load={async () => (await api.getGlobalWhitelist()).whitelist}
        save={async (names) => (await api.setGlobalWhitelist(names)).whitelist}
      />
    ),
  },
  {
    key: 'admins',
    label: 'Global admin list',
    group: 'shared',
    render: () => (
      <WhitelistPanel
        title="Global admins"
        description="These Factorio usernames are admins on every server, on top of each server's own admin list. Applies to each server on its next start/restart."
        addLabel="Add user to admin list"
        saveLabel="Save admin list"
        hint={(n) => (n === 0 ? 'No global admins.' : `${n} admin${n === 1 ? '' : 's'}.`)}
        load={async () => (await api.getGlobalAdminlist()).adminlist}
        save={async (names) => (await api.setGlobalAdminlist(names)).adminlist}
      />
    ),
  },
  { key: 'dns', label: 'DNS / Cloudflare', group: 'manager', render: () => <DnsSettingsPanel /> },
];

/** Read the `#settings/<key>` deep-link, falling back to the first section. */
function keyFromHash(): string {
  const m = window.location.hash.match(/^#settings\/([\w-]+)$/);
  const key = m?.[1];
  return SECTIONS.some((s) => s.key === key) ? (key as string) : SECTIONS[0].key;
}

/**
 * Global settings page: a left rail grouped into "Shared across instances" and
 * "Manager config", with the selected subsection rendered on the right. The active
 * subsection is mirrored to the URL hash so it can be linked directly.
 */
export function SettingsView() {
  const [active, setActive] = useState<string>(keyFromHash);

  // Keep the hash in sync (and respond to back/forward + external hash changes).
  useEffect(() => {
    if (window.location.hash !== `#settings/${active}`) {
      window.history.replaceState(null, '', `#settings/${active}`);
    }
    const onHash = () => setActive(keyFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [active]);

  const current = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];

  return (
    <div className="settings-layout">
      <nav className="settings-rail">
        {GROUPS.map((g) => (
          <div key={g.id} className="grp">
            <div className="grp-label" title={g.hint}>
              {g.label}
            </div>
            {SECTIONS.filter((s) => s.group === g.id).map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item${s.key === active ? ' active' : ''}`}
                onClick={() => setActive(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div key={current.key} className="settings-content">
        {current.render()}
      </div>
    </div>
  );
}
