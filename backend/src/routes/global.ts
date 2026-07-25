import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../lib/errors.js';
import { dnsSettingsDto, getDnsSettings } from '../services/dnsSettings.js';
import { factorioAccountDto, getFactorioAccount, setFactorioAccount } from '../services/factorioAccount.js';
import {
  getGlobalDefaults,
  globalDefaultsDto,
  setGlobalDefaults,
  getGlobalAdvancedSettings,
  setGlobalAdvancedSettings,
} from '../services/globalDefaults.js';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/** Global settings that apply across all servers (whitelist + DNS/Cloudflare). */
export function globalRouter(ctx: AppContext): Router {
  const r = Router();

  // ---- DNS / Cloudflare (all configured here, nothing in env) ----

  r.get(
    '/dns',
    asyncHandler(async (_req, res) => {
      res.json({
        dns: dnsSettingsDto(getDnsSettings(ctx.db)),
        reconciliation: ctx.dns.reconciliationStatus(),
      });
    }),
  );

  r.put(
    '/dns',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          // The on/off switch, independent of the credentials below: turning DNS
          // off must not require clearing settings the user would have to retype.
          enabled: z.boolean().optional(),
          baseDomain: z.string().max(253).optional(),
          cloudflareZoneId: z.string().max(64).optional(),
          // Only sent when the admin (re)enters it. '' explicitly clears it.
          cloudflareToken: z.string().max(200).optional(),
          ddnsIntervalSeconds: z.number().int().min(30).max(86400).optional(),
          ipCheckUrl: z.string().url().max(300).optional(),
          expectedRevision: z.number().int().nonnegative().optional(),
        }),
        req.body,
      );
      const { expectedRevision, ...patch } = body;
      const activated = await ctx.dns.activateSettings(patch, expectedRevision);
      // Apply interval / enabled-state changes to the running DDNS job immediately.
      ctx.ddns.reschedule();
      res.json({
        dns: dnsSettingsDto(activated.settings),
        reconciliation: activated.reconciliation,
      });
    }),
  );

  r.post(
    '/dns/test',
    asyncHandler(async (req, res) => {
      const candidate = parse(
        z.object({
          baseDomain: z.string().max(253).optional(),
          cloudflareZoneId: z.string().max(64).optional(),
          cloudflareToken: z.string().max(200).optional(),
          ipCheckUrl: z.string().url().max(300).optional(),
        }),
        req.body,
      );
      res.json(await ctx.dns.testConnection(candidate));
    }),
  );

  r.post(
    '/dns/reconcile',
    asyncHandler(async (_req, res) => {
      res.json({ reconciliation: await ctx.dns.reconcile() });
    }),
  );

  // ---- Global server defaults (cascading, per-server overridable) ----

  const defaultsDto = () => {
    const g = getGlobalDefaults(ctx.db);
    const modpackName = g.modpackId
      ? (ctx.modpacks.list().find((m) => m.id === g.modpackId)?.name ?? null)
      : null;
    const mapTemplateName = g.mapTemplateId
      ? (ctx.mapGenTemplates.list().find((t) => t.id === g.mapTemplateId)?.name ?? null)
      : null;
    return globalDefaultsDto(ctx.db, { modpackName, mapTemplateName });
  };

  r.get('/defaults', asyncHandler(async (_req, res) => res.json({ defaults: defaultsDto() })));

  // Global advanced server-settings defaults (server-settings.json fields).
  r.get(
    '/advanced-settings',
    asyncHandler(async (_req, res) => res.json({ settings: getGlobalAdvancedSettings(ctx.db) })),
  );
  r.put(
    '/advanced-settings',
    asyncHandler(async (req, res) => {
      const body = parse(z.object({ settings: z.record(z.string(), z.unknown()) }), req.body);
      setGlobalAdvancedSettings(ctx.db, body.settings);
      res.json({ settings: getGlobalAdvancedSettings(ctx.db) });
    }),
  );

  r.put(
    '/defaults',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          autoRestart: z.boolean().optional(),
          autoBackup: z.boolean().optional(),
          backupIntervalMinutes: z.number().int().min(5).max(10080).optional(),
          backupKeep: z.number().int().min(1).max(1000).optional(),
          backupKeepManual: z.number().int().min(1).max(1000).optional(),
          modpackId: z.string().nullable().optional(),
          mapTemplateId: z.string().nullable().optional(),
        }),
        req.body,
      );
      setGlobalDefaults(ctx.db, body);
      res.json({ defaults: defaultsDto() });
    }),
  );

  // ---- Global Factorio.com account (one account for every server) ----

  r.get(
    '/factorio',
    asyncHandler(async (_req, res) => {
      res.json({ factorio: factorioAccountDto(getFactorioAccount(ctx.db)) });
    }),
  );

  r.put(
    '/factorio',
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          username: z.string().max(100).optional(),
          // Only sent when the admin (re)enters it. '' explicitly clears it.
          token: z.string().max(200).optional(),
        }),
        req.body,
      );
      setFactorioAccount(ctx.db, body);
      res.json({ factorio: factorioAccountDto(getFactorioAccount(ctx.db)) });
    }),
  );

  r.get(
    '/whitelist',
    asyncHandler(async (_req, res) => {
      res.json({ whitelist: ctx.manager.getGlobalWhitelist() });
    }),
  );

  r.put(
    '/whitelist',
    asyncHandler(async (req, res) => {
      const parsed = z.object({ whitelist: z.array(z.string().max(100)) }).safeParse(req.body);
      if (!parsed.success) throw new ValidationError('whitelist must be an array of names');
      res.json({ whitelist: await ctx.manager.setGlobalWhitelist(parsed.data.whitelist) });
    }),
  );

  r.get(
    '/adminlist',
    asyncHandler(async (_req, res) => {
      res.json({ adminlist: ctx.manager.getGlobalAdminlist() });
    }),
  );

  r.put(
    '/adminlist',
    asyncHandler(async (req, res) => {
      const parsed = z.object({ adminlist: z.array(z.string().max(100)) }).safeParse(req.body);
      if (!parsed.success) throw new ValidationError('adminlist must be an array of names');
      res.json({ adminlist: await ctx.manager.setGlobalAdminlist(parsed.data.adminlist) });
    }),
  );

  return r;
}
