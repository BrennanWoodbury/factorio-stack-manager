import { Router } from 'express';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * Progress for mod downloads started elsewhere (save & download, apply a modpack,
 * update all). The UI polls `/:id` while a job it started is running, and lists on
 * mount so a page reload rejoins a download already in flight instead of showing
 * an idle button over a busy server.
 */
export function modJobsRouter(ctx: AppContext): Router {
  const r = Router();
  const { modJobs } = ctx;

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const key = req.query.key ? String(req.query.key) : undefined;
      const jobs = modJobs.list().filter((j) => (key ? j.key === key : true));
      res.json({ jobs });
    }),
  );

  r.get('/:id', asyncHandler(async (req, res) => res.json({ job: modJobs.get(req.params.id) })));

  return r;
}
