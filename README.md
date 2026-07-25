# Factorio Multi-Server Manager

Self-hosted web app to run **many Factorio dedicated servers on one home host** behind a
consumer NAT router. Each server is reachable by players at its own subdomain
(`factory1.mydomain.com`) with **no port number to type** and **no reverse proxy** — the
routing is done entirely by DNS **SRV records**.

- Backend: Node.js + TypeScript (Express, `dockerode`, `node:sqlite`, `rcon-client`)
- Frontend: React + TypeScript (Vite)
- DNS/DDNS: Cloudflare REST API
- Runs as a single container that manages sibling Factorio containers via the Docker socket.

Already running it? [UPGRADING.md](UPGRADING.md) covers which image tag to track, how to roll
back, and what will and won't change under you. Published changes are listed in
[GitHub Releases](https://github.com/BrennanWoodbury/factorio-tools-manager/releases), with
[CHANGELOG.md](CHANGELOG.md) retained for optional curated history.
Project stewardship and review requirements are documented in [MAINTAINERS.md](MAINTAINERS.md).

---

## How the networking works (read this first)

Factorio's client (v1.1.67+) resolves connections via DNS SRV records. When a player enters
`factory1.mydomain.com`, the client looks up:

```
_factorio._udp.factory1.mydomain.com   SRV   0 0 <gamePort>   host.mydomain.com
```

and connects to `host.mydomain.com:<gamePort>` over UDP. So:

1. **One SRV record per server**, created/updated/removed automatically by this app. Its
   `target` is always the single stable hostname `host.mydomain.com` (SRV targets must be a
   hostname, never an IP or CNAME), and its `port` is that server's unique game port.
2. **One shared A record** `host.mydomain.com` points at your current public IP. Because your
   home IP is dynamic, a background **DDNS job** keeps that one A record in sync. Every server's
   SRV points at it, so a single update follows the WAN IP for all servers at once.
3. **Ports are 1:1, never translated — all the way to the container.** You forward a contiguous
   UDP range **once, by hand** on your router to this host. The app only ever allocates game ports
   from inside that range, advertises exactly that port in the SRV record, publishes it on the same
   host port, and binds Factorio *inside* the container to that same port (via the image's `PORT`
   → `--port`). So `external port == host port == container port == SRV port`, with no rewriting at
   any hop. That end-to-end match is what keeps Factorio's public server listing / NAT
   punch-through pointed at the port players can actually reach.

**RCON** (server admin protocol) is treated completely separately: allocated from its own range,
published only on host loopback (`127.0.0.1`) and reached by the backend over the internal Docker
network. It is **never forwarded and never appears in DNS**.

> Players on Factorio clients older than 1.1.67 don't do SRV lookups and would have to enter
> `host.mydomain.com:<port>` manually. That's an inherent limitation of the SRV approach.

---

## One-time setup

### 1. Forward a UDP port range on your router (manual, once)

In your router's NAT / port-forwarding settings, forward a **contiguous UDP range** to this
host's LAN IP, using the **same** external and internal ports:

| Setting        | Value                                            |
| -------------- | ------------------------------------------------ |
| Protocol       | **UDP**                                           |
| External ports | `34197-34297` (or whatever you set `GAME_PORT_RANGE` to) |
| Internal IP    | your host's LAN IP (e.g. `192.168.1.50`)         |
| Internal ports | `34197-34297` (same range — do **not** remap)    |

Do **not** forward the RCON range. The app never allocates a game port outside this range, so any
server it creates is guaranteed reachable.

### 2. Cloudflare DNS (optional — configured in the dashboard, not env)

Skip this to run without DNS (players connect by `IP:port`). To enable automatic SRV + DDNS,
open the dashboard → **DNS / Cloudflare settings** and enter your server domain, Zone ID and API
token. The server domain may be the selected zone (`example.com`) or a namespace beneath it
(`games.example.com`). The shared DDNS target is generated as
`factorio-tools-manager.<server-domain>`; each instance remains reachable at
`<instance>.<server-domain>`. **Test configuration** validates the unsaved values, resolves the
read-only zone name from the Zone ID, and checks for a conflicting CNAME without changing DNS;
**Save & enable DNS** then stores them in the app database and takes effect immediately — no restart,
nothing in `.env`. To get the values:

1. Your domain's DNS must be managed by Cloudflare.
2. Create an API token at **Cloudflare → My Profile → API Tokens → Create Token → Custom token**
   with **Permissions:** `Zone` → `DNS` → `Edit`, **Zone Resources:** `Include` → `Specific zone`
   → *your domain*.
3. Find your **Zone ID** in the API section of the domain's Cloudflare overview page; do not use the
   Account ID. See [Cloudflare's current instructions](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

The app creates DNS-only (unproxied) records — it never enables the orange-cloud proxy, which
can't carry Factorio's UDP protocol. Enabling or changing DNS reconciles the shared A record and
every active server's SRV record before the new settings become authoritative. Reconciliation also
runs at startup, and **Sync DNS now** in the settings page reports each repaired record or error.

### 3. Configure and launch

```bash
cp .env.example .env
# edit .env — at minimum set ADMIN_PASSWORD (that's the only required var)
docker compose up -d --build
```

Open `http://<host>:8080` and log in with `ADMIN_PASSWORD`.

### 4. Or on Unraid

The published image is a **single container** — API and web UI in one — so it installs
like any other Unraid app. A template lives at
[`templates/factorio-tools-manager.xml`](templates/factorio-tools-manager.xml).

Until it's listed in Community Applications, install it by hand: **Docker → Add Container →
Template → paste the raw template URL**, or drop the XML into
`/boot/config/plugins/dockerMan/templates-user/` and pick it from the template dropdown.

Only two things need setting: **Admin Password**, and the **Game Port Range** if you didn't
use the default — it has to match the UDP range you forwarded in step 1. Everything else has
a working default.

Two things make this work without any manual wiring on Unraid, and are worth knowing about
because they're what a plain `bridge` install would otherwise get wrong:

- **The manager attaches itself to `factorio-net` at startup.** It has to be on that network
  to reach each server's RCON, but the network doesn't exist until the manager first runs, so
  it can't be selected at install time. Getting this wrong fails *quietly* — servers run and
  play fine while the console and player list report `ENOTFOUND`.
- **The host path behind the data mount is detected from the manager's own mount table.** The
  Factorio containers are siblings on the host daemon, so their bind mounts have to be host
  paths. That means the appdata mount can be an ordinary `/mnt/user/appdata/… → /data`, with no
  identity mount and no `HOST_SERVERS_DIR` to keep in sync.

The Factorio servers it creates appear in Unraid's Docker tab without templates of their own —
that's expected; manage them from this app. They also survive a manager update, and are left
running if you remove the manager (`STOP_SERVERS_ON_SHUTDOWN` changes that).

For Unraid-specific installation or runtime help, use the
[Unraid support form](https://github.com/BrennanWoodbury/factorio-tools-manager/issues/new?template=unraid-support.yml).
It applies the `unraid` label automatically so reports remain searchable in this repository.

> **Data location.** Persistent data (SQLite DB + per-server saves/mods/config) is stored at
> `/opt/factorio-tools-manager`. Override with `FTM_DATA_DIR` (e.g.
> `FTM_DATA_DIR=$HOME/.factorio-tools-manager`).
>
> The compose file bind-mounts it at the *same* path inside and outside the container. That's
> tidy but no longer required: the manager reads its own mount table at startup to learn the
> host path behind its data dir, so any mapping works and `HOST_SERVERS_DIR` only exists as an
> override. That matters because the Factorio containers are siblings on the host daemon — their
> bind mounts must be expressed in host paths, and guessing wrong yields a server that starts
> with none of its saves.

---

## Environment variables

| Variable                | Required | Default                        | Meaning |
| ----------------------- | -------- | ------------------------------ | ------- |
| `ADMIN_PASSWORD`        | ✅       | —                              | Web UI login password |
| `WEB_PORT`              |          | `8080` (prod) / `5173` (dev)   | Host port for the web UI; `API_PORT` (dev only) for the backend |
| `JWT_SECRET`            |          | derived                        | Signs session cookies; set your own (`openssl rand -hex 32`) |
| `FTM_DATA_DIR`          |          | `/opt/factorio-tools-manager`  | Data location; identity-mounted host↔container (prod compose) |
| `DATA_DIR`              |          | `FTM_DATA_DIR`                 | In-container data path (host-mode dev defaults to `../data`) |
| `HOST_SERVERS_DIR`      |          | autodetected                   | Host bind-mount source; detected from the manager's own mounts, only set it to override |
| `GAME_PORT_RANGE`       |          | `34197-34297`                  | Pre-forwarded UDP game-port pool |
| `RCON_PORT_RANGE`       |          | `27015-27115`                  | Loopback-only RCON port pool |
| `FACTORIO_IMAGE`        |          | `factoriotools/factorio:stable`| Base game server image; per-server tag overrides just the tag |
| `FACTORIO_NETWORK`      |          | `factorio-net`                 | Shared Docker network for manager↔RCON |
| `RCON_MODE`             |          | `network`                      | `network` (containerized) or `loopback` (local dev) |
| `PUID` / `PGID`         |          | `845`                          | UID/GID the Factorio image runs as |
| `STOP_SERVERS_ON_SHUTDOWN` |       | `false`                        | Stop all Factorio containers when the manager shuts down |
| `RESUME_SERVERS_ON_STARTUP` |      | `true`                         | On startup, resume servers that were running |
| `SKIP_DB_BACKUP`        |          | `false`                        | Migrate without snapshotting the DB first (makes the upgrade one-way) |
| `APP_VERSION`           |          | `dev`                          | Build identity; stamped by CI, shown on the dashboard |

> **DNS / Cloudflare is not configured via env** — set the server domain, Zone ID, API token, DDNS
> interval and IP-check URL in the dashboard (**DNS / Cloudflare settings**). The host record is
> derived automatically; settings are stored in the database.

---

## Using it

- **Create a server (wizard):** a multi-step flow that starts from one of three sources —
  **generate a new map**, **import a map exchange string**, or **load an existing save**. Progress is
  kept server-side as a **draft**: a real server row in `lifecycle='draft'` with its ports already
  reserved, so a half-finished server can never collide with a real one and never shows up on the
  dashboard. Drafts are listed under "Continue new server", survive a restart, and are pruned
  automatically after they expire. Only **finalize** promotes the row to `lifecycle='active'`,
  allocating the subdomain and creating the SRV record. The mods step can **apply a saved modpack**
  as well as search the portal, so a templated mod set can be chosen up front rather than rebuilt
  by hand — the pack downloads into the draft, so **Test & Create** boots the real mod set.
- **Test & Create:** before finalizing, the wizard can boot the server once in a throwaway
  container and stream the result live (SSE). It reports the actual failure — bad mod, unloadable
  map-gen settings, wrong game version — instead of leaving you to read a crash loop afterwards.
  Anything it creates is discarded; only the generated map is kept.
- **Load from save:** upload a `.zip` and the manager reads the save's own header (`level-init.dat`)
  directly — no container boot — to report the exact **Factorio version**, scenario and **full mod
  list with pinned versions**, shown as chips the moment the upload finishes. Bundled expansion mods
  are enabled from that list; mod-portal mods are downloaded **at the versions the world was built
  with**. If a required mod can't be fetched, creation fails loudly — which matters because Factorio
  itself does *not* error on a save with missing mods, it silently drops them and hosts a gutted
  world.
- **Container logs:** a live viewer for the container's stdout/stderr (separate from the RCON
  console), streamed over SSE with scrollback, follow-tail, error/warning highlighting, download,
  and automatic re-attach when the server restarts. Works on a stopped server too — you still see
  the last container's output.
- **Factorio.com account:** one global account (username + token), set on the Servers dashboard,
  used by **every** server for mod-portal downloads and the public server listing. There are no
  per-server credentials.
- **Settings page:** manager-wide configuration lives on a single **Settings** tab, split into
  "Shared across instances" (Factorio.com account, server defaults, global whitelist/adminlist,
  global advanced server settings) and "Manager config" (DNS / Cloudflare). The active subsection is
  mirrored to the URL hash (`#settings/<key>`) so it can be linked directly.
- **Server defaults (cascade):** the **Defaults** section sets global defaults for auto-restart and backup
  config. These **cascade**: saving pushes the new value to every server that hasn't overridden it;
  a server that overrode a setting keeps its own value until you click **"Reset to global default"**
  on that field. New servers start out inheriting everything. Also sets a default **modpack** and
  **world generation template** applied to new servers at creation (changeable in the wizard).
- **Lifecycle:** start / stop / restart / delete. Delete removes the container, DNS record,
  releases the ports and deletes the data dir.
- **Console:** live RCON console + player list (over loopback / Docker network only).
- **Saves:** upload a `.zip`, list, create a new named save on demand (offline, via a one-shot
  container), pick which to load next, **restore** (load a save now — selects it and (re)starts),
  download, delete.
- **Backups:** on-demand ("manual") snapshots (kept under the server's `backups/` dir) plus
  **scheduled automatic backups** per server (toggle + interval, default every 15 min). Manual and
  auto backups have **separate keep-newest-N retention** — one never evicts the other, and a manual
  backup doesn't reset the auto schedule. Backing up a running server forces a fresh save via RCON
  first. Each backup can be downloaded, restored ("Restore from here" — into a save; server stopped),
  or deleted from the UI.
- **Map generation:** the in-game map-generation sliders — resource frequency/size/richness (iron,
  copper, coal, stone, uranium, oil), water, trees, enemy bases, cliffs, starting-area size,
  peaceful mode and map seed — available **in the create-server wizard** and on a per-server **Map
  gen** tab. Written to `config/map-gen-settings.json` only when you customize it, and applied to the
  **next new map generated** (first start with no save, or a new save from the Saves tab); doesn't
  alter an existing world. `map-settings.json` (pollution/evolution/expansion) is left to the image's
  version-matched example — Factorio validates it strictly against the exact binary version, so a
  hand-written one isn't safe.
- **Game modes:** each server is **Vanilla**, **Space Age**, **Space Age — without Quality**, or
  **Modded** (chosen in the create wizard, editable on the Map gen tab). The mode drives which
  map-gen sliders show — Vanilla is Nauvis-only; the Space Age modes show curated **per-planet**
  resource sliders (Nauvis, Vulcanus, Gleba, Fulgora, Aquilo) — and sets which bundled expansion
  mods are enabled on next start. For **Modded** servers, a **Detect resources from mods** button
  runs the mod set once (`get_map_exchange_string` → parsed to JSON) to populate **dynamic sliders**
  for that modpack's actual resource controls.
- **Bundled mods are read from the image, not hardcoded:** which expansion mods a mode enables is
  derived from the **dependency graph in the image's own `info.json` files**, read once per image
  and cached. This is not incidental — it's the difference between working across Factorio releases
  and breaking on each one:

  | | `space-age` requires |
  | --- | --- |
  | **2.0.x** | `base`, `elevated-rails`, **`quality`** (hard) |
  | **2.1.x** | `base`, `elevated-rails`, **`recycler`**, and `+ quality` (optional) |

  So on 2.1 the new `recycler` mod is enabled automatically — nothing in this repo names it — while
  on 2.0 the manager knows "Space Age without Quality" is impossible (`quality` comes back through
  the closure) and **refuses it with an explanation** at start / Test & Create, rather than letting
  the container die on `Missing required dependency quality >= 2.0.0`. The wizard greys the mode out
  when the selected Factorio version can't run it. A future release that splits out another mod
  needs no code change here.
- **Map preview:** on the Map gen tab (and in the wizard), a **Preview map** button renders a PNG of
  your current (unsaved) settings via a throwaway Factorio one-shot (`--generate-map-preview`, using
  the server's mods) — click the thumbnail to expand it full-res, or reroll the seed. On Space Age
  modes you get a preview **per planet**, each rendered with that planet's own surface settings.

  > The modded map-gen paths (dynamic sliders, modded previews) are marked **Experimental** in the
  > UI: they depend on each modpack exposing sane map-gen controls, and are not guaranteed to work
  > with every mod set.
- **Map exchange strings:** paste a `>>>…<<<` string from Factorio's in-game map generator to
  **import** it — decoded to JSON by Factorio's own parser in a one-shot (needs the same version +
  mods), which populates the sliders and attaches version-correct map settings — or **export** the
  current settings as a shareable string on demand. An **Advanced** section edits the raw
  map-gen-settings JSON directly.
- **World Generation Templates:** save a map-gen configuration as a named, reusable **template**
  (e.g. "all ores at 300%") and pick it when creating a server. A template is just a JSON manifest +
  DB record — no server link — that's **exportable/importable** for sharing. Managed under the
  **World Generation** tab; a couple ("Rich resources", "Peaceful") are seeded by default. "Save as
  template" is available from any map-gen editor.
- **Server settings:** edit the full `server-settings.json` (visibility, game password, autosave,
  `allow_commands`, AFK kick, pause rules, non-blocking saving, …) via a structured form plus a
  raw-JSON escape hatch. Each field **inherits the global default** (set on the **Defaults** tab)
  until you change it; a changed field shows a **reset-to-global** button, and only the overridden
  fields are stored — so untouched fields keep tracking the global default.
- **Auto-restart on change:** an optional per-server toggle — when on, saving a change that only
  takes effect at start (version/tag, server settings, mods, whitelist) automatically restarts the
  server in the background if it's running (only when a value actually changed); otherwise changes
  apply on the next manual start.
- **Whitelist & admin list:** per-server *and* **global** player whitelists and admin lists. Each
  effective list (global ∪ per-server) is written to `server-whitelist.json` / `server-adminlist.json`
  on start; an empty whitelist leaves the server open. Applies on next start/restart.
- **Per-server Factorio version:** each server picks its version from a dropdown — **stable**,
  **latest (experimental)**, or **custom** (any image tag, e.g. `2.0.55`) — overriding just the tag
  of the configured base repo (`FACTORIO_IMAGE`). The image is **pulled on every start/restart** to
  pick up updates to moving tags; if the registry is unreachable it falls back to the local copy.
- **Mods:** search the Factorio Mod Portal by keyword and add mods with one click; upload a mod
  `.zip` manually; enable/disable; update all to latest; delete all; export a shareable manifest.
  With the global Factorio.com account set, enabled mods are downloaded on save. Changes apply on
  next start.
- **Modpacks (shared registry):** build named, reusable mod collections once and **apply them to
  any server** (packs are manifests only — no binaries or credentials; mods are downloaded with the
  global Factorio.com account). Create a pack from scratch, snapshot one from a server, or
  **import/export** a pack as a JSON manifest to share it. Editing a pack doesn't auto-change
  servers; re-apply is explicit ("re-apply to all N servers using this pack"). A built-in
  **"Space Age"** modpack (`space-age` / `quality` / `elevated-rails`) is seeded on first run;
  those official expansion mods ship with the game data (they need the Space Age DLC) and are
  never downloaded from the portal — the manager just enables them in `mod-list.json`.

### Mods: why the Mod Portal API (not `UPDATE_MODS_ON_START`)

The manager downloads mods directly via the [Factorio Mod Portal API] instead of relying on the
image's `UPDATE_MODS_ON_START`. This lets it **validate a mod name and surface download failures
in the UI before the container starts**, rather than discovering a bad mod from a crash loop in
container logs, and gives deterministic control over versions. Tradeoff: more code, and we handle
mod-portal auth ourselves. Automatic dependency resolution is out of MVP scope — enabling a mod
downloads that mod's latest release only.

[Factorio Mod Portal API]: https://wiki.factorio.com/Mod_portal_API

---

## Local development

### Option 1 — Dev stack in containers (hot reload)

The easiest path — nothing to install on the host:

```bash
docker compose -f docker-compose.dev.yml up   # run from the repo root
```

Both services run from bind-mounted source with live reload (backend via `tsx watch`,
frontend via Vite HMR). The first `up` runs `npm install` into named volumes (slow once,
fast after). The backend drives the host Docker daemon and joins `factorio-net`, so RCON
works over the Docker network — same wiring as production. Open **http://localhost:5173**
(default login `dev`). Run it from the repo root so the data dir resolves correctly.

### Option 2 — On the host (no containers)

```bash
# Backend (API on :8080). RCON_MODE=loopback so it reaches the published RCON ports.
# NB: the backend reads env vars directly — it does NOT load .env; pass them inline.
cd backend
npm install
ADMIN_PASSWORD=dev RCON_MODE=loopback DATA_DIR=$PWD/data npm run dev

# Frontend (Vite dev server on :5173, proxies /api → :8080)
cd frontend
npm install
npm run dev
```

> ⚠️ **Host mode breaks once a Factorio container has written to the data dir.** The Factorio image
> runs as `PUID`/`PGID` `845` and chowns the files it creates (config, saves, mods) to that uid. A
> backend running on the host as *you* then gets `EACCES` on those paths. This only affects Option 2
> — in the dev stack and in production the backend runs as root inside a container. Either use
> Option 1, or `sudo chown -R $USER` the data dir between runs.

Typecheck, test and build:

```bash
cd backend  && npm run typecheck && npm test   # node:test
cd frontend && npm run typecheck && npm test && npm run build   # vitest + jsdom
```

Frontend tests run components for real under jsdom — which has no `EventSource`, so the log
viewer's tests stub it and drive `ended` / `error` by hand. That makes reconnect behaviour
(including its backoff) deterministic and assertable without a network or a container.

### Releases

Reviewed changes release directly from their merge commit when they alter a shipped runtime
surface. Runtime changes create patch releases, additive database migrations create minor
releases, and breaking contracts require a manually reviewed one-step MAJOR increase. Changes
limited to documentation, tests, CI, and maintainer tooling publish no release.

```bash
# Read-only local preview of a committed branch:
git fetch origin main --tags
node scripts/version-policy.mjs --base origin/main
```

`.github/workflows/release.yml` is the serialized main-merge coordinator. After acquiring its
repository-wide lock it re-fetches tags, recalculates the version, verifies the merged pull
request still has a current non-author maintainer approval, and reruns backend tests, frontend
tests/build, and Unraid template validation. Only then does it create an annotated tag on the
exact merge SHA and publish `1.2.3` / `1.2` / `1` / `latest`, stamping `APP_VERSION=1.2.3` into
the image. GitHub generates the Release notes from pull requests merged since the prior tag.

The coordinator is idempotent. A manual workflow dispatch can reconcile a run interrupted after
tagging. If a newer release already exists, reconciliation publishes only the older immutable
version alias and GitHub Release; it never moves `latest`, major, or minor aliases backward. If
invalid policy somehow reaches `main`, the workflow emits a prominent summary and stops before
creating a tag, Docker image, or GitHub Release.

Every push to `main` may still publish `edge` and `main-<short-sha>` for testing. `latest` — which
the Unraid template tracks — moves only after a calculated release passes the coordinator.

#### Where the version number comes from

`.version` holds only the manually controlled major:

```
MAJOR=1
```

The MAJOR may remain unchanged or increase by exactly one. Decreases and skipped values fail CI.
A bump is reviewed in the pull request that made it necessary, so `MAJOR=2` and its documented
upgrade path land in the same diff where a reviewer sees them together.

Minor and patch are derived from the latest reachable valid `vMAJOR.MINOR.PATCH` tag and the
detected change. A runtime change after `v1.0.0` becomes `v1.0.1`; an additive migration after
`v1.0.7` becomes `v1.1.0`; the next runtime change becomes `v1.1.1`; and a manual `MAJOR=2`
becomes `v2.0.0`. Malformed tags are ignored and versions compare numerically.

Tags are the authoritative shipping record, so CI never commits version changes back to `main`.
The private package manifests remain at neutral `0.0.0`; the tag and Docker build's
`APP_VERSION` are what the application reports at runtime.

#### The version policy check

On every pull request, `scripts/version-policy.mjs` reports the detected release class, the files
and rules responsible, the predicted version, and any policy violation:

| Detected change | Release class |
| --- | --- |
| Manual one-step MAJOR increase | major, resetting minor and patch to zero |
| One-way migration (`backwardCompatible: false`) | major; rejected without the manual increase |
| Removed environment variable or Unraid `Config` target | major; rejected without the manual increase |
| Changed default game/RCON port range or moved data mount | major; rejected without the manual increase |
| Appended additive migration (`backwardCompatible: true`) | minor, resetting patch to zero |
| Runtime source, production assets, dependencies, Docker/Compose, or Unraid runtime config | patch |
| Documentation, tests, workflows, development Compose, or `scripts/` tooling alone | no release |

Schema changes must append the next numbered migration and explicitly declare
`backwardCompatible`. Editing an existing migration, changing schema without a migration, or
adding a one-way migration without the next MAJOR fails the check. Release-only package version
fields and the Unraid release-history link are normalized away so maintaining that metadata does
not create a false patch release.

See [UPGRADING.md](UPGRADING.md) for the tag policy, rollback procedure, and what counts
as a breaking change.

### Continuous integration

`.github/workflows/ci.yml` runs the backend (typecheck + `node:test`), frontend (typecheck +
Vitest + Vite build), Unraid/template validation, version policy, impact validation, and policy
unit tests. Branch rules also require the governance status and one current non-author maintainer
approval. The template check is not optional politeness: Community Applications serves
`templates/*.xml` and `ca_profile.xml` straight from `main`'s raw URLs, so a malformed template
is live the moment it merges. On pushes, CI additionally builds and publishes `edge` and
`main-<short-sha>`.

Image publishing is opt-in on ordinary `main` pushes: a fork without `DOCKERHUB_IMAGE` still gets
green checks. A calculated release is different: the coordinator fails before tagging if
`DOCKERHUB_IMAGE`, `DOCKERHUB_USERNAME`, or `DOCKERHUB_TOKEN` is missing, rather than silently
skipping the image and GitHub Release.

When `DOCKERHUB.md` changes on `main`, `.github/workflows/dockerhub-description.yml` publishes its
installation-focused documentation as the Docker Hub repository overview using that same image
variable and credentials. It stays below Docker Hub's 25 KB limit while linking back to this full
README. The action is pinned to an immutable commit so an upstream tag cannot silently change what
runs with the token. CI checks the size and rejects relative links that Docker Hub cannot resolve.

---

## Architecture / data model

```
frontend/  React SPA (built and served by the backend in production; vitest + jsdom tests)
backend/
  src/
    config.ts            env-driven config
    db/                  node:sqlite + schema + migrations + repos
    services/
      portAllocator.ts   atomic game/RCON port allocation (unit-tested)
      dockerService.ts   create/start/stop/remove Factorio containers + one-shot probes (dockerode)
      dnsService.ts      Cloudflare SRV records + shared host A record
      dnsSettings.ts     DNS config persisted in the DB (not env)
      rconService.ts     pooled RCON connections (loopback / docker network)
      serverFiles.ts     per-server data dir, saves, server-settings.json, mod-list.json
      saveInspect.ts     read a save's version + mod list straight from its header (no boot)
      imageProfile.ts    bundled mods + dependency graph read from the Factorio image (cached)
      modService.ts      Mod Portal API downloads
      modpackService.ts  shared modpack registry (+ seeded "Space Age" pack)
      mapGenTemplateService.ts  reusable map-gen templates
      globalDefaults.ts  cascading global defaults
      factorioAccount.ts the single global Factorio.com account
      serverManager.ts   lifecycle + wizard/draft orchestration (ties it all together)
    jobs/
      ddns.ts            periodic public-IP → A-record sync
      backup.ts          per-server scheduled automatic backups
      draftPrune.ts      expire abandoned wizard drafts (releases their ports)
    routes/              REST API (auth, servers, global, mods, modpacks, mapgen-templates, system)
  test/                  node:test — port allocator, drafts, save headers, image profiles
```

**SQLite tables:** `servers` (identity/config, including the `lifecycle` draft/active column and
`draft_state_json`), `port_allocations` (atomic port registry, PK `(kind, port)` makes
double-allocation impossible), `dns_records` (Cloudflare record bookkeeping for reconcile/cleanup),
`modpacks` / `modpack_mods`, `map_gen_templates`, `kv` (singletons like last public IP / host
A-record id). Schema changes ship as numbered migrations applied on boot.

### Draft lifecycle

Every server row carries a `lifecycle` of `draft` or `active`. A wizard run creates the row up
front as a `draft` — with real ports reserved and a placeholder subdomain (`__draft_<id>`) — and
stores wizard progress in `draft_state_json`. The repository's `list()` filters on
`lifecycle='active'`, which is the single choke-point keeping drafts off the dashboard and out of
DNS. Finalizing flips the row to `active` and assigns the real subdomain; abandoning it (or the
prune job) deletes the row and releases its ports.

### REST API (all under `/api`, session-cookie auth except `/auth/*`)

| Method | Path | |
| --- | --- | --- |
| POST | `/auth/login` `/auth/logout` · GET `/auth/me` | auth |
| GET | `/system/status` | docker/dns/ddns health + port capacity |
| GET | `/system/factorio-image?tag=` | what an image supports: version, bundled mods, unavailable game modes |
| GET/POST | `/servers` | list (active only) / create directly |
| GET/POST | `/servers/draft` | list in-progress drafts / start a new one |
| GET/PATCH/DELETE | `/servers/draft/:id` | draft state (resume) / patch wizard state / abandon |
| POST | `/servers/draft/:id/save` | upload a save; returns its version + mods from the header |
| GET | `/servers/draft/:id/test-create` | **SSE** — boot once and stream the result (Test & Create) |
| POST | `/servers/draft/:id/finalize` | promote draft → active (allocates subdomain + SRV) |
| GET/PATCH/DELETE | `/servers/:id` | detail / update / delete |
| POST | `/servers/:id/{start,stop,restart}` | lifecycle |
| GET | `/servers/:id/status` | live state + players |
| GET | `/servers/:id/logs` | container logs (one shot) |
| GET | `/servers/:id/logs/stream` | **SSE** — live container log stream (scrollback + follow) |
| GET/PUT | `/servers/:id/settings` · POST `/settings/reset` | full server-settings.json body / reset a field to global |
| GET/PUT | `/servers/:id/mapgen` | this server's map-gen-settings (new-map generation) |
| POST | `/servers/:id/mapgen/{import,export,baseline,preview}` | exchange-string import/export · mod-detected sliders · render a preview PNG |
| GET/POST/PATCH/DELETE | `/mapgen-templates[...]` | map-gen template registry (list/create/edit/delete) |
| POST/GET | `/mapgen-templates/{import,from-server}` · `/:id/export` | import / snapshot / export a template |
| GET/PUT | `/servers/:id/{whitelist,adminlist}` · `/global/{whitelist,adminlist}` | per-server / global whitelist + admin list |
| GET/PUT | `/global/factorio` | the global Factorio.com account (mods + public listing) |
| GET/PUT | `/global/defaults` · `/global/advanced-settings` | cascading server defaults / global server-settings defaults |
| GET/PUT | `/global/dns` · POST `/global/dns/test` | Cloudflare settings / test connection |
| GET/POST/DELETE | `/servers/:id/saves[...]` | list / upload / create / select / restore / download / delete |
| GET/POST/DELETE | `/servers/:id/backups[...]` | list / create / download / restore / delete |
| GET/PUT | `/servers/:id/mods` | get / apply mod list |
| POST | `/servers/:id/mods/{upload,update,deleteAll}` · GET `/mods/export` | mod ops |
| GET | `/mods/search?q=` | search the mod portal catalog |
| GET/POST | `/modpacks` · `/modpacks/import` · `/modpacks/from-server` | list / create / import / snapshot |
| GET/PATCH/DELETE | `/modpacks/:id` | detail / update / delete |
| PUT/POST/GET | `/modpacks/:id/{mods,apply,apply-all,export}` | edit / apply / re-apply / export |
| POST | `/servers/:id/rcon` | run an RCON command |

---

## Error handling

Realistic failure modes return structured JSON errors (`{ error: { code, message } }`):

- **Port pool exhausted** → `409 PORT_POOL_EXHAUSTED`
- **Duplicate subdomain** → `409 DUPLICATE_SUBDOMAIN`
- **Cloudflare API failure** → `502 CLOUDFLARE_ERROR` (server creation is rolled back so no ports
  are left claimed for an unreachable server)
- **Docker daemon unreachable** → `502 DOCKER_ERROR`
- **Container fails to start / bad mod** → surfaced live by **Test & Create** in the wizard, and via
  the container **logs** endpoint / live log stream afterwards; mod download errors are reported
  per-mod when applying a mod list
- **Game mode impossible on the chosen Factorio version** → `400 VALIDATION` naming the conflict,
  raised before any container starts (see bundled mods above)
- **Save needs a mod we can't fetch** → creation fails with the mod named, *before* any container
  starts. This is deliberate: Factorio does not error on a save whose mods are missing — it drops
  them and hosts the world anyway — so the check has to happen from the save header, not the log
- **Validation** (bad subdomain label, save name, etc.) → `400 VALIDATION`

---

## Security notes

- The UI can start/stop/delete infrastructure — it's gated by a single admin login. Put it behind
  TLS (reverse proxy) and set `FORCE_SECURE_COOKIE=true` for production.
- RCON is never exposed off-host.
- The Docker socket is mounted into the manager (root-equivalent on the host) — treat access to
  the UI accordingly.

---

## License

[MIT](LICENSE).

Factorio itself, the Space Age expansion and the official expansion mods are not covered by
this licence — they're Wube Software's, require your own copy of the game, and are used here
through the [factoriotools](https://hub.docker.com/r/factoriotools/factorio) image. Nothing in
this project redistributes game assets.
