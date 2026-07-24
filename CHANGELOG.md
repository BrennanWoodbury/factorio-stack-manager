# Changelog

Notable changes per release. This file is the source for the GitHub Release body and
for the Unraid template's `<Changes>` block, so keep entries written for users rather
than for the commit log.

Versioning is [semantic](https://semver.org/): the **major** covers anything a user has
to act on — a renamed environment variable, a changed data-dir layout, a template field
they must re-enter, or a migration that can't be undone. Those get a documented upgrade
path in the release notes and are never shipped in a minor or patch.

## [Unreleased]

## [1.0.0] - 2026-07-24

First tagged release. Everything before this shipped continuously from `main`; from
here on, `latest` only moves when a version is tagged.

### Added

- Create-server wizard with drafts that survive a restart, a pre-flight **Test &
  Create** boot probe, and three sources: generate a map, import an exchange string,
  or load an existing save.
- **Load from save** reads the save's own header, so the exact Factorio version and
  mod list (pinned to the versions the world was built with) are known before any
  container starts.
- Live container log viewer and RCON console, saves, scheduled and manual backups,
  mods, shared modpacks, map-gen templates, whitelists and admin lists.
- Map generation with per-planet previews for Space Age.
- Optional per-subdomain routing via Cloudflare DNS SRV records with a DDNS job.
- Unraid support: single container, Community Applications template, and automatic
  Docker network and host-path setup.
- The running version is shown on the dashboard and returned by
  `GET /api/system/status`.
- Unraid support reports use a structured GitHub issue form and an `unraid` label,
  keeping installation help and application development in one repository.

### Changed

- Bundled expansion mods and game-mode enablement are derived from the Factorio
  image's own dependency graph rather than a hardcoded list, so Factorio 2.1's
  `recycler` is handled without a code change and impossible mode/version
  combinations are refused with an explanation.

### Release process

- Versions come from `.version` (the human-controlled MAJOR.MINOR line) plus the
  existing git tags (the derived patch), and a CI impact check refuses a change that
  moves a user-facing surface without a matching version bump.
- Release files are prepared on a branch and reviewed through the normal pull-request
  protections before the merged `main` commit is tagged; releases need no admin bypass.
- Changes to the curated `DOCKERHUB.md` on `main` automatically update the Docker Hub overview.

### Safety

- The database is snapshotted to `db-backups/` before any migration runs.
- Migrations declare whether an older build can still read the database afterwards, so
  rolling back across the additive ones — nearly all of them — just works. The manager
  refuses to start only when a release made a genuinely one-way change.

[Unreleased]: https://github.com/BrennanWoodbury/factorio-tools-manager/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BrennanWoodbury/factorio-tools-manager/releases/tag/v1.0.0
