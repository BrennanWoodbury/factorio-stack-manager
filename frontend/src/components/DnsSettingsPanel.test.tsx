import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../api';
import { DnsSettingsPanel } from './DnsSettingsPanel';
import type { DnsSettings } from '../types';

const apiMocks = vi.hoisted(() => ({
  getDns: vi.fn(),
  setDns: vi.fn(),
  testDns: vi.fn(),
  reconcileDns: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: apiMocks };
});

/** A fresh install: the switch defaults on, but nothing is configured yet. */
const unconfiguredDns: DnsSettings = {
  revision: 0,
  baseDomain: '',
  hostRecordName: '',
  cloudflareZoneId: '',
  cloudflareZoneName: '',
  hasToken: false,
  ddnsIntervalSeconds: 300,
  ipCheckUrl: 'https://api.ipify.org',
  enabled: true,
  configured: false,
  active: false,
};

beforeEach(() => {
  apiMocks.getDns.mockResolvedValue({ dns: unconfiguredDns });
  apiMocks.testDns.mockResolvedValue({
    ok: true,
    zoneName: 'example.com',
    publicIp: '203.0.113.42',
  });
  apiMocks.setDns.mockResolvedValue({
    dns: {
      ...unconfiguredDns,
      revision: 1,
      baseDomain: 'games.example.com',
      hostRecordName: 'factorio-tools-manager.games.example.com',
      cloudflareZoneId: 'zone-123',
      cloudflareZoneName: 'example.com',
      hasToken: true,
      enabled: true,
      configured: true,
      active: true,
    },
  });
  apiMocks.reconcileDns.mockResolvedValue({
    reconciliation: {
      ok: true,
      lastRun: '2026-07-25T00:00:00.000Z',
      publicIp: '203.0.113.42',
      records: [
        {
          type: 'A',
          name: 'factorio-tools-manager.games.example.com',
          ok: true,
          action: 'updated',
        },
      ],
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DnsSettingsPanel', () => {
  test('tests unsaved settings before enabling them', async () => {
    render(<DnsSettingsPanel />);

    expect(await screen.findByRole('heading', { name: /DNS \/ Cloudflare/ })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save & enable DNS' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Server domain' }), {
      target: { value: 'games.example.com' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Cloudflare Zone ID' }), {
      target: { value: 'zone-123' },
    });
    const tokenInput = screen.getByLabelText('API token');
    expect(tokenInput.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(tokenInput, {
      target: { value: 'candidate-token' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    await waitFor(() =>
      expect(apiMocks.testDns).toHaveBeenCalledWith({
        baseDomain: 'games.example.com',
        cloudflareZoneId: 'zone-123',
        cloudflareToken: 'candidate-token',
        ipCheckUrl: 'https://api.ipify.org',
      }),
    );
    expect(await screen.findByText('✓ Public IP 203.0.113.42')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Generated host record' }) as HTMLInputElement).value)
      .toBe('factorio-tools-manager.games.example.com');
    expect(
      (screen.getByRole('textbox', { name: 'Generated host record' }) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Cloudflare Zone ID' }) as HTMLInputElement).value)
      .toBe('zone-123');
    expect((screen.getByRole('textbox', { name: 'Cloudflare zone name' }) as HTMLInputElement).value)
      .toBe('example.com');
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(apiMocks.setDns).toHaveBeenCalledOnce());
    expect(apiMocks.setDns).toHaveBeenCalledWith({
      expectedRevision: 0,
      enabled: true,
      baseDomain: 'games.example.com',
      cloudflareZoneId: 'zone-123',
      cloudflareToken: 'candidate-token',
      ddnsIntervalSeconds: 300,
      ipCheckUrl: 'https://api.ipify.org',
    });
    expect(apiMocks.setDns.mock.calls[0][0]).not.toHaveProperty('hostRecordName');
  });

  test('links directly to Cloudflare Zone ID instructions', async () => {
    render(<DnsSettingsPanel />);
    const link = await screen.findByRole('link', { name: 'Cloudflare instructions' });
    expect(link.getAttribute('href')).toBe(
      'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
    );
  });

  test('reloads current settings when another admin saved first', async () => {
    const activeDns: DnsSettings = {
      ...unconfiguredDns,
      revision: 4,
      baseDomain: 'games.example.com',
      hostRecordName: 'factorio-tools-manager.games.example.com',
      cloudflareZoneId: 'zone-123',
      cloudflareZoneName: 'example.com',
      hasToken: true,
      enabled: true,
      configured: true,
      active: true,
    };
    apiMocks.getDns.mockResolvedValue({ dns: activeDns });
    apiMocks.setDns.mockRejectedValue(
      new ApiError('DNS settings changed in another session', 'DNS_SETTINGS_CONFLICT', 409),
    );
    render(<DnsSettingsPanel />);

    const save = await screen.findByRole('button', { name: 'Save & enable DNS' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(apiMocks.getDns).toHaveBeenCalledTimes(2));
    expect(apiMocks.setDns).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4 }),
    );
  });

  test('runs manual reconciliation and shows per-record health', async () => {
    apiMocks.getDns.mockResolvedValue({
      dns: {
        ...unconfiguredDns,
        baseDomain: 'games.example.com',
        hostRecordName: 'factorio-tools-manager.games.example.com',
        cloudflareZoneId: 'zone-123',
        cloudflareZoneName: 'example.com',
        hasToken: true,
        enabled: true,
        configured: true,
        active: true,
      },
    });
    render(<DnsSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync DNS now' }));

    await waitFor(() => expect(apiMocks.reconcileDns).toHaveBeenCalledOnce());
    expect(await screen.findByText('Healthy')).toBeTruthy();
    expect(screen.getAllByText(/factorio-tools-manager\.games\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/updated/)).toBeTruthy();
  });
});
