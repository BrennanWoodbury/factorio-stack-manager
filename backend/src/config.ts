import path from 'node:path';

/**
 * Central runtime configuration, sourced entirely from environment variables so
 * the whole stack is configured via docker-compose / .env. See README for the
 * meaning of each var and the required Cloudflare token permissions.
 */

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intOpt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

/** Parse a range like "34197-34297" into [start, end] inclusive. */
function parseRange(name: string, fallback: string): [number, number] {
  const raw = opt(name, fallback);
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
  if (!m) throw new Error(`Environment variable ${name} must look like "34197-34297"`);
  const start = Number.parseInt(m[1], 10);
  const end = Number.parseInt(m[2], 10);
  if (start > end) throw new Error(`Environment variable ${name}: range start must be <= end`);
  return [start, end];
}

export const config = {
  /** Build identity, stamped into the image by CI from the release tag. */
  appVersion: opt('APP_VERSION', 'dev'),
  port: intOpt('PORT', 8080),
  dataDir: path.resolve(opt('DATA_DIR', path.resolve(process.cwd(), '../data'))),
  dbPath: opt('DB_PATH', path.resolve(opt('DATA_DIR', path.resolve(process.cwd(), '../data')), 'manager.db')),

  // Auth for the web UI. adminPassword gates login; jwtSecret signs the session.
  adminPassword: req('ADMIN_PASSWORD'),
  jwtSecret: opt('JWT_SECRET', 'change-me-please-' + req('ADMIN_PASSWORD')),

  // The pre-forwarded, contiguous UDP game-port range. The allocator NEVER hands
  // out a port outside this range because ports outside it are not forwarded.
  gamePortRange: parseRange('GAME_PORT_RANGE', '34197-34297'),
  // RCON ports are loopback-only, never forwarded, never in DNS. Separate range.
  rconPortRange: parseRange('RCON_PORT_RANGE', '27015-27115'),

  // Docker
  dockerSocket: opt('DOCKER_SOCKET', '/var/run/docker.sock'),
  factorioImage: opt('FACTORIO_IMAGE', 'factoriotools/factorio:stable'),
  // Shared user-defined bridge network that the manager and every Factorio
  // container join, so the manager can reach RCON over the Docker network.
  factorioNetwork: opt('FACTORIO_NETWORK', 'factorio-net'),
  // PUID/PGID passed to the Factorio image so bind-mounted data-dir files are
  // owned by a matching host user. Empty => use the image default.
  puid: opt('PUID', ''),
  pgid: opt('PGID', ''),

  // Blueprint-library icons. The headless image ships no graphics at all, so item
  // icons are harvested from a real Factorio install and cached per game version.
  //
  // FACTORIO_INSTALL_DIR: optional path to an install the manager can read (the
  // directory holding `data/base/info.json`). Used only when its version matches
  // exactly, and it saves a multi-GB download when it does.
  //
  // ICON_DOWNLOAD: when true (default) and no matching install is available, the
  // build is fetched from factorio.com using the configured factorio.com account —
  // the same credentials already used for mod downloads. Assets are extracted
  // locally and never redistributed.
  factorioInstallDir: opt('FACTORIO_INSTALL_DIR', ''),
  iconDownloadEnabled: opt('ICON_DOWNLOAD', 'true') !== 'false',
  // How the backend reaches a server's RCON:
  //  - 'network'  : connect to <containerName>:27015 over factorioNetwork
  //                 (correct when the manager runs as a container). Default.
  //  - 'loopback' : connect to 127.0.0.1:<rconPort> (correct for local dev with
  //                 the backend running directly on the host).
  rconMode: opt('RCON_MODE', 'network') as 'network' | 'loopback',
  // When true, stop all managed Factorio containers when the manager shuts down.
  // Default false so games survive a manager restart/update (and so dev hot-reloads
  // don't kill running servers). Enable in production for a clean full shutdown.
  stopServersOnShutdown: opt('STOP_SERVERS_ON_SHUTDOWN', 'false') === 'true',
  shutdownStopTimeoutSecs: intOpt('SHUTDOWN_STOP_TIMEOUT_SECONDS', 30),
  // On startup, resume servers that were running (desired_state='running') but
  // whose container isn't. Default on.
  resumeServersOnStartup: opt('RESUME_SERVERS_ON_STARTUP', 'true') !== 'false',
  // Absolute path to the servers data dir *as seen by the Docker daemon (the host)*.
  // When the manager runs in a container, its own DATA_DIR is a mount, but the
  // Factorio containers it spawns are bind-mounted from the host path. These can
  // differ, so it's configured explicitly. Defaults to DATA_DIR/servers.
  hostServersDir: opt('HOST_SERVERS_DIR', path.resolve(opt('DATA_DIR', path.resolve(process.cwd(), '../data')), 'servers')),
  /** Whether HOST_SERVERS_DIR was set explicitly (so autodetection must not override it). */
  hostServersDirExplicit: process.env.HOST_SERVERS_DIR !== undefined && process.env.HOST_SERVERS_DIR !== '',

  // DNS / DDNS (Cloudflare) is configured entirely from the dashboard and stored
  // in the DB (see services/dnsSettings.ts) — there are no DNS env vars.
} as const;

export type AppConfig = typeof config;

/**
 * Startup can improve on the configured host servers dir by reading the manager's
 * own mount table (see DockerService.resolveHostPath), so this one value is
 * resolved late rather than frozen at import.
 */
let hostServersDirOverride: string | null = null;

export function setHostServersDir(dir: string): void {
  hostServersDirOverride = dir;
}

/** The servers dir as the *host* Docker daemon sees it. */
export function getHostServersDir(): string {
  return hostServersDirOverride ?? config.hostServersDir;
}

/** Directory (as the manager process sees it) holding all per-server data dirs. */
export const serversDir = path.resolve(config.dataDir, 'servers');
