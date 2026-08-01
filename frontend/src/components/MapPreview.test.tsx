import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapPreview, randomSeed } from './MapPreview';
import type { MapGenSettings } from '../types';

const apiMocks = vi.hoisted(() => ({
  previewMap: vi.fn(),
  mapGenPlanets: vi.fn(),
  runtimeMapGenMods: vi.fn(),
}));

vi.mock('../api', () => ({ api: apiMocks }));
// Toasts pull in the app's toast host; stub them so the component under test stays isolated.
vi.mock('../ui', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

/** The preview is controlled by its parent, so the harness owns the settings the app does. */
function Harness({
  initial = {} as MapGenSettings,
  mode = 'vanilla',
}: {
  initial?: MapGenSettings;
  mode?: string;
}) {
  const [value, setValue] = useState<MapGenSettings>(initial);
  return <MapPreview serverId="s1" mapGen={value} onChange={setValue} mode={mode} />;
}

const seedBox = () => screen.getByPlaceholderText('random') as HTMLInputElement;

beforeEach(() => {
  apiMocks.previewMap.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  apiMocks.mapGenPlanets.mockResolvedValue({ planets: ['nauvis'] });
  apiMocks.runtimeMapGenMods.mockResolvedValue({ mods: [] });
  // jsdom doesn't implement object URLs; the component creates/revokes them on render.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('MapPreview seed box', () => {
  test('reroll mints a fresh seed, uses it, and writes it into the box', async () => {
    // Fix Math.random so the rerolled seed is deterministic, and derive the expected
    // value from the same full-uint32 (excl. 0/1) range the component draws from.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const expected = randomSeed();

    render(<Harness />);
    expect(seedBox().value).toBe(''); // starts empty (random)

    fireEvent.click(screen.getByRole('button', { name: /Reroll seed/i }));

    // The box is populated with the seed the render used...
    await waitFor(() => expect(seedBox().value).toBe(String(expected)));
    // ...and that same seed is what the preview was rendered with.
    await waitFor(() => expect(apiMocks.previewMap).toHaveBeenCalledTimes(1));
    expect(apiMocks.previewMap).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ seed: expected }),
    );
  });

  test('a value in the box is used verbatim when previewing, without rerolling', async () => {
    const randomSpy = vi.spyOn(Math, 'random');

    render(<Harness />);
    fireEvent.change(seedBox(), { target: { value: '12345' } });
    await waitFor(() => expect(seedBox().value).toBe('12345'));

    fireEvent.click(screen.getByRole('button', { name: /Preview map/i }));

    await waitFor(() => expect(apiMocks.previewMap).toHaveBeenCalledTimes(1));
    // The typed seed is passed through untouched, and no random seed was minted.
    expect(apiMocks.previewMap).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ seed: 12345 }),
    );
    expect(randomSpy).not.toHaveBeenCalled();
    // The box keeps the user's value.
    expect(seedBox().value).toBe('12345');
  });
});

describe('MapPreview planet discovery', () => {
  test('planets the mods define replace the guessed list and can be previewed', async () => {
    // A pack that adds a planet no hardcoded list knows about.
    apiMocks.mapGenPlanets.mockResolvedValue({ planets: ['nauvis', 'maraxsis'] });
    render(<Harness mode="modded_space_age" />);

    expect(screen.queryByRole('button', { name: 'Maraxsis' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Find planets from mods/i }));

    // The prototype name is presented readably, and renders like any other planet.
    const button = await screen.findByRole('button', { name: 'Maraxsis' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(apiMocks.previewMap).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ planet: 'maraxsis' }),
      ),
    );
  });

  test('discovery is never triggered by opening the tab, only by asking', async () => {
    // It boots a container, so it must not fire on mount.
    render(<Harness mode="modded_space_age" />);
    await waitFor(() => expect(apiMocks.runtimeMapGenMods).toHaveBeenCalled());
    expect(apiMocks.mapGenPlanets).not.toHaveBeenCalled();
  });

  test('vanilla is not offered mod discovery', async () => {
    render(<Harness mode="vanilla" />);
    // Let the mount-time scan settle before asserting, so the state update it causes
    // lands inside the test rather than after it.
    await waitFor(() => expect(apiMocks.runtimeMapGenMods).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Find planets from mods/i })).toBeNull();
  });
});

describe('MapPreview runtime-mod warning', () => {
  test('names the mods whose changes the preview cannot show', async () => {
    apiMocks.runtimeMapGenMods.mockResolvedValue({
      mods: [{ name: 'rso-mod', version: '6.2.6', effects: ['rewrites chunks as they generate'] }],
    });

    render(<Harness />);

    expect(await screen.findByText(/rso-mod/)).toBeTruthy();
    expect(screen.getByText(/rewrites chunks as they generate/)).toBeTruthy();
  });

  test('a prototype-only mod set says nothing', async () => {
    render(<Harness />);
    await waitFor(() => expect(apiMocks.runtimeMapGenMods).toHaveBeenCalled());
    expect(screen.queryByText(/change the map after it generates/)).toBeNull();
  });

  test('a failed scan is silent rather than blocking the preview', async () => {
    apiMocks.runtimeMapGenMods.mockRejectedValue(new Error('nope'));

    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Preview map/i }));
    await waitFor(() => expect(apiMocks.previewMap).toHaveBeenCalledTimes(1));
  });
});
