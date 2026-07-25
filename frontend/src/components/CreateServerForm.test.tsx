import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateServerForm } from './CreateServerForm';

const apiMocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  updateDraft: vi.fn(),
  finalizeDraft: vi.fn(),
  discardDraft: vi.fn(),
  createDraft: vi.fn(),
  mapGenDefaults: vi.fn(),
  factorioImageInfo: vi.fn(),
  getMods: vi.fn(),
  putMods: vi.fn(),
  listModpacks: vi.fn(),
  planModpack: vi.fn(),
  applyModpack: vi.fn(),
  resolveModDependencies: vi.fn(),
  searchMods: vi.fn(),
  previewMap: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMocks }));

const toasts = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('../ui', () => ({ ...toasts, run: vi.fn() }));

/** jsdom has no EventSource; a stub makes the probe stream deterministic. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }

  static get latest() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

const draftState = {
  source: 'generate' as const,
  name: 'Factory One',
  subdomain: 'factory1',
  gameMode: 'space_age',
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMocks.getDraft.mockResolvedValue({ state: draftState });
  apiMocks.updateDraft.mockResolvedValue({});
  apiMocks.finalizeDraft.mockResolvedValue({ server: { id: 'srv1', name: 'Factory One' } });
  apiMocks.factorioImageInfo.mockResolvedValue({ known: false });
  apiMocks.getMods.mockResolvedValue({ mods: [] });
  apiMocks.listModpacks.mockResolvedValue({ modpacks: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderWizard(overrides: Partial<typeof draftState> = {}) {
  apiMocks.getDraft.mockResolvedValue({ state: { ...draftState, ...overrides } });
  const onCreated = vi.fn();
  render(
    <CreateServerForm
      onClose={vi.fn()}
      onCreated={onCreated}
      dnsEnabled={false}
      baseDomain={null}
      resumeDraftId="d1"
    />,
  );
  return { onCreated };
}

/** The probe stream the last click opened, with act-wrapped server events. */
async function stream() {
  await waitFor(() => expect(FakeEventSource.latest).toBeTruthy());
  const es = FakeEventSource.latest;
  return {
    url: es.url,
    get closed() {
      return es.closed;
    },
    emit: (type: string, data: unknown) => act(() => es.emit(type, data)),
  };
}

describe('CreateServerForm: Test button', () => {
  test('tests the draft without creating a server', async () => {
    // The gap this closes: the only way to check a configuration booted was
    // Test & Create, which committed the server the moment the test passed.
    const { onCreated } = renderWizard();

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    const es = await stream();
    expect(es.url).toContain('create=0');
    es.emit('log', { line: 'Loading mods' });
    es.emit('passed', { message: 'Test passed — this configuration boots.' });

    expect(await screen.findByText('Test passed ✓')).toBeTruthy();
    expect(screen.getByText('Loading mods')).toBeTruthy();
    expect(apiMocks.finalizeDraft).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(es.closed).toBe(true);
  });

  test('a passing test leads into creating the server it just verified', async () => {
    const { onCreated } = renderWizard();

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    (await stream()).emit('passed', { message: 'Test passed' });

    fireEvent.click(await screen.findByRole('button', { name: 'Create server' }));

    await waitFor(() => expect(apiMocks.finalizeDraft).toHaveBeenCalledWith('d1', false));
    expect(onCreated).toHaveBeenCalledWith('srv1');
  });

  test('errors from a failed test are shown, and Re-test stays test-only', async () => {
    const { onCreated } = renderWizard();

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    (await stream()).emit('failed', { errors: ['Mod "flib" is missing.'] });

    expect(await screen.findByText('Mod "flib" is missing.')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Re-test' }));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(FakeEventSource.latest.url).toContain('create=0');
  });

  test('Test & Create still creates as soon as the probe passes', async () => {
    const { onCreated } = renderWizard();

    fireEvent.click(await screen.findByRole('button', { name: 'Test & Create' }));

    const es = await stream();
    expect(es.url).toContain('create=1');
    es.emit('done', { server: { id: 'srv1', name: 'Factory One' } });

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('srv1'));
  });

  test('a half-filled draft can be tested but not created', async () => {
    // Testing a map doesn't need a name or a subdomain — only creating does.
    renderWizard({ name: '', subdomain: '' });

    const testBtn = await screen.findByRole('button', { name: 'Test' });
    expect(testBtn.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Test & Create' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(testBtn);
    (await stream()).emit('passed', { message: 'Test passed' });

    expect(await screen.findByText('Add a name and subdomain before creating this server.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create server' }).hasAttribute('disabled')).toBe(true);
  });
});
