import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config.js';
import {
  DockerService,
  MANAGED_LABEL,
  SERVER_ID_LABEL,
  LEGACY_MANAGED_LABEL,
  LEGACY_SERVER_ID_LABEL,
} from '../src/services/dockerService.js';

/**
 * Docker container labels are immutable once a container exists, so containers
 * created before the "Factorio Stack Manager" rebrand still carry the old label
 * keys and can never be relabelled without recreating (and killing) a live game.
 * Discovery must therefore recognize either generation; only newly-created
 * containers get stamped with just the new one.
 */

function fakeConfig(): AppConfig {
  return {
    dockerSocket: '/var/run/docker.sock',
    factorioImage: 'factoriotools/factorio:stable',
    factorioNetwork: 'factorio-net',
  } as unknown as AppConfig;
}

/** Swaps in a minimal stand-in for the dockerode client the service normally owns. */
function withFakeDocker(service: DockerService, fake: Record<string, unknown>): void {
  (service as unknown as { docker: unknown }).docker = fake;
}

test('stopAllManaged filters containers by either the new or legacy managed label', async () => {
  const service = new DockerService(fakeConfig());
  let capturedFilters: unknown;
  withFakeDocker(service, {
    listContainers: async (opts: { filters?: unknown }) => {
      capturedFilters = opts?.filters;
      return [];
    },
  });

  await service.stopAllManaged();

  assert.deepEqual(capturedFilters, {
    label: [`${MANAGED_LABEL}=true`, `${LEGACY_MANAGED_LABEL}=true`],
  });
});

test('runningServerIds reads the server id from either label generation', async () => {
  const service = new DockerService(fakeConfig());
  withFakeDocker(service, {
    listContainers: async () => [
      { Labels: { [SERVER_ID_LABEL]: 'new-server' } },
      { Labels: { [LEGACY_SERVER_ID_LABEL]: 'legacy-server' } },
      { Labels: {} },
    ],
  });

  const ids = await service.runningServerIds();

  assert.deepEqual(ids.sort(), ['legacy-server', 'new-server']);
});

test("hostPortsInUse excludes the caller's own container under either label generation", async () => {
  const service = new DockerService(fakeConfig());
  withFakeDocker(service, {
    listContainers: async () => [
      { Labels: { [LEGACY_SERVER_ID_LABEL]: 'srv1' }, Ports: [{ PublicPort: 34197 }] },
      { Labels: { [SERVER_ID_LABEL]: 'srv2' }, Ports: [{ PublicPort: 34198 }] },
      { Labels: {}, Ports: [{ PublicPort: 9999 }] },
    ],
  });

  const ports = await service.hostPortsInUse('srv1');

  assert.deepEqual([...ports].sort((a, b) => a - b), [9999, 34198]);
});

test('newly created containers are stamped with only the new label generation', () => {
  assert.equal(MANAGED_LABEL, 'factorio-stack-manager.managed');
  assert.equal(SERVER_ID_LABEL, 'factorio-stack-manager.server-id');
  assert.equal(LEGACY_MANAGED_LABEL, 'factorio-manager.managed');
  assert.equal(LEGACY_SERVER_ID_LABEL, 'factorio-manager.server-id');
});

test('status reports the running container image Factorio version and caches the image lookup', async () => {
  const service = new DockerService(fakeConfig());
  let imageInspects = 0;
  withFakeDocker(service, {
    getContainer: () => ({
      inspect: async () => ({
        Image: 'sha256:running-image',
        State: { Running: true, StartedAt: '2026-08-05T00:00:00Z', Status: 'running', ExitCode: 0 },
        RestartCount: 0,
      }),
    }),
    getImage: () => ({
      inspect: async () => {
        imageInspects += 1;
        return { Config: { Labels: { 'factorio.version': '2.0.99' } } };
      },
    }),
  });

  assert.equal((await service.status('server-1')).factorioVersion, '2.0.99');
  assert.equal((await service.status('server-1')).factorioVersion, '2.0.99');
  assert.equal(imageInspects, 1);
});

test('status does not claim a running Factorio version for a stopped container', async () => {
  const service = new DockerService(fakeConfig());
  let imageInspects = 0;
  withFakeDocker(service, {
    getContainer: () => ({
      inspect: async () => ({
        Image: 'sha256:stopped-image',
        State: { Running: false, StartedAt: '', Status: 'exited', ExitCode: 0 },
        RestartCount: 0,
      }),
    }),
    getImage: () => ({ inspect: async () => (imageInspects += 1) }),
  });

  assert.equal((await service.status('server-1')).factorioVersion, undefined);
  assert.equal(imageInspects, 0);
});

test('envFor sets DLC_SPACE_AGE for Space Age variants only', () => {
  const service = new DockerService(fakeConfig());

  const envFor = (mode: string) =>
    (service as unknown as {
      envFor: (server: {
        game_mode: string;
        save_name: string;
        generate_new_save: number;
        game_port: number;
        rcon_password: string;
      }) => string[];
    }).envFor({
      game_mode: mode,
      save_name: 'save.zip',
      generate_new_save: 0,
      game_port: 34197,
      rcon_password: 'pw',
    });

  for (const mode of ['space_age', 'space_age_no_quality', 'modded_space_age']) {
    assert.ok(envFor(mode).includes('DLC_SPACE_AGE=true'));
  }

  for (const mode of ['vanilla', 'modded', 'modded_vanilla']) {
    assert.ok(envFor(mode).includes('DLC_SPACE_AGE=false'));
  }
});
