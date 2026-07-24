import { Router } from 'express';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { gameModeIssue } from '../services/imageProfile.js';

/** Game modes whose availability depends on the Factorio version. */
const CHECKED_MODES = ['vanilla', 'space_age', 'space_age_no_quality', 'modded'];

/** System-wide health/introspection for the dashboard header. */
export function systemRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/status',
    asyncHandler(async (_req, res) => {
      let dockerOk = true;
      let dockerError: string | undefined;
      try {
        await ctx.docker.ping();
      } catch (err) {
        dockerOk = false;
        dockerError = (err as Error).message;
      }

      res.json({
        version: ctx.config.appVersion,
        docker: { ok: dockerOk, error: dockerError },
        dns: {
          enabled: ctx.dns.enabled,
          baseDomain: ctx.dns.settings().baseDomain || null,
          hostRecord: ctx.dns.settings().hostRecordName || null,
        },
        ddns: ctx.ddns.status(),
        ports: {
          game: {
            range: ctx.config.gamePortRange,
            ...ctx.allocator.capacity('game'),
          },
          rcon: {
            range: ctx.config.rconPortRange,
            ...ctx.allocator.capacity('rcon'),
          },
        },
      });
    }),
  );

  /**
   * What a Factorio image supports: its version, the mods it bundles, and why a
   * game mode is unavailable on it (2.0's space-age hard-requires quality, so
   * "without Quality" can't load there).
   *
   * Best-effort by design — it never pulls, because a dropdown must not block on a
   * ~600 MB download. `known: false` means "not fetched yet, don't claim anything";
   * start and Test & Create do the authoritative check with the image in hand.
   */
  r.get(
    '/factorio-image',
    asyncHandler(async (req, res) => {
      const tag = String(req.query.tag ?? '').trim();
      const image = ctx.docker.imageFor({ factorio_tag: tag });
      let profile = null;
      try {
        profile = await ctx.manager.imageProfiles.peekImage(image);
      } catch {
        /* treat any failure as "unknown" — this is only a hint */
      }
      if (!profile) {
        res.json({ known: false, image });
        return;
      }
      res.json({
        known: true,
        image,
        gameVersion: profile.gameVersion,
        bundledMods: [...profile.mods.keys()].sort(),
        modeIssues: Object.fromEntries(
          CHECKED_MODES.map((m) => [m, gameModeIssue(m, profile)]).filter(([, issue]) => issue),
        ),
      });
    }),
  );

  return r;
}
