## What changed

<!-- Lead with the user/developer outcome. Link an issue if one exists. -->

## Release impact

<!-- Keep one: None / Patch / Minor / Major. CI calculates this; explain any
breaking contract and the accompanying manual MAJOR increase. -->

**Impact:** None / Patch / Minor / Major

**Reasoning:**

<!-- User-facing contracts include environment variables, Unraid Config targets,
data paths, port defaults, migrations, and anything requiring manual action. -->

- Contracts affected:
- Existing installs:
- Rollback:

## Why do?

<!-- Why is this change needed? Describe the problem, constraint, or opportunity. -->

## What do?

<!-- What does this change do to address it? Call out the approach and important boundaries. -->

## Database

<!-- Check one. For a new migration, name it and confirm its declared
backwardCompatible value. -->

- [ ] No migration
- [ ] Additive/backward-readable migration (`backwardCompatible: true`)
- [ ] One-way migration (`backwardCompatible: false`)

## Verification

<!-- List automated commands and focused manual scenarios. Include negative tests
when changing validation, compatibility, or version-policy behavior. -->

- Automated:
- Manual:

## Readiness

- [ ] Tests cover the changed behavior, or the reason they do not is explained above
- [ ] `.version` is unchanged, or MAJOR is increased exactly once for a breaking change
- [ ] Any optional curated history belongs under `CHANGELOG.md` → `[Unreleased]`
- [ ] `README.md` and the Unraid template are updated where their documented contract changed
- [ ] Major changes or manual upgrade steps are documented in `UPGRADING.md`
