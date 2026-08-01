import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { MapGenSettings, Server } from '../types';
import { run, toastError, toastSuccess } from '../ui';
import { MapGenEditor } from './MapGenEditor';
import { MapPreview } from './MapPreview';
import { GameModeSelect } from './GameModeSelect';
import { Collapsible } from './Collapsible';
import { useFactorioImage } from '../useFactorioImage';

export function MapGenPanel({ server }: { server: Server }) {
  const [mapGen, setMapGen] = useState<MapGenSettings | null>(null);
  const [mode, setMode] = useState(server.gameMode);
  // Which game modes this server's Factorio version can actually run (hint only).
  const imageInfo = useFactorioImage(server.factorioTag);
  // Version-correct map-settings, only present after an exchange-string import.
  const [mapSettings, setMapSettings] = useState<MapGenSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [importStr, setImportStr] = useState('');
  const [importing, setImporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState('');
  const [advancedErr, setAdvancedErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getMapGen(server.id);
      setMapGen(r.mapGen);
      setMapSettings(r.mapSettings ?? null);
    } catch (err) {
      toastError((err as Error).message);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!mapGen) return <div className="muted">Loading…</div>;

  const changeMode = async (m: string) => {
    setMode(m);
    await run(() => api.updateServer(server.id, { gameMode: m }), 'Game mode saved (applies on next start)');
  };

  const detectResources = async () => {
    setBusy(true);
    try {
      const r = await api.mapGenBaseline(server.id);
      setMapGen(r.mapGen);
      toastSuccess('Detected — sliders populated from this server’s mods');
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    const ok = await run(
      () => api.setMapGen(server.id, { mapGen, mapSettings }),
      'Map generation settings saved',
    );
    setBusy(false);
    if (ok) await load();
  };

  const doImport = async () => {
    if (!importStr.trim()) return;
    setImporting(true);
    try {
      const r = await api.importExchangeString(server.id, importStr.trim());
      setMapGen(r.mapGen);
      setMapSettings(r.mapSettings ?? null);
      setImportStr('');
      toastSuccess('Imported — review the sliders, then Save');
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const r = await api.exportExchangeString(server.id, mapGen);
      setExported(r.exchangeString);
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openAdvanced = (open: boolean) => {
    if (open) {
      setAdvanced(JSON.stringify(mapGen, null, 2));
      setAdvancedErr(null);
    }
  };
  const applyAdvanced = () => {
    try {
      const parsed = JSON.parse(advanced);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Must be a JSON object');
      }
      setMapGen(parsed as MapGenSettings);
      setAdvancedErr(null);
      toastSuccess('Applied to the editor — Save to persist');
    } catch (err) {
      setAdvancedErr((err as Error).message);
    }
  };

  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Map generation</h2>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="small muted" style={{ marginBottom: 14 }}>
        These apply to the <strong>next new map generated</strong> — a first start with no save, or a
        new save created from the Saves tab. They don't change an existing world. Current selected
        save: <span className="mono">{server.saveName}</span>. Manage reusable presets under{' '}
        <strong>World Generation</strong>.
        {mapSettings && (
          <>
            {' '}
            Imported map settings (pollution / evolution / expansion) are attached and will be used.
          </>
        )}
      </div>

      {/* Import / export exchange strings */}
      <Collapsible
        title="Import / export a map exchange string"
        hint="Paste a string to load its settings, or export the current ones to share"
        style={{ marginBottom: 14 }}
      >
        <div className="small muted" style={{ marginBottom: 8 }}>
          Paste a <span className="mono">&gt;&gt;&gt;…&lt;&lt;&lt;</span> string from Factorio's map
          generator (needs the same Factorio version and mods as this server). It populates the
          sliders below and attaches its map settings.
        </div>
        <textarea
          rows={3}
          placeholder=">>>…<<<"
          className="mono"
          value={importStr}
          onChange={(e) => setImportStr(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={importing || !importStr.trim()} onClick={() => void doImport()}>
            {importing ? 'Importing…' : 'Import string'}
          </button>
          <button className="ghost" disabled={busy} onClick={() => void doExport()}>
            Export current as string
          </button>
        </div>
        {exported && (
          <div style={{ marginTop: 10 }}>
            <label className="small">Exchange string (copy to share)</label>
            <textarea readOnly rows={3} className="mono" value={exported} onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
          </div>
        )}
      </Collapsible>

      <div style={{ marginBottom: 12 }}>
        <GameModeSelect value={mode} onChange={(m) => void changeMode(m)} modeIssues={imageInfo?.modeIssues} />
        {mode === 'modded' && (
          <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 10 }}>
            <button disabled={busy} onClick={() => void detectResources()}>
              {busy ? 'Detecting…' : 'Detect resources from mods'}
            </button>
            <span className="small muted">
              Runs this server's mods once to load their resource controls into the sliders.
            </span>
          </div>
        )}
      </div>
      <MapPreview serverId={server.id} mapGen={mapGen} onChange={setMapGen} mode={mode} />
      <MapGenEditor value={mapGen} onChange={setMapGen} showSeed={false} mode={mode} />

      {/* Advanced raw-JSON escape hatch */}
      <Collapsible
        title="Advanced — raw map-gen-settings JSON"
        hint="Escape hatch for anything the sliders don't cover"
        onOpenChange={openAdvanced}
        style={{ marginTop: 12 }}
      >
        <div className="small muted" style={{ marginBottom: 8 }}>
          Applying updates the editor; Save persists it.
        </div>
        <textarea
          rows={12}
          className="mono"
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
          style={{ fontSize: 12 }}
        />
        {advancedErr && (
          <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>
            {advancedErr}
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={applyAdvanced}>Apply JSON to editor</button>
        </div>
      </Collapsible>
    </div>
  );
}
