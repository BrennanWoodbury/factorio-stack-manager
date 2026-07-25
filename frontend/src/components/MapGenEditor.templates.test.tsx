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
    templates: [
      { id: 't1', name: 'Peaceful', modCount: 0 },
      { id: 't2', name: 'Rich resources', modCount: 0 },
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

  test('choosing the blank entry goes back to no template', async () => {
    render(<Harness />);
    await waitFor(() => expect(apiMocks.listMapGenTemplates).toHaveBeenCalled());
    fireEvent.change(picker(), { target: { value: 't1' } });
    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe('t1'));

    fireEvent.change(picker(), { target: { value: '' } });

    await waitFor(() => expect((picker() as HTMLSelectElement).value).toBe(''));
    expect(apiMocks.getMapGenTemplate).toHaveBeenCalledTimes(1);
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
