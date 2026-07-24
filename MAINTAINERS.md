# Maintainers

The active maintainers are the people listed in the machine-readable block below. Keep the
markers and the `- @handle` format intact; repository automation reads this block directly.

<!-- maintainers:start -->
- @BrennanWoodbury
- @OccamsChainsaw42
<!-- maintainers:end -->

## Responsibilities

Maintainers are responsible for:

- reviewing and merging pull requests;
- triaging issues and keeping project work organized;
- preparing and publishing releases;
- reviewing and applying user-impact overrides when an automated impact check is a false positive;
- administering repository settings, access, rulesets, and other project infrastructure.

## Review policy

An ordinary pull request requires approval from at least one active maintainer other than the
pull request author.

A pull request that changes this file or [`.github/CODEOWNERS`](.github/CODEOWNERS) changes the
project's maintainer or ownership policy. It requires approvals from two distinct people who are
active maintainers on the protected base branch. Both approvals must apply to the current head
commit. Stale or dismissed approvals, duplicate reviews, self-approvals, and approvals from people
only added by the candidate change do not count.

The roster in this file and the individual owners on every rule in `.github/CODEOWNERS` must name
the same people. With a two-person roster, this deliberately means that adding or removing a
maintainer requires both current maintainers' consent.

## Repository protection

After the initial governance change is merged under the existing protections, the `Main` ruleset
must require code-owner review and the `governance/maintainer-approval` commit status. It must also
retain the existing CI checks, one general approval, dismissal of stale reviews, resolution of all
review threads, squash-only merges, and no bypass actors.

When changing this policy or its enforcement, verify it with harmless pull requests: an ordinary
change should need one non-author maintainer, while a change to either governance file must remain
blocked until both current maintainers approve the current head commit.
