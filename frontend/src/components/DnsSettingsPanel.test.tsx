import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DnsSettingsPanel } from './DnsSettingsPanel';
import type { DnsSettings } from '../types';

const apiMocks = vi.hoisted(() => ({
  getDns: vi.fn(),
  setDns: vi.fn(),
  testDns: vi.fn(),
  reconcileDns: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));

const disabledDns: DnsSettings = {
  baseDomain: '',
  hostRecordName: '',
  cloudflareZoneId: '',
  hasToken: false,
  ddnsIntervalSeconds: 300,
  ipCheckUrl: 'https://api.ipify.org',
  enabled: false,
};

beforeEach(() => {
  apiMocks.getDns.mockResolvedValue({ dns: disabledDns });
  apiMocks.testDns.mockResolvedValue({
    ok: true,
    zoneName: 'example.com',
    publicIp: '203.0.113.42',
  });
  apiMocks.setDns.mockResolvedValue({
    dns: {
      ...disabledDns,
      baseDomain: 'games.example.com',
      hostRecordName: 'host.games.example.com',
      cloudflareZoneId: 'zone-123',
      hasToken: true,
      enabled: true,
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
          name: 'host.games.example.com',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Host record' }), {
      target: { value: 'host.games.example.com' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Cloudflare Zone ID' }), {
      target: { value: 'zone-123' },
    });
    fireEvent.change(screen.getByLabelText('API token'), {
      target: { value: 'candidate-token' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    await waitFor(() =>
      expect(apiMocks.testDns).toHaveBeenCalledWith({
        baseDomain: 'games.example.com',
        hostRecordName: 'host.games.example.com',
        cloudflareZoneId: 'zone-123',
        cloudflareToken: 'candidate-token',
        ipCheckUrl: 'https://api.ipify.org',
      }),
    );
    expect(await screen.findByText('✓ Zone example.com; public IP 203.0.113.42')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(apiMocks.setDns).toHaveBeenCalledOnce());
  });

  test('links directly to Cloudflare Zone ID instructions', async () => {
    render(<DnsSettingsPanel />);
    const link = await screen.findByRole('link', { name: 'Cloudflare instructions' });
    expect(link.getAttribute('href')).toBe(
      'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
    );
  });

  test('runs manual reconciliation and shows per-record health', async () => {
    apiMocks.getDns.mockResolvedValue({
      dns: {
        ...disabledDns,
        baseDomain: 'games.example.com',
        hostRecordName: 'host.games.example.com',
        cloudflareZoneId: 'zone-123',
        hasToken: true,
        enabled: true,
      },
    });
    render(<DnsSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync DNS now' }));

    await waitFor(() => expect(apiMocks.reconcileDns).toHaveBeenCalledOnce());
    expect(await screen.findByText('Healthy')).toBeTruthy();
    expect(screen.getAllByText(/host\.games\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/updated/)).toBeTruthy();
  });
});
