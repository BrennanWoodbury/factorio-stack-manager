# Factorio Stack Manager

Run and manage **multiple Factorio dedicated servers** on one Docker host from a
single web interface. Each game server runs as its own sibling container, so it
can keep running while the manager is restarted or upgraded.

The manager includes:

- A create-server wizard for new maps, map exchange strings, and existing saves
- Start, stop, restart, delete, live container logs, RCON console, and player lists
- Save upload/download, scheduled backups, restore, and retention policies
- Mod Portal integration, reusable modpacks, and per-server Factorio versions
- Map-generation controls, reusable templates, and per-planet previews
- Global and per-server settings, whitelists, and administrator lists
- Optional Cloudflare DNS SRV records and DDNS for per-server hostnames
- Automatic database snapshots before migrations

[Source and full documentation](https://github.com/BrennanWoodbury/factorio-stack-manager) ·
[Upgrade and rollback guide](https://github.com/BrennanWoodbury/factorio-stack-manager/blob/main/UPGRADING.md) ·
[Changelog](https://github.com/BrennanWoodbury/factorio-stack-manager/blob/main/CHANGELOG.md) ·
[Issues and support](https://github.com/BrennanWoodbury/factorio-stack-manager/issues)

## Quick start with Docker Compose

Create `compose.yml`:

```yaml
services:
  manager:
    image: brennanwoodbury/factorio-stack-manager:latest
    container_name: factorio-stack-manager
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      ADMIN_PASSWORD: change-this-password
      DATA_DIR: /data
      GAME_PORT_RANGE: 34197-34297
      RCON_PORT_RANGE: 27015-27115
      FACTORIO_IMAGE: factoriotools/factorio:stable
      FACTORIO_NETWORK: factorio-net
      RCON_MODE: network
      PUID: 845
      PGID: 845
      RESUME_SERVERS_ON_STARTUP: "true"
      STOP_SERVERS_ON_SHUTDOWN: "false"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/factorio-tools-manager:/data
    networks:
      - factorio-net

networks:
  factorio-net:
    name: factorio-net
    driver: bridge
```

Then start it:

```console
docker compose up -d
```

Open `http://<docker-host>:8080` and sign in with `ADMIN_PASSWORD`.

The manager creates Factorio servers through the mounted Docker socket. Those
servers are not declared in this Compose file and will appear as separate
containers on the host.

## Before creating an internet-accessible server

Forward one contiguous **UDP** range from your router to the Docker host, using
the same external and internal ports. The default is `34197-34297`, matching
`GAME_PORT_RANGE` above. Do not remap the ports and do not forward the RCON range.

The manager allocates one game port per server from this pool. RCON uses its own
range, is published only on host loopback, and is used internally by the manager.

Cloudflare DNS is optional. Without it, players connect using `IP:port`. With it,
configure the zone and API token from the manager's Settings page; the manager
creates DNS SRV records so players can use names such as
`factory1.example.com` without typing a port.

## Unraid

An Unraid Community Applications template is maintained with the project. Until
the app is listed in Community Applications, use the raw template URL:

```text
https://raw.githubusercontent.com/BrennanWoodbury/factorio-stack-manager/main/templates/factorio-stack-manager.xml
```

In Unraid, set **Admin Password** and make **Game Port Range** match the UDP range
forwarded on your router. The remaining fields have usable defaults.

For Unraid-specific help, open the
[Unraid support form](https://github.com/BrennanWoodbury/factorio-stack-manager/issues/new?template=unraid-support.yml).
Reports are tracked in this project with the `unraid` label.

## Image tags

| Tag | Meaning |
| --- | --- |
| `latest` | Most recent tested release; used by the Unraid template |
| `1` | Most recent release in major version 1 |
| `1.0` | Most recent patch in the 1.0 release line |
| `1.0.0` | An immutable exact release |
| `edge` | Latest build from `main`; unsupported and not release-tested |
| `main-<sha>` | A specific development build |

For a stable installation, use `latest` or a numbered release tag. Read the
[upgrade guide](https://github.com/BrennanWoodbury/factorio-stack-manager/blob/main/UPGRADING.md)
before changing major versions. To roll back, select the exact version tag you
want and recreate the manager container.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | — | Password for the web interface |
| `DATA_DIR` | No | `/app/data` in the image | Persistent manager database and server data |
| `HOST_SERVERS_DIR` | No | Auto-detected | Override the host-side source behind `DATA_DIR` only if mount detection cannot resolve it |
| `JWT_SECRET` | No | Derived | Secret used to sign login sessions; changing it logs everyone out |
| `GAME_PORT_RANGE` | No | `34197-34297` | UDP game ports previously forwarded on the router |
| `RCON_PORT_RANGE` | No | `27015-27115` | Host-loopback TCP ports used for server administration |
| `FACTORIO_IMAGE` | No | `factoriotools/factorio:stable` | Base image repository and default tag for game servers |
| `FACTORIO_NETWORK` | No | `factorio-net` | Docker network shared by the manager and game servers |
| `RCON_MODE` | No | `network` in containers | How the manager reaches game-server RCON |
| `PUID` / `PGID` | No | `845` | UID and GID used by Factorio server containers |
| `RESUME_SERVERS_ON_STARTUP` | No | `true` | Resume servers that were running before manager shutdown |
| `STOP_SERVERS_ON_SHUTDOWN` | No | `false` | Stop game servers when the manager stops |
| `SKIP_DB_BACKUP` | No | `false` | Skip the automatic pre-migration snapshot; not recommended |

DNS, DDNS, the Factorio.com account, server defaults, and other application
settings are configured in the web interface rather than environment variables.

## Persistent data

Back up the host directory mounted at `DATA_DIR`. It contains the SQLite database
and each server's saves, mods, configuration, and backups. The manager takes a
database snapshot before applying migrations unless `SKIP_DB_BACKUP=true`.

The example maps `/opt/factorio-tools-manager` on the host to `/data` in the
container. The manager inspects its own mount information to give sibling
Factorio containers the correct host path.

## Security

Mounting `/var/run/docker.sock` gives the manager effective control of the Docker
host. Treat access to the manager web interface as host-level access:

- Always set a strong `ADMIN_PASSWORD`.
- Do not publish the interface directly to the internet.
- Use a trusted TLS reverse proxy if remote browser access is required.
- Keep RCON ports private; never forward `RCON_PORT_RANGE` on your router.
- Back up `DATA_DIR` before manual recovery or downgrade work.

## License

[MIT](https://github.com/BrennanWoodbury/factorio-stack-manager/blob/main/LICENSE)
