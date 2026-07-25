import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { ServerDetail } from './components/ServerDetail';
import { ModpacksView } from './components/ModpacksView';
import { ModpackDetail } from './components/ModpackDetail';
import { MapGenTemplatesView } from './components/MapGenTemplatesView';
import { SettingsView } from './components/SettingsView';
import { NotificationsCenter } from './components/NotificationsCenter';
import { BrandMark } from './components/BrandMark';
import { Toaster } from './ui';

type Tab = 'servers' | 'modpacks' | 'templates' | 'settings';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('servers');
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [selectedPack, setSelectedPack] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const r = await api.me();
      setAuthed(r.authenticated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthed(false);
      else setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  if (authed === null) {
    return <div className="login-wrap muted">Loading…</div>;
  }
  if (!authed) {
    return (
      <>
        <Login onLoggedIn={() => setAuthed(true)} />
        <Toaster />
      </>
    );
  }

  const go = (t: Tab) => {
    setTab(t);
    setSelectedServer(null);
    setSelectedPack(null);
  };

  return (
    <>
      <header className="app-header">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => go('servers')}>
          <BrandMark size={26} />
          <h1>Factorio Server Manager</h1>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <button className={tab === 'servers' ? 'primary' : 'ghost'} onClick={() => go('servers')}>
            Servers
          </button>
          <button className={tab === 'modpacks' ? 'primary' : 'ghost'} onClick={() => go('modpacks')}>
            Modpacks
          </button>
          <button className={tab === 'templates' ? 'primary' : 'ghost'} onClick={() => go('templates')}>
            World Generation
          </button>
          <button className={tab === 'settings' ? 'primary' : 'ghost'} onClick={() => go('settings')}>
            Settings
          </button>
          <NotificationsCenter />
          <button
            className="ghost"
            onClick={async () => {
              await api.logout();
              setAuthed(false);
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <div className="container">
        {tab === 'servers' &&
          (selectedServer ? (
            <ServerDetail id={selectedServer} onBack={() => setSelectedServer(null)} />
          ) : (
            <Dashboard onOpen={setSelectedServer} />
          ))}
        {tab === 'modpacks' &&
          (selectedPack ? (
            <ModpackDetail id={selectedPack} onBack={() => setSelectedPack(null)} />
          ) : (
            <ModpacksView onOpen={setSelectedPack} />
          ))}
        {tab === 'templates' && <MapGenTemplatesView />}
        {tab === 'settings' && <SettingsView />}
      </div>
      <Toaster />
    </>
  );
}
