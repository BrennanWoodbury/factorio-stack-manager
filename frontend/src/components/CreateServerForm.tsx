import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { DraftSource, DraftState, MapGenSettings } from '../types';
import { toastError, toastSuccess } from '../ui';
import { FactorioTagSelect } from './FactorioTagSelect';
import { useFactorioImage } from '../useFactorioImage';
import { MapGenEditor } from './MapGenEditor';
import { MapPreview } from './MapPreview';
import { WizardMods, type WizardModsHandle } from './WizardMods';
import { DnsNamePreview } from './DnsNamePreview';
import { GameModeSelect } from './GameModeSelect';
import { Collapsible } from './Collapsible';
import { ConfirmDialog } from './ConfirmDialog';
import { IconTerminal, IconUpload, IconWorld } from './icons';

const MODES: {
  source: DraftSource;
  Icon: (props: { size?: number }) => JSX.Element;
  title: string;
  blurb: string;
}[] = [
  {
    source: 'generate',
    Icon: IconWorld,
    title: 'Generate new world',
    blurb: 'Pick a game mode and tune resources, water, and terrain. Preview before you commit.',
  },
  {
    source: 'import',
    Icon: IconTerminal,
    title: 'Import map string',
    blurb: 'Paste a Factorio map exchange string; we decode it and show exactly what it maps to.',
  },
  {
    source: 'save',
    Icon: IconUpload,
    title: 'Load from save',
    blurb: 'Upload an existing save file and start the server straight from it.',
  },
];

/**
 * New-server wizard. Picking a mode lazily creates a draft (a persisted, inactive
 * server row) that autosaves as you go and survives restarts; "Create" finalizes it
 * into a real server. Pass `resumeDraftId` to reopen an in-progress draft.
 */
export function CreateServerForm({
  onClose,
  onCreated,
  dnsEnabled,
  baseDomain,
  resumeDraftId,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  dnsEnabled: boolean;
  baseDomain: string | null;
  resumeDraftId?: string;
}) {
  const [phase, setPhase] = useState<'mode' | 'config'>(resumeDraftId ? 'config' : 'mode');
  const [draftId, setDraftId] = useState<string | null>(resumeDraftId ?? null);
  const [source, setSource] = useState<DraftSource>('generate');

  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(0);
  const [description, setDescription] = useState('');
  const [factorioTag, setFactorioTag] = useState('stable');
  // Which game modes the chosen Factorio version can actually run (hint only).
  const imageInfo = useFactorioImage(factorioTag);
  const [gameMode, setGameMode] = useState('space_age');
  const [mapGen, setMapGen] = useState<MapGenSettings | null>(null);
  const [mapSettings, setMapSettings] = useState<MapGenSettings | null>(null);
  const [mapGenEdited, setMapGenEdited] = useState(false);
  const [modsEdited, setModsEdited] = useState(false);
  const [modsUnapplied, setModsUnapplied] = useState(false);
  // Set while waiting on the "mods not applied" confirm; holds the create/test action to
  // resume once the user confirms applying the pending mod changes (or null if idle).
  const [pendingAction, setPendingAction] = useState<(() => void | Promise<void>) | null>(null);
  const wizardModsRef = useRef<WizardModsHandle>(null);
  const [exchangeString, setExchangeString] = useState('');
  const [importDecoded, setImportDecoded] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [savedSaveName, setSavedSaveName] = useState<string | null>(null);
  // What the uploaded save's own header says it needs (read server-side, no boot).
  const [saveInfo, setSaveInfo] = useState<{
    gameVersion?: string;
    mods?: { name: string; version: string }[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const [startAfter, setStartAfter] = useState(false);
  const [probe, setProbe] = useState<{
    phase: 'idle' | 'running' | 'passed' | 'failed';
    // Whether this run finalizes the draft on success ("Test & Create") or just
    // reports back ("Test") — also what "Re-test" repeats.
    create: boolean;
    status: string;
    log: string[];
    errors: string[];
  }>({ phase: 'idle', create: true, status: '', log: [], errors: [] });
  const finalized = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Close the probe stream if the wizard unmounts mid-test.
  useEffect(() => () => esRef.current?.close(), []);
  // Auto-scroll the probe log as lines arrive.
  useEffect(() => {
    logBoxRef.current?.scrollTo(0, logBoxRef.current.scrollHeight);
  }, [probe.log]);

  // Whether the form holds anything worth warning about before discarding on "Change".
  // (Loading map-gen defaults by opening the drawer doesn't count — only real edits.)
  const isDirty =
    name.trim() !== '' ||
    subdomain.trim() !== '' ||
    description.trim() !== '' ||
    exchangeString.trim() !== '' ||
    maxPlayers !== 0 ||
    gameMode !== 'space_age' ||
    factorioTag !== 'stable' ||
    mapGenEdited ||
    modsEdited ||
    savedSaveName != null;

  // Resume an existing draft: hydrate the form from its saved state.
  useEffect(() => {
    if (!resumeDraftId) return;
    void (async () => {
      try {
        const { state } = await api.getDraft(resumeDraftId);
        setSource(state.source);
        setName(state.name ?? '');
        setSubdomain(state.subdomain ?? '');
        setMaxPlayers(state.maxPlayers ?? 0);
        setDescription(state.description ?? '');
        setFactorioTag(state.factorioTag ?? 'stable');
        setGameMode(state.gameMode ?? 'space_age');
        if (state.mapGen) setMapGen(state.mapGen);
        if (state.mapSettings) setMapSettings(state.mapSettings);
        if (state.exchangeString) setExchangeString(state.exchangeString);
        // An import draft with both a string and decoded settings resumes at stage 2.
        if (state.source === 'import' && state.exchangeString && state.mapGen) setImportDecoded(true);
        if (state.saveStaged && state.saveFileName) setSavedSaveName(state.saveFileName);
        if (state.saveGameVersion || state.saveMods)
          setSaveInfo({ gameVersion: state.saveGameVersion, mods: state.saveMods });
      } catch (err) {
        toastError((err as Error).message);
      }
    })();
  }, [resumeDraftId]);

  const patch = useMemo<Partial<DraftState>>(
    () => ({
      name,
      subdomain,
      maxPlayers,
      description,
      factorioTag,
      gameMode,
      ...(source === 'generate' && mapGen ? { mapGen } : {}),
      ...(source === 'import'
        ? {
            exchangeString,
            ...(importDecoded && mapGen ? { mapGen } : {}),
            ...(importDecoded && mapSettings ? { mapSettings } : {}),
          }
        : {}),
    }),
    [name, subdomain, maxPlayers, description, factorioTag, gameMode, mapGen, mapSettings, exchangeString, importDecoded, source],
  );

  // Debounced autosave to the draft as fields change.
  useEffect(() => {
    if (!draftId || phase !== 'config' || finalized.current) return;
    const t = setTimeout(() => void api.updateDraft(draftId, patch).catch(() => {}), 600);
    return () => clearTimeout(t);
  }, [draftId, phase, patch]);

  const pickMode = async (src: DraftSource) => {
    setBusy(true);
    try {
      const { draft } = await api.createDraft({ source: src, gameMode });
      setSource(src);
      setDraftId(draft.id);
      setPhase('config');
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const initMapGen = async () => {
    if (mapGen) return;
    try {
      setMapGen((await api.mapGenDefaults()).settings);
    } catch (err) {
      toastError((err as Error).message);
    }
  };

  // Import stage 1 -> 2: decode the exchange string into editable settings via the
  // draft's own binary, then persist them so preview / Test & Create use them.
  const decodeString = async () => {
    if (!draftId || !exchangeString.trim()) return;
    setDecoding(true);
    try {
      await api.updateDraft(draftId, { exchangeString });
      const r = await api.importExchangeString(draftId, exchangeString.trim());
      const decodedSettings = (r.mapSettings ?? null) as MapGenSettings | null;
      setMapGen(r.mapGen);
      setMapSettings(decodedSettings);
      setMapGenEdited(true);
      setImportDecoded(true);
      await api.updateDraft(draftId, {
        exchangeString,
        gameMode,
        mapGen: r.mapGen,
        mapSettings: decodedSettings,
      });
      toastSuccess('Decoded — review and tweak below');
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setDecoding(false);
    }
  };

  // Load-from-save: upload a .zip into the draft and make it the boot target.
  const uploadSave = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !draftId) return;
    setUploading(true);
    try {
      const { saveName, gameVersion, mods, gameMode: detected } = await api.uploadDraftSave(draftId, f);
      setSavedSaveName(saveName);
      setSaveInfo(gameVersion || mods ? { gameVersion, mods } : null);
      // Adopt the mode read from the save. Without this the autosave below would
      // push the wizard's default (Space Age) straight back over it, and the world
      // would come up with an expansion it was never built with.
      if (detected) setGameMode(detected);
      toastSuccess(`Uploaded “${saveName}”`);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const discardIfDraft = async () => {
    if (draftId && !finalized.current) await api.discardDraft(draftId).catch(() => {});
  };

  // "Change" mode discards the current draft. Confirm first only if there's content
  // to lose; a pristine draft switches silently.
  const back = () => {
    if (isDirty) setConfirmChange(true);
    else void doBack();
  };
  const doBack = async () => {
    setConfirmChange(false);
    await discardIfDraft();
    setDraftId(null);
    setMapGen(null);
    setMapSettings(null);
    setExchangeString('');
    setImportDecoded(false);
    setSavedSaveName(null);
    setMapGenEdited(false);
    setModsEdited(false);
    setModsUnapplied(false);
    setPendingAction(null);
    setPhase('mode');
  };

  // Dismiss keeps the draft (resume later from "Continue new server").
  const close = () => onClose();

  // Explicit abandon — remove the draft.
  const discard = async () => {
    await discardIfDraft();
    onClose();
  };

  const create = async () => {
    if (!draftId) return;
    setCreating(true);
    try {
      await api.updateDraft(draftId, patch); // flush latest field values first
      const { server } = await api.finalizeDraft(draftId, startAfter);
      finalized.current = true;
      toastSuccess(`Created "${server.name}"`);
      onCreated(server.id);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Stream a pre-flight boot probe. `create` picks the two flavours: Test & Create
  // finalizes the draft the moment the probe passes; Test reports the result and
  // leaves the draft alone, so you can fix things and run it again.
  const runProbe = async (create: boolean) => {
    if (!draftId) return;
    try {
      await api.updateDraft(draftId, patch); // flush latest field values first
    } catch (err) {
      toastError((err as Error).message);
      return;
    }
    setProbe({ phase: 'running', create, status: 'Starting test…', log: [], errors: [] });
    const es = new EventSource(
      `/api/servers/draft/${draftId}/test-create?create=${create ? 1 : 0}&start=${startAfter ? 1 : 0}`,
      { withCredentials: true },
    );
    esRef.current = es;
    es.addEventListener('status', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data) as { message: string };
      setProbe((p) => ({ ...p, status: message }));
    });
    es.addEventListener('log', (e) => {
      const { line } = JSON.parse((e as MessageEvent).data) as { line: string };
      setProbe((p) => ({ ...p, log: [...p.log, line].slice(-600) }));
    });
    es.addEventListener('failed', (e) => {
      const { errors } = JSON.parse((e as MessageEvent).data) as { errors: string[] };
      setProbe((p) => ({ ...p, phase: 'failed', status: 'Test failed', errors }));
      es.close();
    });
    // Test-only run: the draft is still a draft, waiting on you to create it.
    es.addEventListener('passed', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data) as { message: string };
      setProbe((p) => ({ ...p, phase: 'passed', status: message }));
      es.close();
    });
    es.addEventListener('done', (e) => {
      const { server } = JSON.parse((e as MessageEvent).data) as { server: { id: string; name: string } };
      finalized.current = true;
      es.close();
      toastSuccess(`Created "${server.name}"`);
      onCreated(server.id);
    });
    es.onerror = () => {
      es.close();
      setProbe((p) =>
        p.phase === 'running'
          ? { ...p, phase: 'failed', status: 'Connection lost', errors: [...p.errors, 'Lost connection to the test stream.'] }
          : p,
      );
    };
  };

  const resetProbe = () => setProbe({ phase: 'idle', create: true, status: '', log: [], errors: [] });

  // Gate anything that finalizes the draft on mods added/edited in the wizard but never
  // "Save & download"ed — otherwise they're silently missing from the created server (or
  // masked by falling back to the default modpack). If there's nothing pending, or this
  // action doesn't create anything (e.g. a plain Test), just run it.
  const guardCreate = (willCreate: boolean, fn: () => void | Promise<void>) => {
    if (willCreate && modsUnapplied) {
      setPendingAction(() => fn);
      return;
    }
    void fn();
  };

  // User confirmed "apply on create": save & download the pending mods, then resume
  // whichever create/test action was waiting on them.
  const confirmApplyMods = () => {
    const fn = pendingAction;
    setPendingAction(null);
    if (!fn) return;
    void (async () => {
      try {
        await wizardModsRef.current?.save();
      } catch {
        return; // save() already surfaced the error via toast
      }
      await fn();
    })();
  };

  // Generate is always ready; Import once decoded; Save once a file is uploaded.
  const finalizeReady =
    source === 'generate' ||
    (source === 'import' && importDecoded) ||
    (source === 'save' && !!savedSaveName);
  const canCreate = finalizeReady && name.trim().length > 0 && subdomain.trim().length > 0;

  return (
    <>
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 60,
        zIndex: 10,
      }}
      onClick={() => void close()}
    >
      <div
        className="panel"
        style={{ width: 520, maxHeight: '85vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'mode' ? (
          <>
            <h2 style={{ marginTop: 0 }}>New server</h2>
            <div className="small muted" style={{ marginBottom: 14 }}>
              How do you want to start this world?
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {MODES.map((m) => (
                <button
                  key={m.source}
                  className="ghost"
                  disabled={busy}
                  onClick={() => void pickMode(m.source)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    textAlign: 'left',
                    padding: '14px 16px',
                    height: 'auto',
                  }}
                >
                  <span style={{ color: 'var(--accent)', display: 'flex', flex: '0 0 auto', marginTop: 1 }}>
                    <m.Icon size={22} />
                  </span>
                  <span>
                    <span style={{ fontWeight: 600, display: 'block' }}>{m.title}</span>
                    <span className="small muted">{m.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => void close()}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="spread" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0 }}>
                {MODES.find((m) => m.source === source)?.title ?? 'New server'}
              </h2>
              <button className="ghost small" onClick={back}>
                ← Change
              </button>
            </div>

            <label>Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

            <label>Subdomain * (DNS label — lowercase, digits, hyphens)</label>
            <input
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
              placeholder="factory1"
              required
            />
            <DnsNamePreview subdomain={subdomain} baseDomain={baseDomain} enabled={dnsEnabled} />

            <label>Max players (0 = unlimited)</label>
            <input
              type="number"
              min={0}
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(Number(e.target.value))}
            />

            <label>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />

            <FactorioTagSelect value={factorioTag} onChange={setFactorioTag} />
            <div className="small muted" style={{ marginTop: 4 }}>
              Mods & public listing use the global <strong>Factorio.com account</strong> (Settings) —
              one account for every server.
            </div>

            {source === 'generate' && (
              <>
                <div style={{ marginTop: 12 }}>
                  <GameModeSelect value={gameMode} onChange={setGameMode} modeIssues={imageInfo?.modeIssues} />
                </div>
                <Collapsible
                  title="Map generation"
                  hint="Optional — tune ore, water & terrain. Closed uses the game's defaults."
                  onOpenChange={(open) => {
                    if (open) void initMapGen();
                  }}
                  style={{ marginTop: 12 }}
                >
                  <div className="small muted" style={{ marginBottom: 10 }}>
                    Applied when this server generates its first map. A live preview lands in a
                    follow-up.
                  </div>
                  {mapGen ? (
                    <>
                      {draftId && <MapPreview serverId={draftId} mapGen={mapGen} mode={gameMode} />}
                      <MapGenEditor
                        value={mapGen}
                        onChange={(v) => {
                          setMapGen(v);
                          setMapGenEdited(true);
                        }}
                        mode={gameMode}
                      />
                    </>
                  ) : (
                    <div className="muted small">Loading defaults…</div>
                  )}
                </Collapsible>

                <Collapsible
                  title="Mods"
                  hint="Optional — add mods from the portal. Included in the pre-flight test."
                  style={{ marginTop: 12 }}
                >
                  {draftId && (
                    <WizardMods
                      ref={wizardModsRef}
                      draftId={draftId}
                      onSaved={(mods) => {
                        setModsEdited(true);
                        void api.updateDraft(draftId, { mods }).catch(() => {});
                      }}
                      onDirtyChange={setModsUnapplied}
                    />
                  )}
                </Collapsible>
              </>
            )}

            {source === 'import' && (
              <div style={{ marginTop: 12 }}>
                <label>Map exchange string</label>
                <textarea
                  className="mono"
                  rows={4}
                  value={exchangeString}
                  onChange={(e) => {
                    setExchangeString(e.target.value);
                    setImportDecoded(false); // editing invalidates the decoded stage
                  }}
                  placeholder=">>>eNpj..."
                />
                <div className="small muted" style={{ marginTop: 4 }}>
                  Paste a string from Factorio's map-generation screen.{' '}
                  <a
                    href="https://wiki.factorio.com/Map_exchange_string_format"
                    target="_blank"
                    rel="noreferrer"
                  >
                    What's a map exchange string?
                  </a>
                </div>
                <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 10 }}>
                  <button disabled={decoding || !exchangeString.trim()} onClick={() => void decodeString()}>
                    {decoding ? 'Decoding…' : importDecoded ? 'Re-decode' : 'Decode & preview'}
                  </button>
                  {importDecoded && (
                    <span className="small" style={{ color: 'var(--green)' }}>
                      Decoded ✓
                    </span>
                  )}
                </div>

                {importDecoded && mapGen && (
                  <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                    <div className="small muted" style={{ marginBottom: 10 }}>
                      These are the settings your string maps to. Pick the matching game mode,
                      preview, and tweak — then Test &amp; Create.
                    </div>
                    <GameModeSelect value={gameMode} onChange={setGameMode} modeIssues={imageInfo?.modeIssues} />
                    <div style={{ marginTop: 12 }}>
                      {draftId && <MapPreview serverId={draftId} mapGen={mapGen} mode={gameMode} />}
                      <MapGenEditor
                        value={mapGen}
                        onChange={(v) => {
                          setMapGen(v);
                          setMapGenEdited(true);
                        }}
                        mode={gameMode}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {source === 'save' && (
              <div style={{ marginTop: 12 }}>
                <label>Save file (.zip)</label>
                <input type="file" accept=".zip" disabled={uploading} onChange={(e) => void uploadSave(e)} />
                {uploading ? (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    Uploading…
                  </div>
                ) : savedSaveName ? (
                  <>
                    <div className="small" style={{ marginTop: 8, color: 'var(--green)' }}>
                      Uploaded “{savedSaveName}” ✓
                    </div>
                    {saveInfo && (
                      <div className="panel" style={{ marginTop: 8, padding: '10px 12px' }}>
                        <div className="small muted" style={{ marginBottom: 6 }}>
                          Read from the save
                          {saveInfo.gameVersion && <> · built with Factorio {saveInfo.gameVersion}</>}
                        </div>
                        {saveInfo.mods && saveInfo.mods.length > 0 ? (
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {saveInfo.mods.map((m) => (
                              <span key={m.name} className="mod-chip mono">
                                {m.name} <span className="muted">{m.version}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="small muted">No mods — this is a vanilla save.</div>
                        )}
                        <div className="small muted" style={{ marginTop: 8 }}>
                          Game mode:{' '}
                          <strong>{gameMode === 'modded_space_age' ? 'Space Age + modded' : 'Vanilla + modded'}</strong>{' '}
                          — read from the save, so its own mod set is what runs.
                        </div>
                        <div className="small muted" style={{ marginTop: 6 }}>
                          These are installed at these exact versions when the server is created,
                          and Test boots the save to verify them.
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    Upload an existing Factorio save. Its mods and game mode are read from the file
                    itself, and installed when the server is created.
                  </div>
                )}
              </div>
            )}

            {probe.phase !== 'idle' ? (
              <div style={{ marginTop: 16 }}>
                {probe.phase === 'passed' && (
                  <div className="panel" style={{ borderColor: 'var(--green)', marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, color: 'var(--green)', marginBottom: 6 }}>
                      Test passed ✓
                    </div>
                    <div className="small muted">
                      This configuration generated its map and reached “hosting” in a throwaway
                      container — no server was created. Create it now, or keep editing and test
                      again.
                    </div>
                  </div>
                )}
                {probe.phase === 'failed' && probe.errors.length > 0 && (
                  <div className="panel" style={{ borderColor: 'var(--red)', marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, color: 'var(--red)', marginBottom: 6 }}>
                      Test failed — fix and try again
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {probe.errors.map((e, i) => (
                        <li key={i} className="small mono" style={{ color: 'var(--red)' }}>
                          {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {probe.phase === 'running' && <span className="spinner" />}
                  <span className="small" style={{ fontWeight: 600 }}>
                    {probe.status}
                  </span>
                </div>
                <div className="console" ref={logBoxRef} style={{ height: 200 }}>
                  {probe.log.join('\n') || 'Waiting for the server…'}
                </div>
                {probe.phase === 'failed' && (
                  <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                    <button className="ghost" onClick={resetProbe}>
                      Back to editing
                    </button>
                    <button
                      className="ghost"
                      disabled={creating || !canCreate}
                      onClick={() => guardCreate(true, create)}
                    >
                      Create anyway
                    </button>
                    <button
                      className="primary"
                      onClick={() => guardCreate(probe.create, () => runProbe(probe.create))}
                    >
                      Re-test
                    </button>
                  </div>
                )}
                {probe.phase === 'passed' && (
                  <>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={startAfter}
                        onChange={(e) => setStartAfter(e.target.checked)}
                      />
                      Start server after creating
                    </label>
                    {!canCreate && (
                      <div className="small muted" style={{ marginTop: 8 }}>
                        Add a name and subdomain before creating this server.
                      </div>
                    )}
                    <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                      <button className="ghost" onClick={resetProbe}>
                        Back to editing
                      </button>
                      <button className="ghost" onClick={() => void runProbe(false)}>
                        Re-test
                      </button>
                      <button
                        className="primary"
                        disabled={creating || !canCreate}
                        onClick={() => guardCreate(true, create)}
                      >
                        {creating ? 'Creating…' : 'Create server'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={startAfter}
                    onChange={(e) => setStartAfter(e.target.checked)}
                  />
                  Start server after creating
                </label>
                <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                  <span className="small muted" style={{ alignSelf: 'center' }}>
                    Saved as a draft — close to resume later.
                  </span>
                  <div className="row">
                    <button className="danger ghost" onClick={() => void discard()}>
                      Discard
                    </button>
                    {finalizeReady ? (
                      <>
                        <button
                          className="ghost"
                          title="Boot this configuration once in a throwaway container and report back — nothing is created"
                          onClick={() => void runProbe(false)}
                        >
                          Test
                        </button>
                        <button
                          className="ghost"
                          disabled={creating || !canCreate}
                          onClick={() => guardCreate(true, create)}
                        >
                          {creating ? 'Creating…' : 'Create without testing'}
                        </button>
                        <button
                          className="primary"
                          disabled={!canCreate}
                          onClick={() => guardCreate(true, () => runProbe(true))}
                        >
                          Test &amp; Create
                        </button>
                      </>
                    ) : (
                      <button className="primary" disabled title="Available once this flow is wired up">
                        Create server
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
      {confirmChange && (
        <ConfirmDialog
          title="Discard this draft?"
          body="Switching flow deletes this draft and everything you've entered."
          confirmLabel="Discard & change"
          onConfirm={() => void doBack()}
          onCancel={() => setConfirmChange(false)}
        />
      )}
      {pendingAction && (
        <ConfirmDialog
          title="Mods not applied"
          body="You've added or changed mods but haven't hit Save & download yet, so they won't be included. Apply them now and continue?"
          confirmLabel="Apply & continue"
          danger={false}
          onConfirm={confirmApplyMods}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </>
  );
}
