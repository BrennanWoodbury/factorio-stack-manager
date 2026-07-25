import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapGenEditor } from './MapGenEditor';
import type { MapGenSettings } from '../types';

const apiMocks = vi.hoisted(() => ({
  listMapGenTemplates: vi.fn(),
  getMapGenTemplate: vi.fn(),
  createMapGenTemplate: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));

const PEACEFUL: MapGenSettings = { peaceful_mode: true, water: 1 };
const RICH: MapGenSettings = { peaceful_mode: false, water: 2 };

/** The editor is controlled, so the test owns the settings the way the app does. */
function Harness({ initial = {} as MapGenSettings }: { initial?: MapGenSettings }) {
  const [value, setValue] = useState<MapGenSettings>(initial);
  return (
    <>
      <MapGenEditor value={value} onChange={setValue} />
      <button onClick={() => setValue({ ...value, water: 2 })}>edit elsewhere</button>
    </>
  );
}

const picker = () => screen.getByRole('combobox', { name: 'World generation template' });

beforeEach(() => {
  apiMocks.listMapGenTemplates.mockResolvedValue({
    // Listings carry settings so the editor can recognise where a settings object
    // came from — see the derivation tests below.
    templates: [
      { id: 't1', name: 'Peaceful', settings: PEACEFUL },
      { id: 't2', name: 'Rich resources', settings: RICH },
    ],
  });
  apiMocks.getMapGenTemplate.mockResolvedValue({ id: 't1', name: 'Peaceful', settings: PEACEFUL });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('world generation template picker', () => {
  test('names the loaded template instead of still offering to load one', async () => {
    // The bug: the picker was wired as a one-shot action menu that reset itself,
    // so after loading "Peaceful" it still read "Load a template…".
    render(<Harness />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());

    expect((picker() as HTMLSelectElement).value).toBe('');

    fireEvent.change(picker(), { target: { value: 't1' } });
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));
    expect(screen.getByRole('option', { name: 'Peaceful', selected: true })).toBeTruthy();
  });

  test('loading a template applies its settings', async () => {
    render(<Harness />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());

    fireEvent.change(picker(), { target: { value: 't1' } });

    await waitFor(() => expect(apiMocks.getMapGenTemplate).toHaveBeenCalledWith('t1'));
    // peaceful_mode came from the template, so its checkbox is now on.
    await waitFor(() =>
      expect((screen.getByLabelText(/Peaceful mode/i) as HTMLInputElement).checked).toBe(true),
    );
  });

  test('editing afterwards is flagged, and the template can be reloaded', async () => {
    render(<Harness />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());
    fireEvent.change(picker(), { target: { value: 't1' } });
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));
    expect(screen.queryByText('modified')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'edit elsewhere' }));

    expect(await screen.findByText('modified')).toBeTruthy();
    // Re-picking the same option fires no change event, so this is the only way back.
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(apiMocks.getMapGenTemplate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('modified')).toBeNull());
  });

  test('the blank entry clears the name when the settings match no template', async () => {
    render(<Harness initial={{ water: 99 }} />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());
    fireEvent.change(picker(), { target: { value: 't1' } });
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));

    // Move away from the template, then clear.
    fireEvent.click(screen.getByRole('button', { name: 'edit elsewhere' }));
    fireEvent.change(picker(), { target: { value: '' } });

    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe(''));
    // Blank loads nothing — only the earlier explicit pick hit the API.
    expect(apiMocks.getMapGenTemplate).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- *
   * Recognising settings that arrived without a pick
   * ---------------------------------------------------------------- */

  test('settings that came from a template are named, with nothing selected', async () => {
    // The wizard case: a resumed draft, or the global default template applied at
    // creation, hands the editor raw settings. Before this it read "Load a
    // template…" over settings that plainly came from one.
    render(<Harness initial={PEACEFUL} />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());

    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));
    expect(apiMocks.getMapGenTemplate).not.toHaveBeenCalled();
    expect(screen.queryByText('modified')).toBeNull();
  });

  test('recognition survives the key order settings happen to arrive in', async () => {
    // The same settings serialise differently depending on whether they came from
    // the template endpoint, a draft, or the editor's own writes.
    render(<Harness initial={{ water: 1, peaceful_mode: true }} />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());

    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));
  });

  test('settings matching nothing leave the picker empty rather than guessing', async () => {
    render(<Harness initial={{ water: 7, peaceful_mode: true }} />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());
    await act(async () => {});

    expect((picker() as HTMLSelectElement).value).toBe('');
  });

  test('editing away from recognised settings drops the name', async () => {
    render(<Harness initial={PEACEFUL} />);
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));

    fireEvent.click(screen.getByRole('button', { name: 'edit elsewhere' }));

    // No longer those settings, and the user never claimed they were.
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe(''));
  });

  test('a template that fails to load leaves the picker on what is really loaded', async () => {
    apiMocks.getMapGenTemplate.mockRejectedValue(new Error('gone'));
    render(<Harness />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());

    fireEvent.change(picker(), { target: { value: 't2' } });

    await act(async () => {});
    expect((picker() as HTMLSelectElement).value).toBe('');
  });
});
