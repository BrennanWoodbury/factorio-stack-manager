import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Server } from '../types';
import { ServerDetail } from './ServerDetail';

const apiMocks = vi.hoisted(() => ({
  getServer: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));

const server = (containerId: string | null): Server => ({
  id: 'server-1', name: 'Nauvis', subdomain: 'nauvis', description: '', maxPlayers: 0,
  gamePort: 34197, rconPort: 27015, saveName: 'world.zip', generateNewSave: false,
  gameMode: 'vanilla', hasFactorioCredentials: false, containerId, status: 'stopped',
  createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z', appliedModpackId: null,
  factorioTag: 'stable', autoRestart: false, dnsEnabled: false, autoBackup: false,
  backupIntervalMinutes: 60, backupKeep: 7, backupKeepManual: 7,
  overrides: { autoRestart: false, autoBackup: false, backupIntervalMinutes: false, backupKeep: false, backupKeepManual: false },
});

beforeEach(() => {
  apiMocks.status.mockResolvedValue({ id: 'server-1', status: 'stopped', running: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ServerDetail overview', () => {
  test('shows the full container ID in the server overview', async () => {
    const id = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    apiMocks.getServer.mockResolvedValue({ server: server(id) });

    render(<ServerDetail id="server-1" onBack={vi.fn()} />);

    expect(await screen.findByText('Container ID')).toBeTruthy();
    expect(screen.getByText(id)).toBeTruthy();
  });

  test('identifies a server that has not created a container yet', async () => {
    apiMocks.getServer.mockResolvedValue({ server: server(null) });

    render(<ServerDetail id="server-1" onBack={vi.fn()} />);

    expect(await screen.findByText('not created')).toBeTruthy();
  });
});
