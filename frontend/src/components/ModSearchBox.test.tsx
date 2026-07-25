import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModSearchBox } from './ModSearchBox';
import type { CatalogEntry, DependencyResolution, ResolvedDependency } from '../types';

const { searchMods, resolveModDependencies } = vi.hoisted(() => ({
  searchMods: vi.fn(),
  resolveModDependencies: vi.fn(),
}));

vi.mock('../api', () => ({ api: { searchMods, resolveModDependencies } }));

const SE: CatalogEntry = {
  name: 'space-exploration',
  title: 'Space Exploration',
  owner: 'Earendel',
  summary: 'Build a rocket.',
  downloadsCount: 900_000,
  category: 'overhaul',
  latestVersion: '0.7.0',
  factorioVersion: '2.0',
};

function dep(name: string, over: Partial<ResolvedDependency> = {}): ResolvedDependency {
  return {
    name,
    title: name,
    summary: '',
    downloadsCount: 0,
    via: 'space-exploration',
    ...over,
  };
}

function resolution(over: Partial<DependencyResolution> = {}): DependencyResolution {
  return {
    name: 'space-exploration',
    title: 'Space Exploration',
    required: [],
    optional: [],
    incompatible: [],
    satisfied: [],
    missing: [],
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  searchMods.mockResolvedValue({ results: [SE] });
  resolveModDependencies.mockResolvedValue(resolution());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Type a query and let the debounce, the search and its re-render settle. */
async function search(installed: string[] = []) {
  const onAdd = vi.fn();
  render(<ModSearchBox onAdd={onAdd} installed={installed} />);
  fireEvent.change(screen.getByPlaceholderText(/space exploration/i), {
    target: { value: 'space' },
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  return onAdd;
}

/** Click Add on the single result row and wait for the resolve to come back. */
async function clickAdd() {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await act(async () => {});
}

const dialog = () => screen.queryByRole('heading', { name: /Add Space Exploration/ });

describe('ModSearchBox', () => {
  test('adds a mod with nothing to pull in without prompting', async () => {
    const onAdd = await search();
    await clickAdd();

    expect(resolveModDependencies).toHaveBeenCalledWith('space-exploration', []);
    expect(onAdd).toHaveBeenCalledWith('space-exploration');
    expect(dialog()).toBeNull();
  });

  test('asks before pulling in required dependencies, and adds them all on approve', async () => {
    resolveModDependencies.mockResolvedValue(
      resolution({ required: [dep('flib'), dep('informatron', { via: 'flib' })] }),
    );
    const onAdd = await search();
    await clickAdd();

    expect(dialog()).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByText(/needed by flib/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add 3 mods/ }));
    expect(onAdd.mock.calls.map((c) => c[0])).toEqual([
      'space-exploration',
      'flib',
      'informatron',
    ]);
  });

  test('cancel adds nothing at all', async () => {
    resolveModDependencies.mockResolvedValue(resolution({ required: [dep('flib')] }));
    const onAdd = await search();
    await clickAdd();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  test('optional dependencies are opt-in, except `+` ones the game enables by default', async () => {
    resolveModDependencies.mockResolvedValue(
      resolution({
        optional: [dep('menu-sims', { defaultEnabled: true }), dep('bullet-trails')],
      }),
    );
    const onAdd = await search();
    await clickAdd();

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);

    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /Add 3 mods/ }));
    expect(onAdd.mock.calls.map((c) => c[0])).toEqual([
      'space-exploration',
      'menu-sims',
      'bullet-trails',
    ]);
  });

  test('a conflict with an installed mod is surfaced even when nothing needs adding', async () => {
    resolveModDependencies.mockResolvedValue(
      resolution({ incompatible: [dep('space-age', { installed: true })] }),
    );
    const onAdd = await search(['space-age']);
    await clickAdd();

    expect(screen.getByText(/Conflicts with mods you already have/)).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('an incompatibility you do not have does not interrupt the add', async () => {
    resolveModDependencies.mockResolvedValue(
      resolution({ incompatible: [dep('space-age', { installed: false })] }),
    );
    const onAdd = await search();
    await clickAdd();

    expect(dialog()).toBeNull();
    expect(onAdd).toHaveBeenCalledWith('space-exploration');
  });

  test('a long incompatibility list is summarised instead of dumped in full', async () => {
    // Space Exploration declares 50 of these. None are installed, so they are
    // context, not a decision.
    resolveModDependencies.mockResolvedValue(
      resolution({
        required: [dep('flib')],
        incompatible: Array.from({ length: 50 }, (_, i) => dep(`bob${i}`)),
      }),
    );
    await search();
    await clickAdd();

    expect(screen.getByText(/bob0, bob1, bob2, bob3 and 46 others/)).toBeTruthy();
    expect(screen.queryByText(/bob49/)).toBeNull();
  });

  test('dependencies the portal does not have are called out rather than swallowed', async () => {
    resolveModDependencies.mockResolvedValue(resolution({ missing: ['ghost-mod'] }));
    await search();
    await clickAdd();

    expect(screen.getByText(/Not found on the mod portal/)).toBeTruthy();
    expect(screen.getByText(/ghost-mod/)).toBeTruthy();
  });

  test('a failed dependency check still lets the mod be added', async () => {
    resolveModDependencies.mockRejectedValue(new Error('Mod portal unreachable'));
    const onAdd = await search();
    await clickAdd();

    expect(dialog()).toBeNull();
    expect(onAdd).toHaveBeenCalledWith('space-exploration');
  });

  test('the installed list is sent to the resolver and marks results as added', async () => {
    await search(['space-exploration']);
    expect(screen.getByRole('button', { name: 'Added' })).toHaveProperty('disabled', true);
    expect(resolveModDependencies).not.toHaveBeenCalled();
  });
});
