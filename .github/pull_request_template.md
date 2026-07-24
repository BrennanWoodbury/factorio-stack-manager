## What changed

<!-- Lead with the user/developer outcome. Link an issue if one exists. -->

## Release impact

<!-- Keep one: Patch / Minor / Major. Explain the choice, including why any
impact-check finding is a false positive if an override is requested. -->

**Impact:** Patch / Minor / Major

**Reasoning:**

<!-- User-facing contracts include environment variables, Unraid Config targets,
data paths, port defaults, migrations, and anything requiring manual action. -->

- Contracts affected:
- Existing installs:
- Rollback:

## Database

<!-- Check one. For a new migration, name it and confirm its declared
backwardCompatible value. -->

- [ ] No migration
- [ ] Additive/backward-readable migration (`backwardCompatible: true`)
- [ ] One-way migration (`backwardCompatible: false`)

## Verification

<!-- List automated commands and focused manual scenarios. Include negative tests
when changing validation, compatibility, or impact-check behavior. -->

- Automated:
- Manual:

## Readiness

- [ ] Tests cover the changed behavior, or the reason they do not is explained above
- [ ] `.version` matches the release impact (unchanged for a patch)
- [ ] User-facing changes are recorded under `CHANGELOG.md` → `[Unreleased]`
- [ ] `README.md` and the Unraid template are updated where their documented contract changed
- [ ] Major changes or manual upgrade steps are documented in `UPGRADING.md`
