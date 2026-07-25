import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, getHostServersDir, setHostServersDir } from './config.js';
import { buildContext } from './context.js';
import { containerStatusLabel } from './services/dockerService.js';
import { kvGet, kvSet } from './db/index.js';
import { getFactorioAccount, setFactorioAccount } from './services/factorioAccount.js';
import { authRouter } from './routes/auth.js';
import { serversRouter } from './routes/servers.js';
import { modsRouter } from './routes/mods.js';
import { modpacksRouter } from './routes/modpacks.js';
import { mapGenTemplatesRouter } from './routes/mapGenTemplates.js';
import { globalRouter } from './routes/global.js';
import { systemRouter } from './routes/system.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

async function main() {
  const ctx = buildContext(config);

  // Best-effort startup reconcile: align each server's stored status with the
  // actual container state (containers may have been started/stopped/crashed
  // while the manager was down).
  try {
    for (const row of ctx.repo.list()) {
      const cs = await ctx.docker.status(row.id);
      const status = containerStatusLabel(cs);
      if (row.status !== status) ctx.repo.setStatus(row.id, status);
    }
  } catch (err) {
    console.warn(`[startup] status reconcile skipped: ${(err as Error).message}`);
  }

  // Seed the built-in "Space Age" modpack once. The kv guard means a user who
  // deletes it won't have it recreated on the next restart.
  if (kvGet(ctx.db, 'default_modpacks_seeded') !== '1') {
    try {
      ctx.modpacks.seedSpaceAge();
    } catch (err) {
      console.warn(`[startup] modpack seed skipped: ${(err as Error).message}`);
    }
    kvSet(ctx.db, 'default_modpacks_seeded', '1');
  }

  // One-time: migrate any existing per-server Factorio.com credentials to the new
  // single global account, so upgrades keep working without re-entering them.
  if (kvGet(ctx.db, 'factorio_account_migrated') !== '1') {
    try {
      const acct = getFactorioAccount(ctx.db);
      if (!acct.username && !acct.token) {
        const row = ctx.db
          .prepare<{ u: string; t: string }>(
            "SELECT factorio_username AS u, factorio_token AS t FROM servers WHERE factorio_username <> '' AND factorio_token <> '' LIMIT 1",
          )
          .get();
        if (row?.u && row?.t) {
          setFactorioAccount(ctx.db, { username: row.u, token: row.t });
          console.log('[startup] migrated a per-server Factorio.com account to the global setting');
        }
      }
    } catch (err) {
      console.warn(`[startup] factorio account migration skipped: ${(err as Error).message}`);
    }
    kvSet(ctx.db, 'factorio_account_migrated', '1');
  }

  // Seed the built-in map-generation templates once (same delete-safe kv guard).
  if (kvGet(ctx.db, 'default_map_templates_seeded') !== '1') {
    try {
      ctx.mapGenTemplates.seedDefaults();
    } catch (err) {
      console.warn(`[startup] map template seed skipped: ${(err as Error).message}`);
    }
    kvSet(ctx.db, 'default_map_templates_seeded', '1');
  }

  // When containerised, learn our own Docker identity before anything spawns a
  // server: it tells us the host path behind DATA_DIR (so sibling containers get
  // valid bind mounts without an identity mount or HOST_SERVERS_DIR), and lets us
  // join the Factorio network ourselves so RCON works on a plain bridge install.
  await ctx.docker
    .ensureNetwork()
    .then(() => ctx.docker.ensureSelfOnNetwork())
    .catch((err) => console.warn(`[startup] network setup: ${(err as Error).message}`));

  if (!config.hostServersDirExplicit) {
    const hostData = await ctx.docker.resolveHostPath(config.dataDir).catch(() => null);
    if (hostData) {
      setHostServersDir(path.join(hostData, 'servers'));
      console.log(`[startup] host data dir resolved to ${hostData}`);
    }
  }
  console.log(`[startup] Factorio containers bind-mount from ${getHostServersDir()}`);

  if (ctx.dns.enabled) {
    void ctx.dns
      .reconcile()
      .then((result) => {
        if (!result.ok) console.warn('[startup] DNS reconciliation completed with errors');
      })
      .catch((err) => console.warn(`[startup] DNS reconciliation failed: ${(err as Error).message}`))
      .finally(() => ctx.ddns.start());
  } else ctx.ddns.start();
  ctx.backups.start();
  ctx.draftPrune.start();

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Unauthenticated auth endpoints.
  app.use('/api/auth', authRouter(ctx));
  // Everything else under /api requires a valid session.
  app.use('/api', requireAuth(config));
  app.use('/api/servers', serversRouter(ctx));
  app.use('/api/mods', modsRouter(ctx));
  app.use('/api/modpacks', modpacksRouter(ctx));
  app.use('/api/mapgen-templates', mapGenTemplatesRouter(ctx));
  app.use('/api/global', globalRouter(ctx));
  app.use('/api/system', systemRouter(ctx));

  // Serve the built SPA if present (single-container deployment).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const spaDir = path.resolve(here, '../../frontend/dist');
  if (fs.existsSync(spaDir)) {
    app.use(express.static(spaDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(spaDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`[factorio-manager] listening on :${config.port}`);
    console.log(`[factorio-manager] DNS ${ctx.dns.enabled ? 'enabled' : 'disabled'}, ` +
      `game ports ${config.gamePortRange.join('-')}, rcon ${config.rconPortRange.join('-')}`);
  });

  // Resume servers that were running before the manager stopped. In the background
  // (may pull images / take a while) so the API is available immediately.
  if (config.resumeServersOnStartup) {
    void ctx.manager
      .resumeDesiredRunning()
      .catch((err) => console.error(`[startup] resume failed: ${(err as Error).message}`));
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // ignore repeated signals while stopping
    shuttingDown = true;
    console.log('[factorio-manager] shutting down');
    ctx.ddns.stop();
    ctx.backups.stop();
    if (config.stopServersOnShutdown) {
      try {
        const n = await ctx.docker.stopAllManaged(config.shutdownStopTimeoutSecs);
        console.log(`[shutdown] stopped ${n} managed Factorio container(s)`);
      } catch (err) {
        console.warn(`[shutdown] stopping managed containers failed: ${(err as Error).message}`);
      }
    }
    await ctx.rcon.disconnectAll();
    server.close();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[factorio-manager] fatal:', err);
  process.exit(1);
});
