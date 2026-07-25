---
name: generate-pr
description: Compose and open a pull request for the current branch, filling in this repo's PR template from the actual diff and commit range instead of a generic summary. Opens as a draft and shows you the body before submitting.
---

Use this skill when the user asks to open, create, or generate a PR for the current
branch. It produces a PR body grounded in the real diff — never invent verification
steps, release-impact reasoning, or checklist ticks that the diff doesn't support.

## Steps

1. **Preflight**
   - Get the current branch (`git branch --show-current`). Refuse if it's `main` or
     `master` — there's nothing to open a PR from.
   - Run `git status`. If there are uncommitted changes, stop and ask the user whether
     to commit them first — don't fold them into the PR silently.
   - Run `gh pr list --head <branch> --state open`. If a PR already exists for this
     branch, stop and tell the user instead of creating a duplicate — ask if they want
     the existing PR updated instead.

2. **Gather the full changeset**
   - Determine the base branch — default to `main`.
   - `git log main..HEAD --oneline` for every commit in range, not just the latest one.
   - `git diff main...HEAD` for the full diff. Read all of it before drafting the body;
     don't draft from the log alone.

3. **Fill in `.github/pull_request_template.md`** section by section, grounded in what
   you actually read in step 2:
   - **What changed** — lead with the user/developer-visible outcome.
   - **Release impact** — CI calculates Patch/Minor/Major from migrations and runtime
     changes, so don't guess that classification. Your job is the **Reasoning**: state
     whether any user-facing contract changed (env vars, Unraid Config targets, data
     paths, port defaults, migrations) and whether a manual MAJOR bump is warranted. If
     `.version`'s `MAJOR` wasn't touched but the diff has a breaking contract change,
     flag that mismatch explicitly rather than filling the box in either direction.
   - **Why do? / What do?** — the problem/constraint and the approach taken, from the
     actual commits.
   - **Database** — check whether `backend/src/db/migrations.ts` changed. If so, find
     the new migration entry and read its `backwardCompatible` field to check the
     right box. If no migration file changed, check "No migration."
   - **Verification** — list only commands you actually ran this session (e.g. test
     suites) under Automated, and concrete manual scenarios under Manual. Leave a note
     rather than fabricating either.
   - **Readiness checklist** — check each box only if the diff supports it:
     - Tests cover the changed behavior — verify test files actually changed alongside
       the behavior, don't assume.
     - `.version` unchanged, or MAJOR bumped exactly once for a breaking change.
     - `CHANGELOG.md` — check whether `[Unreleased]` got an entry; this is optional per
       the file's own header, so leave unchecked with a note if skipped intentionally.
     - `README.md` / Unraid template — only if a documented contract changed.
     - `UPGRADING.md` — only if there's a manual upgrade step.
     Leave unaddressed items unchecked with a short inline note explaining why, instead
     of ticking them to look complete.

4. **Authorship** — never add a `Co-Authored-By: Claude` trailer or mention Claude
   generating the work, in either the commit history or the PR body. The PR should
   read as the user's own.

5. **Preview before submitting** — show the composed title and full body to the user
   and wait for their go-ahead or edits before calling `gh pr create`. Don't skip this;
   it's the one point to catch a wrong release-impact call or a missing checklist note
   before it's posted publicly.

6. **Push and create**
   - If the branch isn't pushed or is behind its remote, push it (`-u` if it has no
     upstream yet).
   - `gh pr create --draft --title "<title>" --body "$(cat <<'EOF' ... EOF)"` using the
     confirmed body, so formatting survives intact.
   - Opens as **draft** by default — only skip `--draft` if the user explicitly asks
     for it to be ready for review immediately.

7. **Report back** — return the PR URL, and call out any readiness-checklist items you
   left unchecked so the user can address them before marking it ready for review.
