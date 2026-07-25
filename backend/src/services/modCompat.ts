import { parseDependencies, type ImageProfile, type ModDependency } from './imageProfile.js';

/**
 * Pre-start checks on a server's mod set, mirroring what the game itself refuses
 * to load.
 *
 * The motivation is a failure mode with no good exit: a mod the game won't accept
 * makes Factorio exit(1) about 7ms into startup, and the container's
 * `unless-stopped` policy restarts it forever. On a server with no save yet this
 * happens during `--create`, so the map is never even generated. Verified against
 * factoriotools/factorio:stable (2.0.77) — the game reports:
 *
 *   Failed to load mod "x": Incompatible Factorio version (current: 2.0, required: 1.1)
 *   Failed to load mod "x": Missing required dependency flib >= 0.14.0
 *
 * Those two messages are reproduced verbatim below, so what the manager says and
 * what the container log says line up.
 *
 * Deliberately NOT checked: dependency version constraints. `flib >= 0.14.0` is
 * satisfied here by flib being present at all, because the download path always
 * takes a mod's latest release — enforcing ranges means solving for a compatible
 * release set, which is a much larger change.
 *
 * Like imageProfile, this module has no runtime imports so it stays cheap to test.
 */

/** A mod zip actually present in the server's mods dir. */
export interface InstalledMod {
  name: string;
  version: string;
  /** info.json `factorio_version` — the game *series*, e.g. "2.0", not "2.0.77". */
  factorioVersion?: string;
  dependencies: ModDependency[];
}

/** The `name`/`enabled` pair from mod-list.json. */
export interface ModListEntry {
  name: string;
  enabled: boolean;
}

export type ModProblemKind =
  | 'not-installed'
  | 'game-version'
  | 'missing-dependency'
  | 'disabled-dependency'
  | 'conflict';

export interface ModProblem {
  kind: ModProblemKind;
  /** The enabled mod that can't load. */
  mod: string;
  /** One sentence, phrased as the game phrases it where there's an equivalent. */
  detail: string;
}

/**
 * The series a Factorio version belongs to: "2.0.77" → "2.0". Mod manifests
 * declare compatibility at this granularity, and the game matches on it exactly —
 * a 1.1 mod does not load on 2.0 however harmless it looks.
 */
export function gameSeries(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : '';
}

/** Read an installed mod's manifest out of a parsed info.json. */
export function installedFromInfo(json: unknown): InstalledMod | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const o = json as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.version !== 'string') return undefined;
  return {
    name: o.name,
    version: o.version,
    factorioVersion: typeof o.factorio_version === 'string' ? o.factorio_version : undefined,
    dependencies: parseDependencies(o.dependencies),
  };
}

/**
 * Everything about this mod set that would stop the server booting.
 *
 * `installed` is what's in the mods dir; `profile` is what the image ships. A mod
 * absent from mod-list.json counts as enabled when the image bundles it, which is
 * how the game treats its own mods — otherwise every server would report its
 * expansions as disabled dependencies.
 */
export function validateModSet(
  list: readonly ModListEntry[],
  installed: readonly InstalledMod[],
  profile: ImageProfile,
): ModProblem[] {
  const series = gameSeries(profile.gameVersion);
  const byName = new Map(installed.map((m) => [m.name, m]));
  const listed = new Map(list.map((e) => [e.name, e.enabled]));
  const bundled = profile.mods;
  const isEnabled = (name: string) => listed.get(name) ?? bundled.has(name);
  const isPresent = (name: string) => byName.has(name) || bundled.has(name);

  const problems: ModProblem[] = [];
  for (const entry of list) {
    if (!entry.enabled) continue; // the game ignores disabled mods entirely
    if (bundled.has(entry.name)) continue; // ships in the image, nothing to check

    const mod = byName.get(entry.name);
    if (!mod) {
      problems.push({
        kind: 'not-installed',
        mod: entry.name,
        detail: `Enabled but not downloaded — no ${entry.name} zip in the mods folder.`,
      });
      continue;
    }

    if (series && mod.factorioVersion && mod.factorioVersion !== series) {
      problems.push({
        kind: 'game-version',
        mod: entry.name,
        detail: `Incompatible Factorio version (current: ${series}, required: ${mod.factorioVersion}).`,
      });
    }

    for (const dep of mod.dependencies) {
      if (dep.kind === 'incompatible') {
        if (isEnabled(dep.name)) {
          problems.push({
            kind: 'conflict',
            mod: entry.name,
            detail: `Cannot be enabled at the same time as ${dep.name}.`,
          });
        }
        continue;
      }
      if (dep.kind === 'optional') continue;
      const named = dep.constraint ? `${dep.name} ${dep.constraint}` : dep.name;
      if (!isPresent(dep.name)) {
        problems.push({
          kind: 'missing-dependency',
          mod: entry.name,
          detail: `Missing required dependency ${named}.`,
        });
      } else if (!isEnabled(dep.name)) {
        problems.push({
          kind: 'disabled-dependency',
          mod: entry.name,
          detail: `Requires ${named}, which is installed but disabled.`,
        });
      }
    }
  }
  return problems;
}

/** One multi-line message for a start that was refused. */
export function describeProblems(problems: readonly ModProblem[]): string {
  const lines = problems.map((p) => `  • ${p.mod}: ${p.detail}`);
  return (
    `This mod set cannot load, so the server would fail to start and keep restarting:\n` +
    `${lines.join('\n')}\n` +
    `Fix the mod list (or disable the mods above) and start again.`
  );
}
