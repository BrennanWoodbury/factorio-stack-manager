import Docker from 'dockerode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { ServerRow } from '../db/models.js';
import { DockerError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('docker');

/**
 * Internal (container-side) RCON port. RCON is never forwarded externally, so its
 * container port is fixed and every container can share it (they're in separate
 * network namespaces); the manager reaches each one by its unique network alias.
 *
 * The GAME port, by contrast, is bound inside the container to the server's own
 * allocated port (via the image's PORT env → `--port`) and published 1:1 to the
 * host, so external == host == container == the SRV-advertised port with no
 * translation anywhere. That end-to-end match is required for Factorio's public
 * server listing / NAT punch-through to advertise the reachable port.
 */
export const RCON_PORT_INTERNAL = 27015;

export const MANAGED_LABEL = 'factorio-stack-manager.managed';
export const SERVER_ID_LABEL = 'factorio-stack-manager.server-id';
/**
 * Labels every container created before the "Factorio Stack Manager" rebrand
 * carries. Docker labels are immutable once a container exists, so an already-
 * running Factorio server can never be relabelled without recreating it — which
 * would kill a live game. Every place that discovers "is this ours" must
 * therefore recognize either label; only newly-created containers get the new one.
 */
export const LEGACY_MANAGED_LABEL = 'factorio-manager.managed';
export const LEGACY_SERVER_ID_LABEL = 'factorio-manager.server-id';

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  /** Factorio version declared by the exact image backing a running container. */
  factorioVersion?: string;
  startedAt?: string;
  state?: string;
  /** Exit code of the last run — meaningful only once it has exited at least once. */
  exitCode?: number;
  /** How many times the restart policy has restarted it. Non-zero means it died. */
  restartCount?: number;
}

/**
 * The stored status for a container state.
 *
 * `crashed` exists because Docker reports `restarting` only while it waits out the
 * backoff between crashes: a server dying on startup would otherwise read as plain
 * `stopped`, the one status that suggests nothing is wrong. Shared with the startup
 * reconcile so a crash loop isn't relabelled `stopped` when the manager restarts.
 */
export function containerStatusLabel(cs: ContainerStatus): string {
  if (cs.state === 'restarting') return 'crashed';
  return cs.running ? 'running' : 'stopped';
}

/**
 * Host ports Docker named in a bind failure, e.g.
 *   Bind for 0.0.0.0:34197 failed: port is already allocated
 *
 * Empty when the error isn't a port conflict, which is how callers tell the two
 * apart — there is no status code that distinguishes it.
 */
export function conflictingHostPorts(err: unknown): number[] {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!/port is already allocated|address already in use/i.test(message)) return [];
  const ports = [...message.matchAll(/Bind for [^\s]*?:(\d+)/g)].map((m) => Number(m[1]));
  return ports.filter((p) => Number.isInteger(p) && p > 0);
}

/**
 * Wraps dockerode to create/start/stop/remove the per-server Factorio containers.
 *
 * Port mapping (the crux of the networking model):
 *   - game: <allocatedGamePort>:<allocatedGamePort>/udp — Factorio inside the
 *     container binds the same allocated port (PORT env → `--port`), and it's
 *     published 1:1 on 0.0.0.0. So external == host == container == advertised SRV
 *     port with no translation, which keeps Factorio's public listing / NAT
 *     punch-through pointing at the actually-reachable port.
 *   - rcon: 127.0.0.1:<allocatedRconPort>:27015/tcp — published only on host
 *     loopback, never externally, never in DNS.
 * Additionally every Factorio container joins a shared user-defined network so the
 * (containerised) manager can reach RCON at <containerName>:27015 without relying
 * on host loopback at all.
 */
export class DockerService {
  private readonly docker: Docker;
  /** Image IDs are immutable, so their Factorio-version labels are safe to retain. */
  private readonly factorioVersions = new Map<string, Promise<string | undefined>>();

  constructor(private readonly config: AppConfig) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
  }

  /** Deterministic container name; also used as the RCON network hostname. */
  containerName(serverId: string): string {
    return `ftm-${serverId}`;
  }

  /**
   * Resolve the Docker image for a server. A per-server `factorio_tag` overrides
   * just the tag of the configured base repo (e.g. FACTORIO_IMAGE
   * `factoriotools/factorio:stable` + tag `latest` => `factoriotools/factorio:latest`);
   * empty tag uses the global image as-is.
   */
  imageFor(server: { factorio_tag?: string | null }): string {
    const tag = (server.factorio_tag ?? '').trim();
    if (!tag) return this.config.factorioImage;
    const base = this.config.factorioImage;
    // Split off the existing tag, being careful not to treat a registry port
    // (host:5000/...) as a tag: the tag colon must come after the last slash.
    const lastColon = base.lastIndexOf(':');
    const lastSlash = base.lastIndexOf('/');
    const repo = lastColon > lastSlash ? base.slice(0, lastColon) : base;
    return `${repo}:${tag}`;
  }

  /**
   * Ensure an image is available, pulling on EVERY call so moving tags (stable,
   * latest) pick up updates on each container (re)create. If the pull fails but we
   * already have a local copy (e.g. registry unreachable / offline), we proceed
   * with the local image rather than blocking the start.
   */
  async ensureImage(image: string): Promise<void> {
    try {
      log.info(`pulling ${image} (checking for updates) …`);
      await this.pullImage(image);
      log.info(`${image} up to date`);
    } catch (pullErr) {
      try {
        await this.docker.getImage(image).inspect();
        log.warn(`pull ${image} failed (${(pullErr as Error).message}); using local copy`);
      } catch {
        throw pullErr instanceof DockerError
          ? pullErr
          : new DockerError(`image ${image} unavailable: ${(pullErr as Error).message}`);
      }
    }
  }

  private pullImage(image: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err || !stream) {
          reject(new DockerError(`pull ${image} failed: ${err?.message ?? 'no stream'}`));
          return;
        }
        this.docker.modem.followProgress(stream, (doneErr: Error | null) =>
          doneErr ? reject(new DockerError(`pull ${image} failed: ${doneErr.message}`)) : resolve(),
        );
      });
    });
  }

  /**
   * Gracefully stop every running container this manager created (identified by
   * the managed label). Stops happen in parallel so total time ≈ one container's
   * stop timeout. Used on manager shutdown. Returns how many were stopped.
   */
  async stopAllManaged(timeoutSecs = 30): Promise<number> {
    const list = await this.docker.listContainers({
      filters: { label: [`${MANAGED_LABEL}=true`, `${LEGACY_MANAGED_LABEL}=true`] },
    });
    await Promise.all(
      list.map(async (c) => {
        try {
          await this.docker.getContainer(c.Id).stop({ t: timeoutSecs });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code !== 304 && code !== 404) {
            log.warn(`stop ${c.Names?.[0] ?? c.Id} failed: ${(err as Error).message}`);
          }
        }
      }),
    );
    return list.length;
  }

  /** IDs of servers with a currently-running (managed) container. */
  async runningServerIds(): Promise<string[]> {
    const list = await this.docker.listContainers({
      filters: { label: [`${MANAGED_LABEL}=true`, `${LEGACY_MANAGED_LABEL}=true`] },
    });
    return list
      .map((c) => c.Labels?.[SERVER_ID_LABEL] ?? c.Labels?.[LEGACY_SERVER_ID_LABEL])
      .filter((id): id is string => !!id);
  }

  /**
   * Host ports currently published by *any* container, ours or not.
   *
   * The allocator's table only knows what this manager handed out; a Factorio
   * server someone runs from another compose file holds a real port that would
   * otherwise be handed out and fail at start. Only running containers publish
   * bindings, so stopped ones are excluded on purpose.
   *
   * `excludeServerId`, when given, skips that server's own container. A restart
   * recreates the container without stopping it first, so its own still-running
   * container would otherwise show its current ports as "taken" — which would
   * bounce the server off its own port on every restart instead of keeping it.
   *
   * This cannot see a native process holding a port — nothing short of binding it
   * can, and the manager runs in its own network namespace. That case is caught
   * at start instead, where Docker reports the conflict.
   */
  async hostPortsInUse(excludeServerId?: string): Promise<Set<number>> {
    const ports = new Set<number>();
    try {
      for (const c of await this.docker.listContainers()) {
        if (
          excludeServerId &&
          (c.Labels?.[SERVER_ID_LABEL] === excludeServerId ||
            c.Labels?.[LEGACY_SERVER_ID_LABEL] === excludeServerId)
        )
          continue;
        for (const p of c.Ports ?? []) {
          if (typeof p.PublicPort === 'number') ports.add(p.PublicPort);
        }
      }
    } catch (err) {
      // Never block an allocation on this: it is an optimisation over the
      // authoritative check, which is the bind itself.
      log.warn(`could not list published ports: ${(err as Error).message}`);
    }
    return ports;
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new DockerError(`daemon unreachable: ${(err as Error).message}`);
    }
  }

  /** Create the shared bridge network if it doesn't already exist. */
  async ensureNetwork(): Promise<void> {
    const name = this.config.factorioNetwork;
    try {
      const networks = await this.docker.listNetworks({ filters: { name: [name] } });
      if (networks.some((n) => n.Name === name)) return;
      await this.docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true });
      log.info(`created network ${name}`);
    } catch (err) {
      throw new DockerError(`ensureNetwork failed: ${(err as Error).message}`);
    }
  }

  /**
   * Our own container, when the manager runs inside one. Null on a host-mode dev
   * backend, which is not an error — the callers below just skip their work.
   *
   * Docker names a container's hostname after its short ID unless overridden, and
   * the API accepts an ID prefix, so that's the cheap path. Templates that set an
   * explicit hostname (Unraid does) fall through to the container ID that appears
   * in our own mountinfo/cgroup lines.
   */
  private selfIdPromise?: Promise<string | null>;
  async selfContainerId(): Promise<string | null> {
    this.selfIdPromise ??= (async () => {
      try {
        const byHostname = await this.docker.getContainer(os.hostname()).inspect();
        return byHostname.Id;
      } catch {
        /* hostname isn't our container ID — fall through */
      }
      for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
        try {
          const match = fs.readFileSync(file, 'utf8').match(/[0-9a-f]{64}/);
          if (match) {
            // Confirm it really is a container we can see, not an image layer hash.
            const c = await this.docker.getContainer(match[0]).inspect();
            return c.Id;
          }
        } catch {
          /* try the next source */
        }
      }
      return null;
    })();
    return this.selfIdPromise;
  }

  /**
   * Attach the manager itself to the Factorio network, so it can reach each
   * server's RCON at `<containerName>:27015`.
   *
   * Without this the manager has to be placed on that network at create time,
   * which compose can express but a one-click install can't: the network doesn't
   * exist until the manager first runs. Getting it wrong is quietly broken rather
   * than obviously broken — servers start and play fine, while the console and
   * player list fail with ENOTFOUND. Doing it here means a plain bridge container
   * works with no manual network setup.
   */
  async ensureSelfOnNetwork(): Promise<void> {
    const id = await this.selfContainerId();
    if (!id) return; // not containerised (host-mode dev) — RCON_MODE=loopback applies
    const name = this.config.factorioNetwork;
    try {
      const net = await this.docker.getNetwork(name).inspect();
      if (Object.keys(net.Containers ?? {}).some((c) => c === id)) return; // already attached
      await this.docker.getNetwork(name).connect({ Container: id });
      log.info(`attached manager to ${name} for RCON`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/already exists|already attached|endpoint with name/i.test(msg)) return;
      log.warn(`could not attach the manager to ${name}: ${msg} — RCON may fail`);
    }
  }

  /**
   * The host path backing a path inside our own container, or null if we can't
   * tell. Factorio containers are siblings on the host daemon, so their bind
   * mounts must be expressed in *host* paths — which we otherwise have to be told
   * (HOST_SERVERS_DIR) or have to assume the data dir is mounted at an identical
   * path on both sides. Reading our own mount table removes both requirements,
   * and with them a misconfiguration whose symptom is a server that starts with
   * none of its saves.
   */
  async resolveHostPath(containerPath: string): Promise<string | null> {
    const id = await this.selfContainerId();
    if (!id) return null;
    try {
      const info = await this.docker.getContainer(id).inspect();
      const target = path.resolve(containerPath);
      let best: { source: string; destination: string } | null = null;
      for (const m of info.Mounts ?? []) {
        const dest = path.resolve(m.Destination);
        const inside = target === dest || target.startsWith(`${dest}${path.sep}`);
        if (!inside) continue;
        // Longest matching destination wins — mounts can nest.
        if (!best || dest.length > best.destination.length) {
          best = { source: m.Source, destination: dest };
        }
      }
      if (!best) return null;
      return path.join(best.source, path.relative(best.destination, target));
    } catch {
      return null;
    }
  }

  private envFor(server: ServerRow): string[] {
    const env: Record<string, string> = {
      SAVE_NAME: server.save_name,
      GENERATE_NEW_SAVE: server.generate_new_save === 1 ? 'true' : 'false',
      LOAD_LATEST_SAVE: 'false',
      // Bind Factorio inside the container to the server's own allocated game port
      // so it matches the host/external/SRV port 1:1 (no translation). RCON stays on
      // the fixed internal port (loopback/Docker-network only, never forwarded).
      PORT: String(server.game_port),
      RCON_PORT: String(RCON_PORT_INTERNAL),
      RCON_PASSWORD: server.rcon_password,
      // We manage mods ourselves via the Mod Portal API, so keep the image from
      // trying to update them on boot (which would also fail without creds). Note
      // this also means the image's USERNAME/TOKEN env vars (its mod-updater's only
      // consumer) are never read — the account credentials for public-server listing
      // go into server-settings.json instead (see ServerFilesService.effectiveSettings).
      UPDATE_MODS_ON_START: 'false',
    };
    if (this.config.puid) env.PUID = this.config.puid;
    if (this.config.pgid) env.PGID = this.config.pgid;
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  /**
   * Create (but do not start) the container for a server. `hostDataDir` must be
   * the path as the *Docker daemon* sees it (the host path), not the manager's
   * in-container view. Returns the container id.
   */
  async createContainer(server: ServerRow, hostDataDir: string): Promise<string> {
    const gamePort = String(server.game_port);
    const rconPort = String(server.rcon_port);
    const image = this.imageFor(server);
    await this.ensureImage(image);
    try {
      const container = await this.docker.createContainer({
        name: this.containerName(server.id),
        Image: image,
        Env: this.envFor(server),
        ExposedPorts: {
          [`${gamePort}/udp`]: {},
          [`${RCON_PORT_INTERNAL}/tcp`]: {},
        },
        Labels: {
          [MANAGED_LABEL]: 'true',
          [SERVER_ID_LABEL]: server.id,
        },
        HostConfig: {
          Binds: [`${hostDataDir}:/factorio`],
          PortBindings: {
            // 1:1 — container game port == host game port == external/SRV port.
            [`${gamePort}/udp`]: [{ HostIp: '0.0.0.0', HostPort: gamePort }],
            // RCON published on host loopback only.
            [`${RCON_PORT_INTERNAL}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: rconPort }],
          },
          RestartPolicy: { Name: 'unless-stopped' },
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [this.config.factorioNetwork]: {
              Aliases: [this.containerName(server.id)],
            },
          },
        },
      });
      return container.id;
    } catch (err) {
      throw new DockerError(`createContainer failed: ${(err as Error).message}`);
    }
  }

  /**
   * Run the Factorio binary once to completion in a throwaway container (used for
   * offline operations like creating a save). The image entrypoint is overridden
   * to invoke the binary directly with `args`, the server's data dir is bind-
   * mounted at /factorio, no ports are published, and the container is removed
   * afterwards. Returns the exit code and combined logs.
   */
  /**
   * An image's ID plus the `factorio.version` label the factoriotools images carry
   * (free — no container needed). The ID is a content digest, so it makes a sound
   * cache key for anything derived from the image's contents.
   *
   * With `pullIfMissing: false` this returns null instead of fetching, for callers
   * that must stay fast (a UI hint can't block on a ~600 MB pull).
   */
  async imageIdentity(
    image: string,
    opts: { pullIfMissing?: boolean } = {},
  ): Promise<{ id: string; factorioVersion?: string } | null> {
    const inspect = async () => {
      const info = await this.docker.getImage(image).inspect();
      return { id: info.Id, factorioVersion: info.Config?.Labels?.['factorio.version'] };
    };
    try {
      return await inspect();
    } catch {
      if (opts.pullIfMissing === false) return null;
    }
    await this.ensureImage(image);
    return inspect();
  }

  /**
   * Run a shell snippet in a throwaway container of `image` and return its output.
   * Used to read files out of an image (its bundled mod manifests); nothing is
   * mounted and no ports are published.
   */
  async runImageShell(image: string, script: string, timeoutMs = 30_000): Promise<string> {
    const name = `ftm-imageprobe-${randomBytes(4).toString('hex')}`;
    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer({
        name,
        Image: image,
        Entrypoint: ['/bin/sh', '-c'],
        Cmd: [script],
        Labels: { [MANAGED_LABEL]: 'true' },
        HostConfig: { AutoRemove: false, NetworkMode: 'none' },
      });
      await container.start();
      const timer = setTimeout(() => void container?.stop({ t: 2 }).catch(() => {}), timeoutMs);
      await container.wait();
      clearTimeout(timer);
      return await this.readContainerLogs(container);
    } catch (err) {
      throw new DockerError(`image inspection failed: ${(err as Error).message}`);
    } finally {
      if (container) await container.remove({ force: true, v: false }).catch(() => {});
    }
  }

  async runOneShot(
    server: ServerRow,
    hostDataDir: string,
    args: string[],
    timeoutMs = 120_000,
  ): Promise<{ exitCode: number; logs: string }> {
    const name = `${this.containerName(server.id)}-job-${randomBytes(4).toString('hex')}`;
    const image = this.imageFor(server);
    await this.ensureImage(image);
    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer({
        name,
        Image: image,
        Entrypoint: ['/opt/factorio/bin/x64/factorio'],
        Cmd: args,
        Labels: { [MANAGED_LABEL]: 'true', [SERVER_ID_LABEL]: server.id },
        HostConfig: {
          Binds: [`${hostDataDir}:/factorio`],
          AutoRemove: false,
        },
      });
      await container.start();
      const timer = setTimeout(() => void container?.stop({ t: 5 }).catch(() => {}), timeoutMs);
      const result = (await container.wait()) as { StatusCode: number };
      clearTimeout(timer);
      const logs = await this.readContainerLogs(container);
      return { exitCode: result.StatusCode, logs };
    } catch (err) {
      throw new DockerError(`one-shot job failed: ${(err as Error).message}`);
    } finally {
      if (container) await container.remove({ force: true, v: false }).catch(() => {});
    }
  }

  /**
   * Run the binary in a throwaway container while streaming its logs line-by-line.
   * Resolves as soon as a `readyPatterns` line appears (the server came up) — stopping
   * the container — or when the process exits on its own, or on timeout. With no
   * patterns it simply waits for exit (used to stream one-shot generation). No host
   * ports are published, so a probe never announces itself.
   */
  async runProbe(
    server: ServerRow,
    hostDataDir: string,
    args: string[],
    opts: { readyPatterns?: RegExp[]; timeoutMs?: number; onLine?: (line: string) => void } = {},
  ): Promise<{ matched: boolean; exitCode: number | null; timedOut: boolean; logs: string }> {
    const { readyPatterns = [], timeoutMs = 180_000, onLine } = opts;
    const name = `${this.containerName(server.id)}-probe-${randomBytes(4).toString('hex')}`;
    const image = this.imageFor(server);
    await this.ensureImage(image);
    let container: Docker.Container | undefined;
    const lines: string[] = [];
    try {
      container = await this.docker.createContainer({
        name,
        Image: image,
        Entrypoint: ['/opt/factorio/bin/x64/factorio'],
        Cmd: args,
        Labels: { [MANAGED_LABEL]: 'true', [SERVER_ID_LABEL]: server.id },
        HostConfig: { Binds: [`${hostDataDir}:/factorio`], AutoRemove: false },
      });
      await container.start();
      const stream = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
      })) as unknown as NodeJS.ReadableStream;

      const outcome = await new Promise<{ matched: boolean; exitCode: number | null; timedOut: boolean }>(
        (resolve) => {
          let settled = false;
          const finish = (r: { matched: boolean; exitCode: number | null; timedOut: boolean }) => {
            if (!settled) {
              settled = true;
              resolve(r);
            }
          };
          const timer = setTimeout(() => finish({ matched: false, exitCode: null, timedOut: true }), timeoutMs);
          let buf = '';
          const sink = new Writable({
            write: (chunk: Buffer, _enc, cb) => {
              buf += chunk.toString('utf8');
              let nl: number;
              while ((nl = buf.indexOf('\n')) >= 0) {
                // eslint-disable-next-line no-control-regex
                const line = buf.slice(0, nl).replace(/[\r\x00-\x08]/g, '').trimEnd();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                lines.push(line);
                onLine?.(line);
                if (readyPatterns.some((re) => re.test(line))) {
                  clearTimeout(timer);
                  finish({ matched: true, exitCode: null, timedOut: false });
                }
              }
              cb();
            },
          });
          this.docker.modem.demuxStream(stream, sink, sink);
          void container!
            .wait()
            .then((res: { StatusCode: number }) => {
              clearTimeout(timer);
              finish({ matched: false, exitCode: res.StatusCode, timedOut: false });
            })
            .catch(() => {});
        },
      );

      // Matched or timed out => the process may still be running; stop it.
      if (outcome.exitCode === null) await container.stop({ t: 5 }).catch(() => {});
      return { ...outcome, logs: lines.join('\n') };
    } catch (err) {
      throw new DockerError(`probe failed: ${(err as Error).message}`);
    } finally {
      if (container) await container.remove({ force: true, v: false }).catch(() => {});
    }
  }

  /**
   * Follow a server container's logs live: emit recent scrollback (`tail`) then stream
   * new lines to `onLine`, calling `onEnd` when the stream closes (container stopped or
   * removed). Returns a stop() to tear down. Throws if the container doesn't exist.
   */
  async followLogs(
    serverId: string,
    opts: { tail?: number; onLine: (line: string) => void; onEnd?: () => void },
  ): Promise<() => void> {
    const container = this.docker.getContainer(this.containerName(serverId));
    await container.inspect(); // 404s if there's no container yet
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 500,
    })) as unknown as NodeJS.ReadableStream;
    let buf = '';
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          // eslint-disable-next-line no-control-regex
          const line = buf.slice(0, nl).replace(/[\r\x00-\x08]/g, '').trimEnd();
          buf = buf.slice(nl + 1);
          if (line) opts.onLine(line);
        }
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, sink, sink);
    stream.on('end', () => opts.onEnd?.());
    stream.on('error', () => opts.onEnd?.());
    return () => {
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* already gone */
      }
    };
  }

  private async readContainerLogs(container: Docker.Container): Promise<string> {
    // No tail limit: one-shots emit results we parse (e.g. a multi-KB exchange-string
    // JSON on a single line) that a small tail can drop. One-shots are short-lived,
    // so the full log is small.
    const buf = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;
    return stripDockerLogHeader(buf);
  }

  async start(serverId: string): Promise<void> {
    await this.withContainer(serverId, (c) => c.start());
  }

  async stop(serverId: string): Promise<void> {
    // Graceful stop; Factorio saves on SIGTERM. Allow up to 30s.
    await this.withContainer(serverId, (c) => c.stop({ t: 30 }).catch((e: { statusCode?: number }) => {
      // 304 = already stopped; treat as success.
      if (e.statusCode === 304) return;
      throw e;
    }));
  }

  async restart(serverId: string): Promise<void> {
    await this.withContainer(serverId, (c) => c.restart({ t: 30 }));
  }

  async remove(serverId: string): Promise<void> {
    try {
      const c = this.docker.getContainer(this.containerName(serverId));
      await c.remove({ force: true, v: false });
    } catch (err) {
      const e = err as { statusCode?: number };
      if (e.statusCode === 404) return; // already gone
      throw new DockerError(`remove failed: ${(err as Error).message}`);
    }
  }

  async status(serverId: string): Promise<ContainerStatus> {
    try {
      const c = this.docker.getContainer(this.containerName(serverId));
      const info = await c.inspect();
      const running = info.State.Running === true;
      const factorioVersion = running && info.Image ? await this.factorioVersion(info.Image) : undefined;
      return {
        exists: true,
        running,
        factorioVersion,
        startedAt: info.State.StartedAt,
        state: info.State.Status,
        exitCode: info.State.ExitCode,
        restartCount: info.RestartCount,
      };
    } catch (err) {
      const e = err as { statusCode?: number };
      if (e.statusCode === 404) return { exists: false, running: false };
      throw new DockerError(`status failed: ${(err as Error).message}`);
    }
  }

  /** Read and cache the version label from the immutable image used by a container. */
  private factorioVersion(imageId: string): Promise<string | undefined> {
    let version = this.factorioVersions.get(imageId);
    if (!version) {
      version = this.docker
        .getImage(imageId)
        .inspect()
        .then((info) => info.Config?.Labels?.['factorio.version'])
        .catch(() => undefined);
      this.factorioVersions.set(imageId, version);
    }
    return version;
  }

  /** Tail recent container logs (for surfacing start failures like a bad mod). */
  async logs(serverId: string, tail = 200): Promise<string> {
    try {
      const c = this.docker.getContainer(this.containerName(serverId));
      const buf = (await c.logs({
        stdout: true,
        stderr: true,
        tail,
        follow: false,
      })) as unknown as Buffer;
      return stripDockerLogHeader(buf);
    } catch (err) {
      throw new DockerError(`logs failed: ${(err as Error).message}`);
    }
  }

  private async withContainer(serverId: string, fn: (c: Docker.Container) => Promise<unknown>) {
    try {
      const c = this.docker.getContainer(this.containerName(serverId));
      await fn(c);
    } catch (err) {
      if (err instanceof DockerError) throw err;
      throw new DockerError((err as Error).message);
    }
  }
}

/**
 * Docker multiplexes stdout/stderr with an 8-byte header per frame when no TTY.
 * Strip those headers to recover readable text.
 */
function stripDockerLogHeader(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 8 > buf.length) break;
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    out.push(buf.toString('utf8', start, Math.min(end, buf.length)));
    i = end;
  }
  const text = out.join('');
  // Fallback: if it didn't look framed, return raw.
  return text.length > 0 ? text : buf.toString('utf8');
}
