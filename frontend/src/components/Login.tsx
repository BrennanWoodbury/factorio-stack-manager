import { useState } from 'react';
import { api } from '../api';
import { toastError } from '../ui';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-box" onSubmit={submit}>
        <div style={{ textAlign: 'center', fontSize: 34 }}>🏭</div>
        <h2 style={{ textAlign: 'center' }}>Factorio Stack Manager</h2>
        <label>Admin password</label>
        <input
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="primary" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
