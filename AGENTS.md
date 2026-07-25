# Agent guide

Use [README.md](README.md) as the authoritative project guide. In particular, read the sections
that match the work you are doing instead of duplicating their contents here:

- [Local development](README.md#local-development) for development environments and validation
  commands.
- [Releases](README.md#releases) for version classification, migration requirements, and the
  read-only version-policy preview.
- [Continuous integration](README.md#continuous-integration) for required checks and publishing
  behavior.
- [Architecture / data model](README.md#architecture--data-model) and the documented REST API for
  application structure and contracts.
- [Security notes](README.md#security-notes) before changing authentication, secrets, containers,
  networking, or filesystem access.

Approval and repository-governance rules live in [MAINTAINERS.md](MAINTAINERS.md). Do not restate
them here; update the authoritative document if the policy itself changes.

## Working and pull-request conventions

- Keep the shared checkout on `main`. Create a dedicated git worktree and feature branch from the
  latest `origin/main` for each independent change.
- Preserve unrelated changes. Do not switch branches, clean files, or rewrite work in another
  checkout or worktree.
- Keep each pull request focused on one concern. Use a new branch and a new pull request for a new
  task; do not reuse a merged pull request's branch.
- Run the relevant validation described in the README before submission. Include the commands run
  and their results in the pull-request description.
- Preview the release classification when a change could affect shipped behavior, dependencies,
  schema, Docker configuration, or the Unraid template. Do not manually create release tags or
  rewrite package versions.
- Use the GitHub CLI (`gh`) for GitHub operations such as creating the pull request and checking its
  status. Push the branch with git, open the pull request with `gh pr create`, and inspect checks
  with `gh pr checks`.
- Do not merge a pull request unless the user explicitly asks. Follow the approval requirements in
  `MAINTAINERS.md` and leave resolution of protected-branch checks to the repository policy.
