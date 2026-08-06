import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Server } from '../types';
import { Dashboard } from './Dashboard';

const apiMocks = vi.hoisted(() => ({
  listServers: vi.fn(),
  listDrafts: vi.fn(),
  status: vi.fn(),
  systemStatus: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const server: Server = {
  id: 'server-1', name: 'Nauvis', subdomain: 'nauvis', description: '', maxPlayers: 0,
  gamePort: 34197, rconPort: 27015, saveName: 'world.zip', generateNewSave: false,
  gameMode: 'vanilla', hasFactorioCredentials: false,
  containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  status: 'running', createdAt: '', updatedAt: '', appliedModpackId: null, factorioTag: 'stable',
  factorioImage: 'factoriotools/factorio:stable', autoRestart: false, dnsEnabled: false,
  autoBackup: false, backupIntervalMinutes: 60, backupKeep: 7, backupKeepManual: 7,
  overrides: { autoRestart: false, autoBackup: false, backupIntervalMinutes: false, backupKeep: false, backupKeepManual: false },
};

beforeEach(() => {
  apiMocks.listServers.mockResolvedValue({ servers: [server] });
  apiMocks.listDrafts.mockResolvedValue({ drafts: [] });
  apiMocks.status.mockResolvedValue({ id: 'server-1', status: 'running', running: true, factorioVersion: '2.0.99' });
  apiMocks.systemStatus.mockRejectedValue(new Error('not relevant to this test'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Dashboard', () => {
  test('shows the running game version without repeating overview-only details', async () => {
    render(<Dashboard onOpen={vi.fn()} />);

    expect(await screen.findByText('Game Version: 2.0.99')).toBeTruthy();
    expect(screen.queryByText('Image: factoriotools/factorio:stable')).toBeNull();
    expect(screen.queryByText(server.containerId!)).toBeNull();
    expect(screen.queryByText('Container ID')).toBeNull();
  });
});
