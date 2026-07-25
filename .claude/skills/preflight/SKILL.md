---
name: preflight
description: Run this repo's full CI-equivalent check suite locally against the current branch, before opening or updating a PR. Reports pass/fail per check and previews the version-policy release impact, so a round-trip through CI isn't the first time a problem surfaces.
---

Use this skill when the user asks to check whether the current branch is ready for a
PR, will pass CI, or just wants a preflight/sanity check before pushing. Run every
check below in order; don't stop at the first failure — collect all results and
report them together, since a reviewer benefits from seeing everything that's wrong
at once rather than one failure per round-trip.

## Steps

1. **Governance and release-policy unit tests**
   - `node --test scripts/*.test.mjs` from the repo root.
   - These cover `version-policy.mjs`'s and `governance-check.mjs`'s own logic — if
     these fail, the policy/version prediction in step 3 can't be trusted either.

2. **Unraid template and Docker Hub overview validation**
   - `node scripts/validate-template.mjs`
   - `node scripts/validate-dockerhub-readme.mjs`
   - Cheap and side-effect-free; run them even if `templates/*.xml`, `ca_profile.xml`,
     or `DOCKERHUB.md` didn't change in this branch, since a change elsewhere (e.g. the
     repo/template path constants) can silently break what these check.

3. **Backend**
   - `cd backend && npm ci && npm run typecheck && npm test`

4. **Frontend**
   - `cd frontend && npm ci && npm run typecheck && npm test && npm run build`
   - The build is part of CI too (`frontend` job) — a typecheck pass alone isn't
     sufficient signal.

5. **Version-policy preview** — this is the check most likely to need human judgment,
   so report it prominently rather than folding it into a pass/fail line:
   - `git fetch origin main` (or the actual base branch, if not `main`) so the
     comparison ref is current.
   - `node scripts/version-policy.mjs --base origin/main`
   - Report the predicted release class, predicted version, and — most importantly —
     any **violations** verbatim. A violation here (e.g. "breaking change requires
     MAJOR=N") means `.version` needs a manual edit before this branch can merge; it
     is not something CI will silently fix.

6. **Report back** — a short table or list: each of the six checks above, pass/fail,
   and for any failure the actual error output (not a paraphrase). End with the
   version-policy summary from step 5 even if everything else passed, since that's the
   one result that isn't simply "pass."
