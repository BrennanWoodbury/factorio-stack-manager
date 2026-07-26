import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  logout: vi.fn(),
  listServers: vi.fn(),
  status: vi.fn(),
  systemStatus: vi.fn(),
  listDrafts: vi.fn(),
  listModpacks: vi.fn(),
}));

vi.mock('./api', () => ({ api: apiMocks, ApiError: class ApiError extends Error {} }));

beforeEach(() => {
  window.history.pushState(null, '', '/');
  apiMocks.me.mockResolvedValue({ authenticated: true });
  apiMocks.listServers.mockResolvedValue({ servers: [] });
  apiMocks.systemStatus.mockResolvedValue(null);
  apiMocks.listDrafts.mockResolvedValue({ drafts: [] });
  apiMocks.listModpacks.mockResolvedValue({ modpacks: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('App navigation', () => {
  test('each tab switch is a real history entry, so Back steps through in-app pages', async () => {
    render(<App />);

    await screen.findByRole('button', { name: 'Modpacks' });
    expect(window.location.pathname).toBe('/servers');

    fireEvent.click(screen.getByRole('button', { name: 'Modpacks' }));
    await waitFor(() => expect(window.location.pathname).toBe('/modpacks'));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));

    // Back should undo the most recent in-app navigation (Settings -> Modpacks),
    // not fall through to whatever was in history before the SPA loaded.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/modpacks'));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/servers'));
  });
});
