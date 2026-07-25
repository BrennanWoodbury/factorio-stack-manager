import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('error');

/** Express async wrapper so route handlers can throw / reject. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Central error handler mapping known AppErrors to their HTTP status/code and
 * everything else to a generic 500. Every realistic failure mode (port pool
 * exhausted, Cloudflare failure, Docker unreachable, duplicate subdomain, bad
 * mod, validation) surfaces here as a structured JSON error.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  log.error(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: { code: 'INTERNAL', message } });
}
