import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Global mod-portal endpoints not tied to a specific server. Catalog search and
 * dependency resolution — both public metadata, so neither needs mod-portal
 * credentials (only downloading does).
 */
export function modsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const q = String(req.query.q ?? '');
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
      const results = await ctx.mods.search(q, limit);
      res.json({ results });
    }),
  );

  // POST rather than GET: `installed` is the caller's whole mod list, which on an
  // overhaul server is far too long to sit in a query string.
  r.post(
    '/dependencies',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          name: z.string().min(1).max(200),
          installed: z.array(z.string().max(200)).max(1000).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      res.json(await ctx.mods.resolveDependencies(parsed.data.name, parsed.data.installed ?? []));
    }),
  );

  return r;
}
