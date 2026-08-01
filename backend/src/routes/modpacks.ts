import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../lib/errors.js';
import { modpackKey, serverKey } from '../services/modJobService.js';

const modSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  version: z.string().nullable().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

export function modpacksRouter(ctx: AppContext): Router {
  const r = Router();
  const { modpacks } = ctx;

  r.get('/', asyncHandler(async (_req, res) => res.json({ modpacks: modpacks.list() })));

  r.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({ name: z.string().min(1).max(100), description: z.string().max(1000).optional() }),
        req.body,
      );
      const pack = modpacks.create(body);
      res.status(201).json(modpacks.get(pack.id));
    }),
  );

  r.post(
    '/from-server',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({ serverId: z.string().min(1), name: z.string().min(1).max(100) }),
        req.body,
      );
      const pack = modpacks.createFromServer(body.serverId, body.name);
      res.status(201).json(modpacks.get(pack.id));
    }),
  );

  r.post(
    '/import',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ manifest: z.record(z.string(), z.unknown()) }), req.body);
      const dto = modpacks.importManifest(body.manifest as never);
      res.status(201).json(modpacks.get(dto.id));
    }),
  );

  r.get('/:id', asyncHandler(async (req, res) => res.json(modpacks.get(req.params.id))));

  r.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(1000).optional(),
          factorioVersion: z.string().max(20).optional(),
        }),
        req.body,
      );
      res.json({ pack: modpacks.update(req.params.id, body) });
    }),
  );

  r.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      modpacks.delete(req.params.id);
      res.status(204).end();
    }),
  );

  r.put(
    '/:id/mods',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ mods: z.array(modSchema) }), req.body);
      const mods = modpacks.setMods(
        req.params.id,
        body.mods.map((m) => ({ name: m.name, enabled: m.enabled, version: m.version ?? null })),
      );
      res.json({ mods });
    }),
  );

  r.get(
    '/:id/plan',
    asyncHandler(async (req, res) => {
      const serverId = String(req.query.serverId ?? '');
      if (!serverId) throw new ValidationError('serverId is required');
      res.json(modpacks.plan(req.params.id, serverId));
    }),
  );

  // Applying downloads every mod in the pack, which for a big pack is minutes of
  // work — so it runs as a job and the response carries something to poll rather
  // than the finished result. Validation still happens here, synchronously, so a
  // bad pack or server id is a 404 on the request instead of a failed job.
  r.post(
    '/:id/apply',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ serverId: z.string().min(1) }), req.body);
      const plan = modpacks.plan(req.params.id, body.serverId);
      const job = ctx.modJobs.start(
        { kind: 'apply', key: serverKey(body.serverId), serverId: body.serverId, total: plan.mods.length },
        async (progress) => {
          const result = await modpacks.apply(req.params.id, body.serverId, progress);
          await ctx.manager.maybeAutoRestart(body.serverId, true);
          return result;
        },
      );
      res.status(202).json({ job });
    }),
  );

  r.post(
    '/:id/apply-all',
    asyncHandler(async (req, res) => {
      modpacks.get(req.params.id); // 404 now rather than inside the job
      const job = ctx.modJobs.start(
        { kind: 'apply-all', key: modpackKey(req.params.id) },
        async (progress) => {
          const results = await modpacks.applyToAllUsing(req.params.id, progress);
          for (const rslt of results) await ctx.manager.maybeAutoRestart(rslt.serverId, true);
          return {
            downloaded: results.flatMap((r2) => r2.downloaded),
            errors: results.flatMap((r2) => r2.errors),
          };
        },
      );
      res.status(202).json({ job });
    }),
  );

  r.get(
    '/:id/export',
    asyncHandler(async (req, res) => {
      const manifest = modpacks.exportManifest(req.params.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${manifest.name.replace(/[^a-z0-9_-]+/gi, '_')}.modpack.json"`,
      );
      res.send(JSON.stringify(manifest, null, 2));
    }),
  );

  return r;
}
