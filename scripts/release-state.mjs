/**
 * A release is ready to tag only when every generated surface agrees. Checking
 * the complete state lets release.mjs use the same no-argument command for both
 * halves of the protected-main workflow without mistaking a partial edit for a
 * reviewed release.
 */
export function isReleasePrepared(version, manifestVersions, changelog, template) {
  const escapedVersion = version.replaceAll('.', '\\.');
  return manifestVersions.length > 0
    && manifestVersions.every((found) => found === version)
    && new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)
    && new RegExp(`<Changes>\\s*### ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}`).test(template);
}
