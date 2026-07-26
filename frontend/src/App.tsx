import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
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
import { Footer } from './components/Footer';
import { Toaster } from './ui';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

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

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Shell onLoggedOut={() => setAuthed(false)} />
    </BrowserRouter>
  );
}

function ServerDetailRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/servers" replace />;
  return <ServerDetail id={id} onBack={() => navigate('/servers')} />;
}

function ModpackDetailRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/modpacks" replace />;
  return <ModpackDetail id={id} onBack={() => navigate('/modpacks')} />;
}

function Shell({ onLoggedOut }: { onLoggedOut: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.startsWith('/modpacks')
    ? 'modpacks'
    : location.pathname.startsWith('/templates')
      ? 'templates'
      : location.pathname.startsWith('/settings')
        ? 'settings'
        : 'servers';

  return (
    <>
      <div className="app-shell">
        <header className="app-header">
          <div className="brand" style={{ cursor: 'pointer' }} onClick={() => navigate('/servers')}>
            <BrandMark size={26} />
            <h1>Factorio Server Manager</h1>
          </div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className={activeTab === 'servers' ? 'primary' : 'ghost'} onClick={() => navigate('/servers')}>
              Servers
            </button>
            <button className={activeTab === 'modpacks' ? 'primary' : 'ghost'} onClick={() => navigate('/modpacks')}>
              Modpacks
            </button>
            <button className={activeTab === 'templates' ? 'primary' : 'ghost'} onClick={() => navigate('/templates')}>
              World Generation
            </button>
            <button className={activeTab === 'settings' ? 'primary' : 'ghost'} onClick={() => navigate('/settings')}>
              Settings
            </button>
            <NotificationsCenter />
            <button
              className="ghost"
              onClick={async () => {
                await api.logout();
                onLoggedOut();
              }}
            >
              Log out
            </button>
          </div>
        </header>
        <div className="container">
          <Routes>
            <Route path="/" element={<Navigate to="/servers" replace />} />
            <Route path="/servers" element={<Dashboard onOpen={(id) => navigate(`/servers/${id}`)} />} />
            <Route path="/servers/:id" element={<ServerDetailRoute />} />
            <Route path="/modpacks" element={<ModpacksView onOpen={(id) => navigate(`/modpacks/${id}`)} />} />
            <Route path="/modpacks/:id" element={<ModpackDetailRoute />} />
            <Route path="/templates" element={<MapGenTemplatesView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/servers" replace />} />
          </Routes>
        </div>
        <Footer />
      </div>
      <Toaster />
    </>
  );
}
