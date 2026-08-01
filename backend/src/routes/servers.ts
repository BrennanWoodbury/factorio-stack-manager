import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { toDto, toDraftDto, type DraftState, type ServerRow } from '../db/models.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../lib/errors.js';
import { sanitizeName } from '../services/serverFiles.js';
import { serverFiles } from '../services/serverFiles.js';
import { getFactorioAccount, factorioAccountConfigured } from '../services/factorioAccount.js';
import { getGlobalDefaults } from '../services/globalDefaults.js';
import { getLogger } from '../lib/logger.js';

const createLog = getLogger('create');
const finalizeLog = getLogger('finalize');

const modEntrySchema = z.object({ name: z.string().min(1), enabled: z.boolean() });

/**
 * Game modes. The "+ mods" pair say which base a custom mod set sits on; a save
 * draft adopts one from its own header rather than enforcing a bundled set.
 */
const GAME_MODE_VALUES = z.enum([
  'vanilla',
  'space_age',
  'space_age_no_quality',
  'modded',
  'modded_vanilla',
  'modded_space_age',
]);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  subdomain: z.string().min(1).max(63),
  maxPlayers: z.number().int().min(0).max(500).optional(),
  description: z.string().max(1000).optional(),
  saveName: z.string().max(100).optional(),
  generateNewSave: z.boolean().optional(),
  factorioTag: z.string().max(128).optional(),
  autoRestart: z.boolean().optional(),
  dnsEnabled: z.boolean().optional(),
  gameMode: GAME_MODE_VALUES.optional(),
  mods: z.array(modEntrySchema).optional(),
  // Initial map generation: raw settings, or a template id to copy settings from.
  mapGen: z.record(z.string(), z.unknown()).optional(),
  mapGenTemplateId: z.string().min(1).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  subdomain: z.string().min(1).max(63).optional(),
  maxPlayers: z.number().int().min(0).max(500).optional(),
  description: z.string().max(1000).optional(),
  saveName: z.string().max(100).optional(),
  generateNewSave: z.boolean().optional(),
  factorioTag: z.string().max(128).optional(),
  autoRestart: z.boolean().optional(),
  dnsEnabled: z.boolean().optional(),
  gameMode: GAME_MODE_VALUES.optional(),
  autoBackup: z.boolean().optional(),
  backupIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  backupKeep: z.number().int().min(1).max(1000).optional(),
  backupKeepManual: z.number().int().min(1).max(1000).optional(),
});

// A new-server wizard draft: created lazily when a mode is picked, then PATCHed as
// the user progresses. All fields optional except the source flow.
const draftCreateSchema = z.object({
  source: z.enum(['generate', 'import', 'save']),
  name: z.string().max(100).optional(),
  subdomain: z.string().max(63).optional(),
  maxPlayers: z.number().int().min(0).max(500).optional(),
  description: z.string().max(1000).optional(),
  factorioTag: z.string().max(128).optional(),
  gameMode: GAME_MODE_VALUES.optional(),
  mapGen: z.record(z.string(), z.unknown()).optional(),
  mods: z.array(modEntrySchema).optional(),
});

const draftPatchSchema = z.object({
  step: z.string().max(50).optional(),
  name: z.string().max(100).optional(),
  subdomain: z.string().max(63).optional(),
  maxPlayers: z.number().int().min(0).max(500).optional(),
  description: z.string().max(1000).optional(),
  factorioTag: z.string().max(128).optional(),
  gameMode: GAME_MODE_VALUES.optional(),
  mapGen: z.record(z.string(), z.unknown()).optional(),
  mapSettings: z.record(z.string(), z.unknown()).optional(),
  mods: z.array(modEntrySchema).optional(),
  exchangeString: z.string().max(200000).optional(),
  saveStaged: z.boolean().optional(),
  saveFileName: z.string().max(300).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

/** Draft response: the list-facing DTO plus the full resume state for the wizard. */
function draftBody(row: ServerRow): { draft: ReturnType<typeof toDraftDto>; state: DraftState } {
  let state: DraftState = { source: 'generate' };
  try {
    if (row.draft_state_json) state = JSON.parse(row.draft_state_json) as DraftState;
  } catch {
    /* corrupt state — fall back to a generate draft */
  }
  return { draft: toDraftDto(row), state };
}

export function serversRouter(ctx: AppContext): Router {
  const r = Router();
  const { manager, mods } = ctx;
  // Save files can be large; cap at 1 GiB and buffer in memory (single-host tool).
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

  const dtoOf = (row: Parameters<typeof toDto>[0]) =>
    toDto(row, manager.connectHost(row), ctx.docker.imageFor(row), {
      // Credentials are a single global setting now; the same flag applies to every server.
      hasFactorioCredentials: factorioAccountConfigured(getFactorioAccount(ctx.db)),
    });

  // ---- CRUD ----

  r.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ servers: manager.list().map(dtoOf) });
    }),
  );

  r.post(
    '/',
    asyncHandler(async (req, res) => {
      const { mapGenTemplateId, ...input } = parse(createSchema, req.body);
      const defaults = getGlobalDefaults(ctx.db);
      // Map generation: an explicit template/settings wins; otherwise fall back to the
      // global default map template (creation-time snapshot).
      if (mapGenTemplateId) input.mapGen = ctx.mapGenTemplates.settingsOf(mapGenTemplateId);
      else if (!input.mapGen && defaults.mapTemplateId) {
        try {
          input.mapGen = ctx.mapGenTemplates.settingsOf(defaults.mapTemplateId);
        } catch {
          /* template was deleted — ignore */
        }
      }
      const row = await manager.create(input);
      // Default modpack (creation-time): apply best-effort when the wizard didn't set
      // its own mods. A download failure doesn't fail creation — mods can be re-applied.
      if (!input.mods?.length && defaults.modpackId) {
        try {
          await ctx.modpacks.apply(defaults.modpackId, row.id);
        } catch (err) {
          createLog.warn(`default modpack apply failed for ${row.id}: ${(err as Error).message}`);
        }
      }
      res.status(201).json({ server: dtoOf(row) });
    }),
  );

  // ---- New-server wizard drafts (must precede '/:id' so '/draft' isn't captured) ----

  r.post(
    '/draft',
    asyncHandler(async (req, res) => {
      const input = parse(draftCreateSchema, req.body);
      res.status(201).json(draftBody(await manager.createDraft(input)));
    }),
  );

  r.get(
    '/draft',
    asyncHandler(async (_req, res) => {
      res.json({ drafts: manager.listDrafts().map(toDraftDto) });
    }),
  );

  r.get(
    '/draft/:id',
    asyncHandler(async (req, res) => {
      res.json(draftBody(manager.getDraft(req.params.id)));
    }),
  );

  r.patch(
    '/draft/:id',
    asyncHandler(async (req, res) => {
      const patch = parse(draftPatchSchema, req.body);
      res.json(draftBody(await manager.updateDraft(req.params.id, patch)));
    }),
  );

  r.delete(
    '/draft/:id',
    asyncHandler(async (req, res) => {
      manager.discardDraft(req.params.id);
      res.status(204).end();
    }),
  );

  // Finalize = turn the draft into a real server. This is the "create without
  // testing" path today; the pre-flight boot probe wraps it in a later slice.
  r.post(
    '/draft/:id/finalize',
    asyncHandler(async (req, res) => {
      const draft = manager.getDraft(req.params.id); // 404 unless a draft
      let state: DraftState = { source: 'generate' };
      try {
        if (draft.draft_state_json) state = JSON.parse(draft.draft_state_json) as DraftState;
      } catch {
        /* ignore */
      }
      const { start } = parse(z.object({ start: z.boolean().optional() }), req.body ?? {});
      const row = await manager.finalize(req.params.id, {
        // Load-from-save: fetch what the save's header says it needs, pinned to the
        // versions the world was built with.
        downloadMod: async (name, version) =>
          void (await ctx.mods.downloadMod(manager.getDraft(req.params.id), name, version)),
      });
      // Default modpack (creation-time) when the draft chose no mods — mirrors POST /.
      // Never for an uploaded save: its own header decides its mod set, and a pack
      // layered on top is how a world comes up with mods it was never built with.
      const defaults = getGlobalDefaults(ctx.db);
      if (state.source !== 'save' && !state.mods?.length && defaults.modpackId) {
        try {
          await ctx.modpacks.apply(defaults.modpackId, row.id);
        } catch (err) {
          finalizeLog.warn(`default modpack apply failed for ${row.id}: ${(err as Error).message}`);
        }
      }
      let started = false;
      if (start) {
        try {
          await manager.start(row.id);
          started = true;
        } catch (err) {
          finalizeLog.warn(`auto-start failed for ${row.id}: ${(err as Error).message}`);
        }
      }
      res.status(201).json({ server: dtoOf(manager.get(row.id)), started });
    }),
  );

  // Test & Create: stream a pre-flight boot probe (SSE), then — only if it passes —
  // finalize the draft into a real server. `create=0` runs the probe on its own and
  // leaves the draft untouched, so the wizard can test without committing.
  // Events: status | log | failed | passed (test-only) | done (created).
  r.get(
    '/draft/:id/test-create',
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      const draft = manager.getDraft(id); // 404 unless a draft
      const createAfter = req.query.create !== '0';
      const start = createAfter && req.query.start === '1';
      let mods: DraftState['mods'];
      let source: DraftState['source'] = 'generate';
      try {
        if (draft.draft_state_json) {
          const state = JSON.parse(draft.draft_state_json) as DraftState;
          mods = state.mods;
          source = state.source;
        }
      } catch {
        /* ignore */
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });

      try {
        send('status', { message: 'Preparing…' });
        // Apply the default modpack up front so the probe tests the real mod set.
        // Never for an uploaded save — its header owns its mod set (see finalize).
        const defaults = getGlobalDefaults(ctx.db);
        if (source !== 'save' && !mods?.length && defaults.modpackId) {
          send('status', { message: 'Downloading default modpack…' });
          try {
            await ctx.modpacks.apply(defaults.modpackId, id);
          } catch (err) {
            send('log', { line: `Default modpack apply failed: ${(err as Error).message}` });
          }
        }

        const result = await manager.probeDraft(
          id,
          {
            line: (line) => !aborted && send('log', { line }),
            status: (message) => !aborted && send('status', { message }),
          },
          // Smart-load: fetch the mods a Load-from-save draft's save requires, pinned
          // to the versions recorded in the save header.
          {
            downloadMod: async (name, version) =>
              void (await ctx.mods.downloadMod(manager.getDraft(id), name, version)),
          },
        );
        if (aborted) return;
        if (!result.ok) {
          send('failed', { errors: result.errors });
          return;
        }

        if (!createAfter) {
          send('passed', { message: 'Test passed — this configuration boots.' });
          return;
        }

        send('status', { message: 'Test passed — creating server…' });
        const row = await manager.finalize(id, {
          downloadMod: async (name, version) =>
            void (await ctx.mods.downloadMod(manager.getDraft(id), name, version)),
        });
        let started = false;
        if (start) {
          send('status', { message: 'Starting server…' });
          try {
            await manager.start(row.id);
            started = true;
          } catch (err) {
            send('log', { line: `Start failed: ${(err as Error).message}` });
          }
        }
        send('done', { server: dtoOf(manager.get(row.id)), started });
      } catch (err) {
        send('failed', { errors: [(err as Error).message] });
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    }),
  );

  // Upload a save into a Load-from-save draft; makes it the boot target.
  r.post(
    '/draft/:id/save',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      manager.getDraft(req.params.id); // 404 unless a draft
      if (!req.file) throw new ValidationError('Expected a multipart file field named "file"');
      const filename = (req.body?.name as string) || req.file.originalname || 'save.zip';
      res.status(201).json(await manager.stageDraftSave(req.params.id, req.file.buffer, filename));
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      res.json({ server: dtoOf(row) });
    }),
  );

  r.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const input = parse(updateSchema, req.body);
      const row = await manager.update(req.params.id, input);
      res.json({ server: dtoOf(row) });
    }),
  );

  r.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      await manager.delete(req.params.id);
      res.status(204).end();
    }),
  );

  // ---- Lifecycle ----

  r.post(
    '/:id/start',
    asyncHandler(async (req, res) => {
      await manager.start(req.params.id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/stop',
    asyncHandler(async (req, res) => {
      await manager.stop(req.params.id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/restart',
    asyncHandler(async (req, res) => {
      await manager.restart(req.params.id);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/:id/status',
    asyncHandler(async (req, res) => {
      res.json(await manager.status(req.params.id));
    }),
  );

  r.get(
    '/:id/logs',
    asyncHandler(async (req, res) => {
      manager.get(req.params.id); // 404 if unknown
      const tail = Math.min(Number(req.query.tail) || 200, 2000);
      const logs = await ctx.docker.logs(req.params.id, tail);
      res.json({ logs });
    }),
  );

  // Live container logs (SSE): scrollback then follow. Events: log | ended.
  r.get(
    '/:id/logs/stream',
    asyncHandler(async (req, res) => {
      manager.get(req.params.id); // 404 if unknown
      const tail = Math.min(Number(req.query.tail) || 1000, 5000);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      let closed = false;
      let stop = () => {};
      req.on('close', () => {
        closed = true;
        stop();
        clearInterval(heartbeat);
        res.end();
      });
      try {
        stop = await ctx.docker.followLogs(req.params.id, {
          tail,
          onLine: (line) => !closed && send('log', { line }),
          onEnd: () => !closed && send('ended', {}),
        });
        if (closed) stop();
      } catch {
        send('log', { line: "(no container logs yet — this server hasn't run)" });
        send('ended', {});
      }
    }),
  );

  // ---- Advanced server settings (full server-settings.json body) ----

  r.get(
    '/:id/settings',
    asyncHandler(async (req, res) => {
      res.json(manager.getSettings(req.params.id));
    }),
  );

  r.put(
    '/:id/settings',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ settings: z.record(z.string(), z.unknown()) }), req.body);
      res.json(await manager.updateSettings(req.params.id, body.settings));
    }),
  );

  // Reset one cascading setting back to inheriting the global default.
  r.post(
    '/:id/settings/reset',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ setting: z.string().min(1) }), req.body);
      res.json({ server: dtoOf(manager.resetSetting(req.params.id, body.setting)) });
    }),
  );

  // ---- Map generation (new-save settings) ----

  r.get(
    '/:id/mapgen',
    asyncHandler(async (req, res) => {
      res.json(manager.getMapGen(req.params.id));
    }),
  );

  r.put(
    '/:id/mapgen',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          mapGen: z.record(z.string(), z.unknown()),
          mapSettings: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
        req.body,
      );
      res.json(await manager.updateMapGen(req.params.id, body));
    }),
  );

  // Decode a map exchange string into JSON (Factorio's own parser, one-shot).
  r.post(
    '/:id/mapgen/import',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ exchangeString: z.string().min(6).max(200000) }), req.body);
      res.json(await manager.importExchangeString(req.params.id, body.exchangeString));
    }),
  );

  // Default map-gen for the server's mods (dynamic control set for Modded servers).
  r.post(
    '/:id/mapgen/baseline',
    asyncHandler(async (req, res) => {
      res.json(await manager.mapGenBaseline(req.params.id));
    }),
  );

  // Planets the server's loaded mods define — the previewable set, including modded
  // ones. Boots a scenario one-shot on a cold mod set, so it is not fetched per render.
  r.get(
    '/:id/mapgen/planets',
    asyncHandler(async (req, res) => {
      res.json({ planets: await manager.listPlanets(req.params.id) });
    }),
  );

  // Enabled mods that rewrite the world at runtime, which no preview can show.
  // Filesystem-only: reads the mod zips already on disk, boots nothing.
  r.get(
    '/:id/mapgen/runtime-mods',
    asyncHandler(async (req, res) => {
      res.json({ mods: manager.runtimeMapGenMods(req.params.id) });
    }),
  );

  // Encode the given (or saved) settings into a shareable exchange string (on-demand).
  r.post(
    '/:id/mapgen/export',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ mapGen: z.record(z.string(), z.unknown()).optional() }), req.body ?? {});
      res.json({ exchangeString: await manager.exportExchangeString(req.params.id, body.mapGen) });
    }),
  );

  // Render a map preview PNG (current editor settings, or the server's saved ones).
  r.post(
    '/:id/mapgen/preview',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          mapGen: z.record(z.string(), z.unknown()).optional(),
          planet: z.string().max(40).optional(),
          seed: z.number().int().optional(),
          size: z.number().int().min(256).max(2048).optional(),
        }),
        req.body ?? {},
      );
      const png = await manager.previewMap(req.params.id, body);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(png);
    }),
  );

  // ---- Per-server player whitelist ----

  r.get(
    '/:id/whitelist',
    asyncHandler(async (req, res) => {
      res.json({ whitelist: manager.getServerWhitelist(req.params.id) });
    }),
  );

  r.put(
    '/:id/whitelist',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ whitelist: z.array(z.string().max(100)) }), req.body);
      res.json({ whitelist: await manager.setServerWhitelist(req.params.id, body.whitelist) });
    }),
  );

  // ---- Per-server admin list ----

  r.get(
    '/:id/adminlist',
    asyncHandler(async (req, res) => {
      res.json({ adminlist: manager.getServerAdminlist(req.params.id) });
    }),
  );

  r.put(
    '/:id/adminlist',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ adminlist: z.array(z.string().max(100)) }), req.body);
      res.json({ adminlist: await manager.setServerAdminlist(req.params.id, body.adminlist) });
    }),
  );

  // ---- Saves ----

  r.get(
    '/:id/saves',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      res.json({ saves: serverFiles.listSaves(row.id), selected: row.save_name });
    }),
  );

  r.post(
    '/:id/saves',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      if (!req.file) throw new ValidationError('Expected a multipart file field named "file"');
      const rawName = (req.body?.name as string) || req.file.originalname;
      const name = sanitizeName(rawName);
      serverFiles.writeSave(row.id, name, req.file.buffer);
      res.status(201).json({ saves: serverFiles.listSaves(row.id) });
    }),
  );

  r.post(
    '/:id/saves/create',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
      const result = await manager.createSave(req.params.id, body.name);
      res.status(201).json({ ...result, saves: serverFiles.listSaves(req.params.id) });
    }),
  );

  r.get(
    '/:id/saves/:name/download',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const name = sanitizeName(req.params.name);
      const buf = serverFiles.readSave(row.id, name);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.send(buf);
    }),
  );

  r.post(
    '/:id/saves/:name/select',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const name = sanitizeName(req.params.name);
      if (!serverFiles.saveExists(row.id, name)) throw new ValidationError(`No such save "${name}"`);
      // Selecting an existing save means: load it, don't generate a new one.
      const updated = await manager.update(row.id, { saveName: name, generateNewSave: false });
      res.json({ server: dtoOf(updated) });
    }),
  );

  r.post(
    '/:id/saves/:name/restore',
    asyncHandler(async (req, res) => {
      const name = sanitizeName(req.params.name);
      const row = await manager.restoreFromSave(req.params.id, name);
      res.json({ server: dtoOf(row) });
    }),
  );

  r.delete(
    '/:id/saves/:name',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const name = sanitizeName(req.params.name);
      serverFiles.deleteSave(row.id, name);
      res.status(204).end();
    }),
  );

  // ---- Backups ----

  r.get(
    '/:id/backups',
    asyncHandler(async (req, res) => {
      res.json({ backups: manager.listBackups(req.params.id) });
    }),
  );

  r.post(
    '/:id/backups',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ saveName: z.string().max(100).optional() }), req.body ?? {});
      const result = await manager.backupNow(req.params.id, body.saveName);
      res.status(201).json({ ...result, backups: manager.listBackups(req.params.id) });
    }),
  );

  r.get(
    '/:id/backups/:name/download',
    asyncHandler(async (req, res) => {
      manager.get(req.params.id);
      const name = sanitizeName(req.params.name);
      const buf = serverFiles.readBackup(req.params.id, name);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.send(buf);
    }),
  );

  r.post(
    '/:id/backups/:name/restore',
    asyncHandler(async (req, res) => {
      const source = await manager.restoreBackup(req.params.id, sanitizeName(req.params.name));
      res.json({ restoredTo: source });
    }),
  );

  r.delete(
    '/:id/backups/:name',
    asyncHandler(async (req, res) => {
      manager.deleteBackup(req.params.id, sanitizeName(req.params.name));
      res.status(204).end();
    }),
  );

  // ---- Mods ----

  r.get(
    '/:id/mods',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      res.json({ mods: mods.getModList(row.id) });
    }),
  );

  r.put(
    '/:id/mods',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const body = parse(z.object({ mods: z.array(modEntrySchema) }), req.body);
      const result = await mods.applyModList(row, body.mods);
      await manager.maybeAutoRestart(row.id, true);
      // Reported here rather than only at start: this is where the user is standing
      // when they create the problem, and start() refuses on the same list.
      res.json({ mods: mods.getModList(row.id), ...result, problems: await modProblems(row.id) });
    }),
  );

  /**
   * Same check `start` enforces. Never fails the request — an image that isn't
   * pulled yet can't be inspected, and that is not a reason to break the mods UI.
   */
  const modProblems = async (id: string) => {
    try {
      return await manager.modProblems(id);
    } catch {
      return [];
    }
  };

  r.get(
    '/:id/mods/problems',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      res.json({ problems: await modProblems(row.id) });
    }),
  );

  r.post(
    '/:id/mods/upload',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      if (!req.file) throw new ValidationError('Expected a multipart file field named "file"');
      const result = mods.uploadModZip(row.id, req.file.buffer);
      await manager.maybeAutoRestart(row.id, true);
      res.status(201).json({ ...result, mods: mods.getModList(row.id) });
    }),
  );

  r.post(
    '/:id/mods/deleteAll',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      mods.deleteAllMods(row.id);
      await manager.maybeAutoRestart(row.id, true);
      res.json({ mods: mods.getModList(row.id) });
    }),
  );

  r.post(
    '/:id/mods/update',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const result = await mods.updateAll(row);
      await manager.maybeAutoRestart(row.id, true);
      res.json({ mods: mods.getModList(row.id), ...result });
    }),
  );

  r.get(
    '/:id/mods/export',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const manifest = mods.exportManifest(row.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${row.subdomain}-mods.json"`);
      res.send(JSON.stringify(manifest, null, 2));
    }),
  );

  // ---- RCON ----

  r.post(
    '/:id/rcon',
    asyncHandler(async (req, res) => {
      const row = manager.get(req.params.id);
      const body = parse(z.object({ command: z.string().min(1).max(2000) }), req.body);
      const response = await ctx.rcon.send(row, body.command);
      res.json({ response });
    }),
  );

  return r;
}
