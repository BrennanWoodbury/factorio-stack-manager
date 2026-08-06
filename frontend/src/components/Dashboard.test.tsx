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
  status: 'stopped', createdAt: '', updatedAt: '', appliedModpackId: null, factorioTag: 'stable',
  autoRestart: false, dnsEnabled: false, autoBackup: false, backupIntervalMinutes: 60,
  backupKeep: 7, backupKeepManual: 7,
  overrides: { autoRestart: false, autoBackup: false, backupIntervalMinutes: false, backupKeep: false, backupKeepManual: false },
};

beforeEach(() => {
  apiMocks.listServers.mockResolvedValue({ servers: [server] });
  apiMocks.listDrafts.mockResolvedValue({ drafts: [] });
  apiMocks.status.mockResolvedValue({ id: 'server-1', status: 'stopped', running: false });
  apiMocks.systemStatus.mockRejectedValue(new Error('not relevant to this test'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Dashboard', () => {
  test('does not show container IDs outside an individual server overview', async () => {
    render(<Dashboard onOpen={vi.fn()} />);

    await screen.findByText('Nauvis');
    expect(screen.queryByText(server.containerId!)).toBeNull();
    expect(screen.queryByText('Container ID')).toBeNull();
  });
});
