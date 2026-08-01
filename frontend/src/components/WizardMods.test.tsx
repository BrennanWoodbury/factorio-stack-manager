import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WizardMods } from './WizardMods';

const apiMocks = vi.hoisted(() => ({
  getMods: vi.fn(),
  putMods: vi.fn(),
  listModpacks: vi.fn(),
  planModpack: vi.fn(),
  applyModpack: vi.fn(),
  resolveModDependencies: vi.fn(),
  searchMods: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));

// Toasts render through a provider mounted in App, not here — assert on the call.
const toasts = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('../ui', () => ({ ...toasts, run: vi.fn() }));

beforeEach(() => {
  apiMocks.getMods.mockResolvedValue({ mods: [{ name: 'base', enabled: true }] });
  apiMocks.listModpacks.mockResolvedValue({
    modpacks: [
      { id: 'pack1', name: 'Ribbon World', description: '', modCount: 2 },
      { id: 'pack2', name: 'Vanilla+', description: '', modCount: 5 },
    ],
  });
  // Nothing missing by default: applying goes straight through, no prompt.
  apiMocks.planModpack.mockResolvedValue({ mods: ['flib'], missing: [] });
  apiMocks.applyModpack.mockResolvedValue({ serverId: 'draft1', downloaded: [], errors: [] });
  apiMocks.searchMods.mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  toasts.toastError.mockClear();
  toasts.toastSuccess.mockClear();
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

  test('a pack whose mods are not downloaded asks before fetching them', async () => {
    apiMocks.planModpack.mockResolvedValue({
      mods: ['flib', 'Milestones'],
      missing: ['flib', 'Milestones'],
    });
    render(<WizardMods draftId="draft1" />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));

    expect(await screen.findByText('Download missing mods?')).toBeTruthy();
    expect(screen.getByText(/flib, Milestones/)).toBeTruthy();
    expect(apiMocks.applyModpack).not.toHaveBeenCalled();
  });

  test('declining the download leaves the mod list untouched', async () => {
    // The state this avoids: a list naming mods the server does not have, which
    // refuses to start and can only be fixed by re-saving it by hand.
    apiMocks.planModpack.mockResolvedValue({ mods: ['flib'], missing: ['flib'] });
    render(<WizardMods draftId="draft1" />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await act(async () => {});
    expect(apiMocks.applyModpack).not.toHaveBeenCalled();
    expect(screen.queryByText('Download missing mods?')).toBeNull();
    expect(toasts.toastError).toHaveBeenCalledWith(
      expect.stringMatching(/not applied — 1 mod\(s\) still need downloading/),
    );
  });

  test('accepting the download applies the pack', async () => {
    apiMocks.planModpack.mockResolvedValue({ mods: ['flib'], missing: ['flib'] });
    render(<WizardMods draftId="draft1" />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download & apply' }));

    await waitFor(() => expect(apiMocks.applyModpack).toHaveBeenCalledWith('pack1', 'draft1'));
  });

  test('a download failure reports which mod and why', async () => {
    // "Applied with errors" over a list of names was the whole of the report, so
    // a mod set that could not load came with nothing to act on.
    apiMocks.applyModpack.mockResolvedValue({
      serverId: 'draft1',
      downloaded: [],
      errors: [{ name: 'flib', error: 'Mod portal rejected credentials (check username/token)' }],
    });
    render(<WizardMods draftId="draft1" />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));

    await waitFor(() =>
      expect(toasts.toastError).toHaveBeenCalledWith(
        expect.stringContaining('flib: Mod portal rejected credentials (check username/token)'),
      ),
    );
  });

  test('nothing is applied until a pack is chosen', async () => {
    render(<WizardMods draftId="draft1" />);
    const apply = await screen.findByRole('button', { name: 'Apply & download' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(apply);
    expect(apiMocks.applyModpack).not.toHaveBeenCalled();
  });

  test('applying a pack shows a busy indicator until the download finishes', async () => {
    // A portal download can run for minutes. Swapping the button label was the only
    // feedback, so the step read as a frozen page and invited a second click.
    let finish!: (v: unknown) => void;
    apiMocks.applyModpack.mockReturnValue(new Promise((res) => { finish = res; }));
    render(<WizardMods draftId="draft1" />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pack1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & download' }));

    expect((await screen.findAllByRole('status')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Downloading mods…').length).toBeGreaterThan(0);

    await act(async () => {
      finish({ serverId: 'draft1', downloaded: [], errors: [] });
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('save & download shows a busy indicator until the download finishes', async () => {
    let finish!: (v: unknown) => void;
    apiMocks.putMods.mockReturnValue(new Promise((res) => { finish = res; }));
    render(<WizardMods draftId="draft1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save & download' }));

    expect((await screen.findAllByRole('status')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Downloading mods…').length).toBeGreaterThan(0);

    await act(async () => {
      finish({ mods: [{ name: 'base', enabled: true }], downloaded: [], errors: [] });
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('the picker stays out of the way when there are no modpacks', async () => {
    apiMocks.listModpacks.mockResolvedValue({ modpacks: [] });
    render(<WizardMods draftId="draft1" />);

    await act(async () => {});
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Apply a shared modpack/)).toBeNull();
  });
});
