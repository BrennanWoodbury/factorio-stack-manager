import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WizardMods } from './WizardMods';

const apiMocks = vi.hoisted(() => ({
  getMods: vi.fn(),
  putMods: vi.fn(),
  listModpacks: vi.fn(),
  applyModpack: vi.fn(),
  resolveModDependencies: vi.fn(),
  searchMods: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));

beforeEach(() => {
  apiMocks.getMods.mockResolvedValue({ mods: [{ name: 'base', enabled: true }] });
  apiMocks.listModpacks.mockResolvedValue({
    modpacks: [
      { id: 'pack1', name: 'Ribbon World', description: '', modCount: 2 },
      { id: 'pack2', name: 'Vanilla+', description: '', modCount: 5 },
    ],
  });
  apiMocks.applyModpack.mockResolvedValue({ serverId: 'draft1', downloaded: [], errors: [] });
  apiMocks.searchMods.mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WizardMods', () => {
  test('a saved modpack can be applied while creating a server', async () => {
    // The gap this closes: the wizard could only search the portal one mod at a
    // time, so a templated mod set had to be rebuilt by hand for every new server.
    const onSaved = vi.fn();
    render(<WizardMods draftId="draft1" onSaved={onSaved} />);

    const select = await screen.findByRole('combobox');
    expect(screen.getByText('Ribbon World (2 mods)')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'pack1' } });
    apiMocks.getMods.mockResolvedValue({
      mods: [
        { name: 'base', enabled: true },
        { name: 'flib', enabled: true },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));

    // Applied against the draft id — a draft is a server row to these endpoints.
    await waitFor(() => expect(apiMocks.applyModpack).toHaveBeenCalledWith('pack1', 'draft1'));
    expect(await screen.findByText('flib')).toBeTruthy();
  });

  test('applying reports the resulting mods to the wizard without a separate save', async () => {
    // Apply writes and downloads server-side, so making the user then press
    // "Save & download" would be asking them to re-save what is already saved.
    const onSaved = vi.fn();
    render(<WizardMods draftId="draft1" onSaved={onSaved} />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack2' } });
    apiMocks.getMods.mockResolvedValue({
      mods: [
        { name: 'base', enabled: true },
        { name: 'flib', enabled: true },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith([
        { name: 'base', enabled: true },
        { name: 'flib', enabled: true },
      ]),
    );
    expect(apiMocks.putMods).not.toHaveBeenCalled();
  });

  test('nothing is applied until a pack is chosen', async () => {
    render(<WizardMods draftId="draft1" />);
    const apply = await screen.findByRole('button', { name: 'Apply & download' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(apply);
    expect(apiMocks.applyModpack).not.toHaveBeenCalled();
  });

  test('the picker stays out of the way when there are no modpacks', async () => {
    apiMocks.listModpacks.mockResolvedValue({ modpacks: [] });
    render(<WizardMods draftId="draft1" />);

    await act(async () => {});
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Apply a shared modpack/)).toBeNull();
  });
});
