import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsView } from './SettingsView';

const apiMocks = vi.hoisted(() => ({
  getGlobalWhitelist: vi.fn(),
  setGlobalWhitelist: vi.fn(),
  getGlobalAdminlist: vi.fn(),
  setGlobalAdminlist: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));

beforeEach(() => {
  window.location.hash = '#settings/whitelist';
  apiMocks.getGlobalWhitelist.mockResolvedValue({ whitelist: ['WhitelistUser'] });
  apiMocks.setGlobalWhitelist.mockResolvedValue({ whitelist: ['WhitelistUser'] });
  apiMocks.getGlobalAdminlist.mockResolvedValue({ adminlist: ['AdminUser'] });
  apiMocks.setGlobalAdminlist.mockResolvedValue({ adminlist: ['AdminUser'] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

describe('SettingsView user lists', () => {
  test('keeps the global whitelist and admin list isolated when switching sections', async () => {
    render(<SettingsView />);

    expect(await screen.findByDisplayValue('WhitelistUser')).toBeTruthy();
    expect(screen.getByText('Add user to whitelist')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Global admin list' }));

    expect(await screen.findByDisplayValue('AdminUser')).toBeTruthy();
    expect(screen.queryByDisplayValue('WhitelistUser')).toBeNull();
    expect(screen.getByText('Add user to admin list')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save admin list' })).toBeTruthy();
    expect(apiMocks.getGlobalAdminlist).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Save admin list' }));
    await waitFor(() => expect(apiMocks.setGlobalAdminlist).toHaveBeenCalledWith(['AdminUser']));
    expect(apiMocks.setGlobalWhitelist).not.toHaveBeenCalled();
  });
});
