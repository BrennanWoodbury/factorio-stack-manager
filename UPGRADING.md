# Upgrading, rolling back, and what counts as a breaking change

## How releases reach you

Releases are cut deliberately, by tagging. Merging to `main` does **not** reach users:

| Tag on Docker Hub | Moves when | Use it if |
| --- | --- | --- |
| `latest` | a version is released | you want releases as they land (the Unraid template tracks this) |
| `1`, `1.4` | a release in that line | you want fixes but not the next major/minor |
| `1.4.2` | never | you want an exact, reproducible build |
| `edge` | every push to `main` | you're testing unreleased work and accept breakage |

`edge` is not supported for real servers. It has had no release testing and may contain
migrations that are still being iterated on.

## Upgrading

Pull the new image and recreate the container — on Unraid, that's the normal update
button. Your Factorio servers keep running while the manager restarts; they aren't
touched unless `STOP_SERVERS_ON_SHUTDOWN=true`.

**The database migrates itself on first start, and snapshots itself first.** Before
applying any migration, the manager writes a consistent copy to
`<data>/db-backups/manager-v<schema>-<timestamp>.db` and keeps the five most recent. If
the snapshot can't be written it refuses to migrate rather than proceeding unprotected
(override with `SKIP_DB_BACKUP=true`, accepting that the upgrade won't be reversible).

Read the [release notes](CHANGELOG.md) before a **major** version. Those are the only
releases allowed to require anything of you, and the steps will be written there.

## Rolling back

Set the image tag to the version you want — on Unraid, edit the container's Repository
field to e.g. `brennanwoodbury/factorio-manager:1.4.2` and apply.

**Most rollbacks need nothing extra.** Migrations record whether they can be read
backwards. Almost all of them are additive — they add a column an older build simply
ignores — so an older image starts normally on a newer database and says so:

```
database is at schema v18, newer than this build's v14, but every change since is
backward compatible — continuing.
```

**Only a one-way migration blocks it**, and then the manager refuses to start rather
than operating on a schema it can't read:

```
This database is at schema v18 and requires a build that understands at least v17;
this one only understands up to v14. A release newer than this one made a change that
cannot be read backwards.
```

Releases containing one are called out in the notes, because they're the ones where
rolling back costs you something. To go back from one:

1. Stop the manager.
2. In `<data>/db-backups/`, find the newest snapshot whose `v<number>` is one the older
   build understands, and copy it over `<data>/manager.db`.
3. Remove the stale `manager.db-wal` and `manager.db-shm` files if present.
4. Start the older image.

Anything recorded after the upgrade is not in that snapshot. Servers, saves, mods and
backups all live on disk rather than in the database, so they survive regardless — it's
the manager's own records (server list, settings, modpacks, templates) that revert.

## What counts as a breaking change

These are treated as a public contract. Changing any of them incompatibly requires a
**major** version and a documented path in the release notes:

- **Environment variable names and meanings** — the Unraid template and everyone's
  compose file are written against them. Renamed variables keep the old name working
  for at least one major, with a startup warning.
- **The Unraid template's `Config` targets** — an existing install's settings are keyed
  by these; changing one silently drops a user's value.
- **The data directory layout** — `manager.db`, `servers/<id>/{saves,mods,config}`.
- **Default ports and port-range behaviour** — people have forwarded these on a router.
- **Anything requiring manual action after an update.**

Most of that list is checked mechanically on every pull request rather than left to
memory — see the impact check in the [README](README.md#the-impact-check). A change that
trips it can't merge until `.version` is bumped to match.

Deliberately *not* covered: the HTTP API. The SPA ships in the same image as the backend
it talks to, so the two are always in step and the API is internal.

Migrations are additive wherever possible, and each one declares whether an older build
can still read the database afterwards (`backwardCompatible`). Additive ones are a minor
at most — they cost a user nothing, including the ability to roll back. A migration that
renames, removes or rewrites what an older build reads is a major on its own, is flagged
by the impact check, and the release notes say so explicitly.
