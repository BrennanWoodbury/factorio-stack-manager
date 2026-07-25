import { randomUUID, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { kvGet, kvSet, type DB } from '../db/index.js';
import type { ServerRow, DraftState } from '../db/models.js';
import { ServersRepo } from '../db/serversRepo.js';
import { PortAllocator } from './portAllocator.js';
import { DockerService, containerStatusLabel, conflictingHostPorts } from './dockerService.js';
import { DnsService } from './dnsService.js';
import { serverDnsEnabled } from './dnsSettings.js';
import { RconService } from './rconService.js';
import { serverFiles, sanitizeName, type ModEntry } from './serverFiles.js';
import { getFactorioAccount } from './factorioAccount.js';
import { readSaveHeader, portalModsFor, bundledModsFor, type SaveHeader } from './saveInspect.js';
import {
  ImageProfileService,
  modEnablementFor,
  gameModeIssue,
  type ImageProfile,
} from './imageProfile.js';
import { describeProblems, validateModSet, type ModProblem } from './modCompat.js';
import type { ModService } from './modService.js';
import {
  CASCADE,
  getGlobalDefaults,
  getGlobalAdvancedSettings,
  resetServerSetting,
  type CascadeDef,
} from './globalDefaults.js';
import { DockerError, DuplicateSubdomainError, NotFoundError, ValidationError } from '../lib/errors.js';

/** Extract the payload our decode/encode scenarios log between FTM_BEGIN…FTM_END. */
function extractMarker(logs: string): string | undefined {
  const m = /FTM_BEGIN([\s\S]*?)FTM_END/.exec(logs);
  return m ? m[1].trim() : undefined;
}

/** Pull the human-useful failure lines out of a probe log (mod/dependency/settings
 *  errors), stripping Factorio's leading timestamp. Deduped, last dozen. */
function extractProbeErrors(logs: string): string[] {
  const out: string[] = [];
  for (const raw of logs.split('\n')) {
    if (!/error|failed|missing|dependenc|incompatib|cannot|conflict|invalid/i.test(raw)) continue;
    if (/\b0 errors\b/i.test(raw)) continue;
    out.push(raw.replace(/^\s*\d+\.\d+\s+/, '').trim());
  }
  return [...new Set(out)].slice(-12);
}

export interface CreateServerInput {
  name: string;
  subdomain: string;
  maxPlayers?: number;
  description?: string;
  saveName?: string;
  generateNewSave?: boolean;
  factorioTag?: string;
  autoRestart?: boolean;
  /** Opt this server out of Cloudflare records entirely. Defaults to on. */
  dnsEnabled?: boolean;
  gameMode?: string;
  mods?: ModEntry[];
  /** Initial map-gen-settings for the server's first generated map (optional). */
  mapGen?: Record<string, unknown>;
}

export interface UpdateServerInput {
  name?: string;
  subdomain?: string;
  maxPlayers?: number;
  description?: string;
  saveName?: string;
  generateNewSave?: boolean;
  factorioTag?: string;
  autoRestart?: boolean;
  dnsEnabled?: boolean;
  gameMode?: string;
  autoBackup?: boolean;
  backupIntervalMinutes?: number;
  backupKeep?: number;
  backupKeepManual?: number;
}

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const GAME_MODES = ['vanilla', 'space_age', 'space_age_no_quality', 'modded'] as const;
const cleanGameMode = (m: string | undefined): string =>
  (GAME_MODES as readonly string[]).includes(m ?? '') ? (m as string) : 'space_age';

/**
 * How many times a start will move to a different port before giving up. Each
 * attempt costs a container create, and a range this full is a real problem the
 * user should hear about rather than have papered over.
 */
const MAX_PORT_ATTEMPTS = 5;

// Valid Docker image tag (also allow empty to mean "use the global default").
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * Orchestrates a server's whole lifecycle across the allocator, Docker, DNS and
 * the filesystem. Creation is transactional in the DB (row + port claim) and
 * best-effort/rolled-back for the external side effects (DNS record).
 */
export class ServerManager {
  /** Bundled-mod graph per Factorio image, read from the image and cached. */
  readonly imageProfiles: ImageProfileService;

  constructor(
    private readonly db: DB,
    private readonly repo: ServersRepo,
    private readonly allocator: PortAllocator,
    private readonly docker: DockerService,
    private readonly dns: DnsService,
    private readonly rcon: RconService,
    private readonly config: AppConfig,
    private readonly mods: ModService,
    imageProfiles: ImageProfileService,
  ) {
    this.imageProfiles = imageProfiles;
  }

  /**
   * Everything about a server's mod set that would stop it booting.
   *
   * Kept separate from `start` so the mods UI can show the same list at the point
   * the user is editing, rather than only when a start fails.
   */
  async modProblems(id: string): Promise<ModProblem[]> {
    const row = this.get(id);
    const profile = await this.imageProfiles.forServer(row);
    return validateModSet(serverFiles.readModList(id), this.mods.installedMods(id), profile);
  }

  /**
   * Force the game mode's bundled-mod enablement into a server's mod-list.json,
   * preserving every other entry. Which mods that means is derived from the
   * image's own dependency graph, not hardcoded — see imageProfile.ts. No-op for
   * Modded, where the applied modpack owns the list.
   *
   * Throws if the mode can't run on this image at all (Space Age without Quality
   * on 2.0.x), so the failure is a clear message rather than a mod-loader error
   * buried in the container log.
   */
  private async applyGameModeMods(row: ServerRow): Promise<void> {
    const profile = await this.imageProfiles.forServer(row);
    const issue = gameModeIssue(row.game_mode, profile);
    if (issue) throw new ValidationError(issue);

    const enablement = modEnablementFor(row.game_mode, profile);
    if (!enablement) return;
    const modList = serverFiles.readModList(row.id);
    for (const [name, enabled] of Object.entries(enablement)) {
      const entry = modList.find((m) => m.name === name);
      if (entry) entry.enabled = enabled;
      else modList.push({ name, enabled });
    }
    serverFiles.writeModList(row.id, modList);
  }

  private validateSubdomain(subdomain: string): void {
    if (!SUBDOMAIN_RE.test(subdomain)) {
      throw new ValidationError(
        'Subdomain must be a valid DNS label: lowercase letters, digits and hyphens',
      );
    }
  }

  /** Validate an image tag; returns the trimmed tag ('' means default). */
  private cleanTag(tag: string | undefined): string {
    const t = (tag ?? '').trim();
    if (t !== '' && !TAG_RE.test(t)) {
      throw new ValidationError('Factorio tag must be a valid Docker image tag (e.g. stable, 2.0.55)');
    }
    return t;
  }

  list(): ServerRow[] {
    return this.repo.list();
  }

  get(id: string): ServerRow {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Server');
    return row;
  }

  connectHost(row: ServerRow): string | undefined {
    // A server opted out of DNS has no hostname to advertise — the UI falls back
    // to IP:port, which is the only way to reach it.
    if (!serverDnsEnabled(row)) return undefined;
    return this.dns.connectHost(row.subdomain);
  }

  async create(input: CreateServerInput): Promise<ServerRow> {
    this.validateSubdomain(input.subdomain);
    if (this.repo.getBySubdomain(input.subdomain)) {
      throw new DuplicateSubdomainError(input.subdomain);
    }

    const id = randomUUID().slice(0, 8);
    const rconPassword = randomBytes(18).toString('base64url');
    const saveName = input.saveName?.trim() || 'default';
    // New servers inherit every cascading setting from the current global defaults
    // (overridden flags all 0).
    const g = getGlobalDefaults(this.db);

    const baseRow: ServerRow = {
      id,
      name: input.name.trim(),
      subdomain: input.subdomain,
      description: input.description?.trim() ?? '',
      max_players: input.maxPlayers ?? 0,
      game_port: 0,
      rcon_port: 0,
      rcon_password: rconPassword,
      save_name: saveName,
      generate_new_save: input.generateNewSave === false ? 0 : 1,
      // Credentials are global now (see factorioAccount); these columns are unused.
      factorio_username: '',
      factorio_token: '',
      container_id: null,
      status: 'stopped',
      created_at: '',
      updated_at: '',
      settings_json: null,
      applied_modpack_id: null,
      whitelist_json: null,
      factorio_tag: this.cleanTag(input.factorioTag),
      auto_restart: g.autoRestart ? 1 : 0,
      dns_enabled: input.dnsEnabled === false ? 0 : 1,
      adminlist_json: null,
      desired_state: 'stopped',
      auto_backup: g.autoBackup ? 1 : 0,
      backup_interval_minutes: g.backupIntervalMinutes,
      backup_keep: g.backupKeep,
      backup_keep_manual: g.backupKeepManual,
      auto_restart_overridden: 0,
      auto_backup_overridden: 0,
      backup_interval_minutes_overridden: 0,
      backup_keep_overridden: 0,
      backup_keep_manual_overridden: 0,
      map_gen_settings_json:
        input.mapGen && Object.keys(input.mapGen).length > 0 ? JSON.stringify(input.mapGen) : null,
      map_settings_json: null,
      game_mode: cleanGameMode(input.gameMode),
      lifecycle: 'active',
      expires_at: null,
      draft_state_json: null,
    };

    // Ports other containers already publish, so a fresh server doesn't get handed
    // one that would fail to bind. Fetched before the transaction, which is sync.
    const inUse = await this.docker.hostPortsInUse();

    // Phase 1: atomic DB write — insert row and claim ports together, so a port
    // is never claimed without a server, nor a server left without ports.
    const persist = this.db.transaction((): ServerRow => {
      this.repo.insert(baseRow);
      const { gamePort, rconPort } = this.allocator.allocatePair(id, inUse);
      this.db
        .prepare('UPDATE servers SET game_port = ?, rcon_port = ? WHERE id = ?')
        .run(gamePort, rconPort, id);
      return this.repo.getById(id)!;
    });
    const row = persist();

    // Phase 2: filesystem (idempotent, safe to leave behind if later steps fail).
    try {
      serverFiles.ensureDirs(id);
      serverFiles.writeServerSettings(row, getGlobalAdvancedSettings(this.db));
      if (input.mods && input.mods.length > 0) {
        serverFiles.writeModList(id, input.mods);
      }
    } catch (err) {
      this.hardDelete(id);
      throw err;
    }

    // Phase 3: DNS side effect. If Cloudflare fails, roll the whole thing back so
    // we don't leave an unreachable server with claimed ports.
    try {
      await this.dns.createServerSrv(row);
    } catch (err) {
      this.hardDelete(id);
      throw err;
    }

    return row;
  }

  // ---- Draft lifecycle (new-server wizard) ----

  /** How long an untouched draft survives before the prune job removes it. */
  private static readonly DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  private draftExpiry(): string {
    return new Date(Date.now() + ServerManager.DRAFT_TTL_MS).toISOString();
  }

  /**
   * Create a wizard draft — a persisted but inactive server row (no ports, no DNS)
   * that the new-server wizard fills in and later finalizes. Survives restarts, is
   * hidden from every operational listing, and is pruned once its TTL passes. The
   * intended subdomain lives in draft state (the row's `subdomain` column holds an
   * unusable placeholder) so two drafts can target the same name; uniqueness is only
   * enforced at finalize.
   */
  async createDraft(
    input: { source: DraftState['source'] } & Partial<CreateServerInput>,
  ): Promise<ServerRow> {
    const id = randomUUID().slice(0, 8);
    const g = getGlobalDefaults(this.db);
    const gameMode = cleanGameMode(input.gameMode);
    const state: DraftState = {
      source: input.source,
      name: input.name?.trim() || undefined,
      subdomain: input.subdomain?.trim() || undefined,
      maxPlayers: input.maxPlayers,
      description: input.description?.trim() || undefined,
      factorioTag: input.factorioTag,
      gameMode,
      mapGen: input.mapGen,
      mods: input.mods,
    };
    const row: ServerRow = {
      id,
      name: input.name?.trim() ?? '',
      // Placeholder: invalid as a real subdomain (underscores), so it can never
      // collide with an active server's; the intended subdomain lives in draft state.
      subdomain: `__draft_${id}`,
      description: input.description?.trim() ?? '',
      max_players: input.maxPlayers ?? 0,
      game_port: 0,
      rcon_port: 0,
      rcon_password: randomBytes(18).toString('base64url'),
      save_name: input.saveName?.trim() || 'default',
      // The save flow adopts an uploaded save; the others generate a new map.
      generate_new_save: input.source === 'save' ? 0 : 1,
      factorio_username: '',
      factorio_token: '',
      container_id: null,
      status: 'stopped',
      created_at: '',
      updated_at: '',
      settings_json: null,
      applied_modpack_id: null,
      whitelist_json: null,
      factorio_tag: this.cleanTag(input.factorioTag),
      auto_restart: g.autoRestart ? 1 : 0,
      dns_enabled: input.dnsEnabled === false ? 0 : 1,
      adminlist_json: null,
      desired_state: 'stopped',
      auto_backup: g.autoBackup ? 1 : 0,
      backup_interval_minutes: g.backupIntervalMinutes,
      backup_keep: g.backupKeep,
      backup_keep_manual: g.backupKeepManual,
      auto_restart_overridden: 0,
      auto_backup_overridden: 0,
      backup_interval_minutes_overridden: 0,
      backup_keep_overridden: 0,
      backup_keep_manual_overridden: 0,
      map_gen_settings_json:
        input.mapGen && Object.keys(input.mapGen).length > 0 ? JSON.stringify(input.mapGen) : null,
      map_settings_json: null,
      game_mode: gameMode,
      lifecycle: 'draft',
      expires_at: this.draftExpiry(),
      draft_state_json: JSON.stringify(state),
    };
    this.repo.insert(row);
    // Filesystem is best-effort/idempotent; a draft with no dir is still resumable.
    try {
      serverFiles.ensureDirs(id);
      serverFiles.writeServerSettings(row, getGlobalAdvancedSettings(this.db));
      if (input.mods && input.mods.length > 0) serverFiles.writeModList(id, input.mods);
    } catch (err) {
      console.warn(`[draft] file init failed for ${id}: ${(err as Error).message}`);
    }
    return this.repo.getById(id)!;
  }

  /** A single draft (must be lifecycle=draft). */
  getDraft(id: string): ServerRow {
    const row = this.repo.getById(id);
    if (!row || row.lifecycle !== 'draft') throw new NotFoundError('Draft');
    return row;
  }

  listDrafts(): ServerRow[] {
    return this.repo.listDrafts();
  }

  /**
   * Merge wizard progress into a draft: persist the resume state, refresh the prune
   * deadline, and mirror the fields that live on real columns (so finalize/start use
   * them). Returns the updated draft row.
   */
  async updateDraft(id: string, patch: Partial<DraftState>): Promise<ServerRow> {
    const row = this.getDraft(id);
    const prev: DraftState = row.draft_state_json
      ? (JSON.parse(row.draft_state_json) as DraftState)
      : { source: 'generate' };
    const next: DraftState = { ...prev, ...patch };

    const cols: Record<string, string | number> = {};
    if (patch.name !== undefined) cols.name = patch.name.trim();
    if (patch.description !== undefined) cols.description = patch.description.trim();
    if (patch.maxPlayers !== undefined) cols.max_players = patch.maxPlayers;
    if (patch.factorioTag !== undefined) cols.factorio_tag = this.cleanTag(patch.factorioTag);
    if (patch.gameMode !== undefined) cols.game_mode = cleanGameMode(patch.gameMode);
    if (Object.keys(cols).length > 0) this.repo.update(id, cols as never);
    if (patch.mapGen !== undefined) this.repo.setMapGenSettingsJson(id, JSON.stringify(patch.mapGen));
    if (patch.mapSettings !== undefined)
      this.repo.setMapSettingsJson(id, patch.mapSettings ? JSON.stringify(patch.mapSettings) : null);
    if (patch.mods !== undefined) {
      try {
        serverFiles.ensureDirs(id);
        serverFiles.writeModList(id, patch.mods);
      } catch (err) {
        console.warn(`[draft] mod-list write failed for ${id}: ${(err as Error).message}`);
      }
    }
    this.repo.setDraftState(id, JSON.stringify(next), this.draftExpiry());
    return this.repo.getById(id)!;
  }

  /** Store an uploaded save into a Load-from-save draft and make it the boot target. */
  async stageDraftSave(
    id: string,
    buffer: Buffer,
    filename: string,
  ): Promise<{ saveName: string; gameVersion?: string; mods?: { name: string; version: string }[] }> {
    this.getDraft(id);
    const name = sanitizeName(filename.replace(/\.zip$/i, '')) || 'save';
    serverFiles.ensureDirs(id);
    serverFiles.writeSave(id, name, buffer);
    this.repo.update(id, { save_name: name, generate_new_save: 0 } as never);

    // Read what the save needs straight out of its header, so the wizard can show
    // its mods and Factorio version immediately — no container, no boot.
    const patch: Partial<DraftState> = { saveStaged: true, saveFileName: name };
    try {
      const header = readSaveHeader(serverFiles.savePath(id, name));
      patch.saveGameVersion = header.gameVersion;
      patch.saveScenario = header.scenario;
      patch.saveMods = header.mods;
    } catch (err) {
      // A save we can't parse is still usable — the probe remains the backstop.
      console.warn(`[draft ${id}] could not read save header: ${(err as Error).message}`);
    }
    await this.updateDraft(id, patch);
    return { saveName: name, gameVersion: patch.saveGameVersion, mods: patch.saveMods };
  }

  /** Discard a draft (row + dir). No-op-safe on unknown ids. */
  discardDraft(id: string): void {
    const row = this.repo.getById(id);
    if (!row || row.lifecycle !== 'draft') return;
    this.repo.delete(id);
    serverFiles.removeAll(id);
  }

  /**
   * Finalize a draft into a real server: validate + claim its subdomain, allocate
   * ports, flip it active, and create its DNS record. (The pre-flight boot probe is
   * layered on in a later slice; "create without testing" calls this directly.)
   */
  async finalize(id: string): Promise<ServerRow> {
    const draft = this.getDraft(id);
    const state: DraftState = draft.draft_state_json
      ? (JSON.parse(draft.draft_state_json) as DraftState)
      : { source: 'generate' };
    const subdomain = (state.subdomain ?? '').trim();
    this.validateSubdomain(subdomain);
    if (this.repo.getBySubdomain(subdomain)) throw new DuplicateSubdomainError(subdomain);

    const inUse = await this.docker.hostPortsInUse();
    // Claim ports + flip active atomically.
    this.db.transaction(() => {
      const { gamePort, rconPort } = this.allocator.allocatePair(id, inUse);
      this.repo.promoteToActive(id, subdomain, gamePort, rconPort);
    })();
    const row = this.repo.getById(id)!;

    try {
      serverFiles.ensureDirs(id);
      serverFiles.writeServerSettings(row, getGlobalAdvancedSettings(this.db));
    } catch (err) {
      // Non-fatal: settings are rewritten on start too.
      console.warn(`[finalize] settings write failed for ${id}: ${(err as Error).message}`);
    }

    // DNS side effect. On failure, roll back to a draft so nothing half-created leaks.
    try {
      await this.dns.createServerSrv(row);
    } catch (err) {
      this.allocator.releaseServerPorts(id);
      this.repo.demoteToDraft(id, this.draftExpiry());
      throw err;
    }
    return row;
  }

  /**
   * Pre-flight "Test & Create" boot probe for a Generate draft: generate the map with
   * the real mods (catches map-gen + mod-load failures), then boot `--start-server`
   * isolated (public listing off, no host ports) and watch for the hosting-ready line
   * (catches runtime/mod-conflict failures). Streams log lines + coarse status via
   * `emit`. On success, pins the tested save so start() loads exactly what was verified.
   */
  async probeDraft(
    id: string,
    emit: { line?: (l: string) => void; status?: (s: string) => void } = {},
    hooks: { downloadMod?: (name: string, version?: string) => Promise<void> } = {},
  ): Promise<{ ok: boolean; errors: string[] }> {
    const row = this.getDraft(id);
    let source: DraftState['source'] = 'generate';
    try {
      if (row.draft_state_json) source = (JSON.parse(row.draft_state_json) as DraftState).source;
    } catch {
      /* default generate */
    }
    serverFiles.ensureDirs(id);
    serverFiles.writeServerSettings(row, getGlobalAdvancedSettings(this.db));
    // Apply the game mode's bundled-mod enablement to the mod list (as start() does).
    // An impossible mode is reported here rather than thrown: the caller is streaming
    // this to the wizard, where it belongs in the result list like any other failure.
    try {
      await this.applyGameModeMods(row);
    } catch (err) {
      return { ok: false, errors: [(err as Error).message] };
    }
    serverFiles.writeMapGenSettings(row);

    const saveName = sanitizeName(row.save_name || 'default');
    const savePath = `/factorio/saves/${saveName}.zip`;
    const probeSettings = serverFiles.writeProbeServerSettings(id);
    const onLine = emit.line;

    // 0) Load-from-save: resolve the save's mods from its own header BEFORE booting.
    // The boot log can't tell us — a headless server silently drops mods it doesn't
    // have and reports success — so an uploaded save is inspected directly and its
    // mods fetched at the exact versions the world was built with.
    if (source === 'save' && serverFiles.saveExists(id, saveName)) {
      const resolved = await this.resolveSaveMods(row, saveName, emit, hooks);
      if (resolved.length > 0) return { ok: false, errors: resolved };
    }

    // 1) Generate the map with the real mods — catches map-gen + mod-load failures.
    if (!serverFiles.saveExists(id, saveName)) {
      emit.status?.('Generating map…');
      const genArgs = ['--create', savePath, '--mod-directory', '/factorio/mods'];
      if (row.map_gen_settings_json)
        genArgs.push('--map-gen-settings', '/factorio/config/map-gen-settings.json');
      if (row.map_settings_json)
        genArgs.push('--map-settings', '/factorio/config/map-settings.json');
      const gen = await this.docker.runProbe(row, serverFiles.hostDir(id), genArgs, { onLine });
      if (gen.exitCode !== 0 || !serverFiles.saveExists(id, saveName)) {
        const errs = extractProbeErrors(gen.logs);
        return {
          ok: false,
          errors: errs.length ? errs : [`Map generation failed (exit ${gen.exitCode ?? '?'}).`],
        };
      }
    }

    // 2) Boot the save — catches hosting/runtime failures.
    emit.status?.('Booting server to test…');
    const bootArgs = ['--start-server', savePath, '--server-settings', probeSettings, '--mod-directory', '/factorio/mods'];
    const readyPatterns = [/Hosting game/i, /Starting RCON/i, /changing state from\(CreatingGame\) to\(InGame\)/i];
    const boot = await this.docker.runProbe(row, serverFiles.hostDir(id), bootArgs, { readyPatterns, onLine });
    if (!boot.matched) {
      if (boot.timedOut)
        return { ok: false, errors: ['Timed out waiting for the server to reach "hosting" — see the log above.'] };
      const errs = extractProbeErrors(boot.logs);
      return {
        ok: false,
        errors: errs.length ? errs : [`Server exited (code ${boot.exitCode ?? '?'}) before it started hosting.`],
      };
    }

    // Success: pin the tested save so start() loads exactly what we verified.
    this.repo.update(id, { generate_new_save: 0, save_name: saveName } as never);
    return { ok: true, errors: [] };
  }

  /**
   * Make the installed mod set match what an uploaded save actually needs, reading
   * the requirement from the save's own header rather than from a boot log.
   *
   * Bundled expansion mods are switched on in mod-list.json; everything else is
   * fetched from the portal pinned to the version recorded in the save. Returns the
   * list of failures (empty means the save's mods are satisfied) — a mod we can't
   * fetch is fatal for the probe, because booting anyway would silently drop it and
   * report a healthy server built on a gutted world.
   */
  private async resolveSaveMods(
    row: ServerRow,
    saveName: string,
    emit: { line?: (l: string) => void; status?: (s: string) => void },
    hooks: { downloadMod?: (name: string, version?: string) => Promise<void> },
  ): Promise<string[]> {
    const id = row.id;
    let header: SaveHeader;
    try {
      header = readSaveHeader(serverFiles.savePath(id, saveName));
    } catch (err) {
      // An unreadable header shouldn't block creation — fall through to the probe,
      // which still catches anything that actually stops the server booting.
      emit.line?.(`Could not read the save's mod list: ${(err as Error).message}`);
      return [];
    }

    // Split against what this image actually ships, so a save from a newer Factorio
    // doesn't send a newly-bundled mod (2.1's `recycler`) to the mod portal.
    let profile: ImageProfile | null = null;
    try {
      profile = await this.imageProfiles.forServer(row);
    } catch {
      /* fall back to the cross-version superset */
    }
    const bundledNames = profile ? new Set(profile.mods.keys()) : undefined;
    const bundled = bundledModsFor(header, bundledNames);
    const portal = portalModsFor(header, bundledNames);
    emit.status?.(
      `Save was built with Factorio ${header.gameVersion} and ${header.mods.length} mod(s)`,
    );

    const modList = serverFiles.readModList(id);
    const setEnabled = (name: string) => {
      const e = modList.find((m) => m.name === name);
      if (e) e.enabled = true;
      else modList.push({ name, enabled: true });
    };

    // Bundled expansion mods ship in the image — enabling them is all that's needed.
    for (const name of bundled) {
      emit.line?.(`Enabling bundled mod "${name}" (required by the save)`);
      setEnabled(name);
    }

    const failures: string[] = [];
    for (const mod of portal) {
      if (!hooks.downloadMod) {
        failures.push(`The save needs "${mod.name}" ${mod.version}, which isn't installed.`);
        continue;
      }
      try {
        emit.status?.(`Fetching "${mod.name}" ${mod.version} required by the save…`);
        await hooks.downloadMod(mod.name, mod.version);
        setEnabled(mod.name);
      } catch (err) {
        failures.push(
          `Could not fetch "${mod.name}" ${mod.version} that the save needs: ${(err as Error).message}`,
        );
      }
    }

    serverFiles.writeModList(id, modList);
    return failures;
  }

  /** Delete drafts past their TTL (row + on-disk dir). Runs on an interval. */
  pruneDrafts(): number {
    const ids = this.repo.deleteExpiredDrafts(new Date().toISOString());
    for (const id of ids) {
      try {
        serverFiles.removeAll(id);
      } catch (err) {
        console.warn(`[draft] dir cleanup failed for ${id}: ${(err as Error).message}`);
      }
    }
    if (ids.length > 0) console.log(`[draft] pruned ${ids.length} expired draft(s)`);
    return ids.length;
  }

  async update(id: string, input: UpdateServerInput): Promise<ServerRow> {
    const current = this.get(id);
    const fields: Record<string, string | number> = {};
    // Track whether anything that only takes effect at (re)start actually changed,
    // so auto-restart fires only on a real change (not e.g. toggling auto_restart
    // itself, or a no-op save).
    let restartRelevantChanged = false;
    const set = (key: string, value: string | number, restartRelevant: boolean) => {
      fields[key] = value;
      if (restartRelevant) restartRelevantChanged = true;
    };

    if (input.name !== undefined && input.name.trim() !== current.name) set('name', input.name.trim(), true);
    if (input.description !== undefined && input.description.trim() !== current.description)
      set('description', input.description.trim(), true);
    if (input.maxPlayers !== undefined && input.maxPlayers !== current.max_players)
      set('max_players', input.maxPlayers, true);
    if (input.saveName !== undefined) {
      const save = input.saveName.trim() || 'default';
      if (save !== current.save_name) set('save_name', save, true);
    }
    if (input.generateNewSave !== undefined) {
      const gen = input.generateNewSave ? 1 : 0;
      if (gen !== current.generate_new_save) set('generate_new_save', gen, true);
    }
    if (input.factorioTag !== undefined) {
      const tag = this.cleanTag(input.factorioTag);
      if (tag !== (current.factorio_tag ?? '')) set('factorio_tag', tag, true);
    }
    if (input.gameMode !== undefined) {
      const gm = cleanGameMode(input.gameMode);
      if (gm !== current.game_mode) set('game_mode', gm, true); // changes mods → restart-relevant
    }
    // DNS participation is a Cloudflare-only concern: the container is unaffected,
    // so this is never restart-relevant. The record itself is reconciled below.
    let dnsChanged = false;
    if (input.dnsEnabled !== undefined) {
      const flag = input.dnsEnabled ? 1 : 0;
      if (flag !== current.dns_enabled) {
        set('dns_enabled', flag, false);
        dnsChanged = true;
      }
    }
    // Cascading settings (auto_restart + backup config): explicitly setting one marks
    // it overridden, so it stops tracking the global default until reset. Never
    // restart-worthy (auto_restart toggling and backup config apply without a restart).
    const cascadeInput: Record<CascadeDef['key'], number | boolean | undefined> = {
      autoRestart: input.autoRestart,
      autoBackup: input.autoBackup,
      backupIntervalMinutes: input.backupIntervalMinutes,
      backupKeep: input.backupKeep,
      backupKeepManual: input.backupKeepManual,
    };
    for (const def of CASCADE) {
      const v = cascadeInput[def.key];
      if (v === undefined) continue;
      const num = def.type === 'bool' ? (v ? 1 : 0) : Math.max(def.min ?? 0, Math.floor(Number(v)));
      set(def.col, num, false);
      set(def.ovr, 1, false); // an explicit edit overrides the global
    }

    let subdomainChanged = false;
    if (input.subdomain !== undefined && input.subdomain !== current.subdomain) {
      this.validateSubdomain(input.subdomain);
      if (this.repo.getBySubdomain(input.subdomain)) {
        throw new DuplicateSubdomainError(input.subdomain);
      }
      fields.subdomain = input.subdomain; // SRV record only — no game restart needed
      subdomainChanged = true;
    }

    this.repo.update(id, fields as never);
    const updated = this.get(id);

    // A subdomain change must update the SRV record name, and flipping the DNS
    // toggle must create or remove the record. Both live, neither needs a restart.
    if (subdomainChanged || dnsChanged) {
      await this.dns.updateServerSrv(updated);
    }
    await this.maybeAutoRestart(id, restartRelevantChanged);
    return updated;
  }

  /**
   * Reset one cascading setting back to inheriting the global default (value =
   * current global, overridden flag = 0). Applies without a restart.
   */
  resetSetting(id: string, key: string): ServerRow {
    this.get(id); // 404 if unknown
    resetServerSetting(this.db, id, key);
    return this.get(id);
  }

  /**
   * If a restart-requiring change was made, the server has auto-restart enabled,
   * and it's currently running, kick off a restart in the background to apply it.
   * Returns whether a restart was triggered.
   */
  async maybeAutoRestart(id: string, requiresRestart: boolean): Promise<boolean> {
    if (!requiresRestart) return false;
    const row = this.get(id);
    if (row.auto_restart !== 1) return false;
    // Don't let a Docker hiccup fail the settings save — just skip the restart.
    let running = false;
    try {
      running = (await this.docker.status(id)).running;
    } catch (err) {
      console.warn(`[manager] auto-restart status check failed for ${id}: ${(err as Error).message}`);
      return false;
    }
    if (!running) return false;
    console.log(`[manager] auto-restarting ${id} to apply config change`);
    // Fire-and-forget: don't make the settings request wait for the restart. The
    // UI reflects it via status polling.
    void this.restart(id).catch((err) =>
      console.error(`[manager] auto-restart of ${id} failed: ${(err as Error).message}`),
    );
    return true;
  }

  /**
   * The effective advanced server-settings (hard-coded ⊕ global defaults ⊕ this
   * server's sparse overrides), plus which keys are overridden and the global
   * default values (so the UI can show inherit/override + "reset to global: X").
   */
  getSettings(id: string): {
    settings: Record<string, unknown>;
    overridden: string[];
    globalDefaults: Record<string, unknown>;
  } {
    const row = this.get(id);
    const globalDefaults = getGlobalAdvancedSettings(this.db);
    return {
      settings: serverFiles.getAdvancedSettings(row, globalDefaults),
      overridden: Object.keys(serverFiles.getServerOverrides(row)),
      globalDefaults,
    };
  }

  /**
   * Replace a server's advanced-settings SPARSE overrides — only the keys it
   * overrides (managed keys stripped). Everything else inherits the global default.
   * Applies to the game on next start.
   */
  async updateSettings(id: string, overrides: Record<string, unknown>) {
    this.get(id); // 404 if unknown
    const clean = { ...overrides };
    for (const k of ['name', 'description', 'max_players']) delete clean[k];
    this.repo.setSettingsJson(id, JSON.stringify(clean));
    await this.maybeAutoRestart(id, true);
    return this.getSettings(id);
  }

  // ---- Map generation (new-save settings) ----

  /** Effective map-gen-settings for a server (defaults filled) + any imported map-settings. */
  getMapGen(id: string): { mapGen: Record<string, unknown>; mapSettings: Record<string, unknown> | null } {
    const row = this.get(id);
    let mapSettings: Record<string, unknown> | null = null;
    if (row.map_settings_json) {
      try {
        mapSettings = JSON.parse(row.map_settings_json) as Record<string, unknown>;
      } catch {
        mapSettings = null;
      }
    }
    return { mapGen: serverFiles.getMapGenSettings(row), mapSettings };
  }

  /**
   * Store new-map generation settings, applied to the NEXT map generated (no running
   * game restarts). `mapSettings` is stored only when provided — normally omitted
   * (the image ships a version-matched map-settings.json; a hand-written one would
   * crash Factorio's strict schema). It's supplied only by an exchange-string import,
   * where it's version-correct because Factorio's own parser produced it.
   */
  async updateMapGen(
    id: string,
    input: { mapGen: Record<string, unknown>; mapSettings?: Record<string, unknown> | null },
  ): Promise<{ mapGen: Record<string, unknown>; mapSettings: Record<string, unknown> | null }> {
    this.get(id); // 404 if unknown
    this.repo.setMapGenSettingsJson(id, JSON.stringify(input.mapGen));
    if (input.mapSettings !== undefined) {
      this.repo.setMapSettingsJson(id, input.mapSettings ? JSON.stringify(input.mapSettings) : null);
    }
    return this.getMapGen(id);
  }

  // ---- Whitelist ----

  /** Sanitise a list of usernames: trim, drop blanks, dedupe (case-insensitive). */
  private sanitizeNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  getServerWhitelist(id: string): string[] {
    const row = this.get(id);
    if (!row.whitelist_json) return [];
    try {
      return JSON.parse(row.whitelist_json) as string[];
    } catch {
      return [];
    }
  }

  async setServerWhitelist(id: string, names: string[]): Promise<string[]> {
    this.get(id); // 404 if unknown
    const clean = this.sanitizeNames(names);
    this.repo.setWhitelistJson(id, JSON.stringify(clean));
    await this.maybeAutoRestart(id, true);
    return clean;
  }

  getGlobalWhitelist(): string[] {
    const raw = kvGet(this.db, 'global_whitelist');
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async setGlobalWhitelist(names: string[]): Promise<string[]> {
    const clean = this.sanitizeNames(names);
    kvSet(this.db, 'global_whitelist', JSON.stringify(clean));
    // The global whitelist affects every server — auto-restart any running ones
    // that opted in.
    for (const s of this.repo.list()) {
      await this.maybeAutoRestart(s.id, true);
    }
    return clean;
  }

  /** Effective whitelist for a server = global ∪ per-server (deduped). */
  effectiveWhitelist(id: string): string[] {
    return this.sanitizeNames([...this.getGlobalWhitelist(), ...this.getServerWhitelist(id)]);
  }

  // ---- Admin list (same shape as the whitelist) ----

  getServerAdminlist(id: string): string[] {
    const row = this.get(id);
    if (!row.adminlist_json) return [];
    try {
      return JSON.parse(row.adminlist_json) as string[];
    } catch {
      return [];
    }
  }

  async setServerAdminlist(id: string, names: string[]): Promise<string[]> {
    this.get(id);
    const clean = this.sanitizeNames(names);
    this.repo.setAdminlistJson(id, JSON.stringify(clean));
    await this.maybeAutoRestart(id, true);
    return clean;
  }

  getGlobalAdminlist(): string[] {
    const raw = kvGet(this.db, 'global_adminlist');
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async setGlobalAdminlist(names: string[]): Promise<string[]> {
    const clean = this.sanitizeNames(names);
    kvSet(this.db, 'global_adminlist', JSON.stringify(clean));
    for (const s of this.repo.list()) {
      await this.maybeAutoRestart(s.id, true);
    }
    return clean;
  }

  /** Effective admin list for a server = global ∪ per-server (deduped). */
  effectiveAdminlist(id: string): string[] {
    return this.sanitizeNames([...this.getGlobalAdminlist(), ...this.getServerAdminlist(id)]);
  }

  async start(id: string): Promise<void> {
    const row = this.get(id);
    await this.docker.ensureNetwork();
    // Recreate the container each start so it always reflects current config
    // (env vars, ports). Data lives in the bind mount, so this is cheap.
    serverFiles.writeServerSettings(row, getGlobalAdvancedSettings(this.db));
    // Enforce the game mode's bundled-mod enablement in the mod list, preserving any
    // other mods. Modded leaves the mod list to the applied modpack.
    await this.applyGameModeMods(row);
    // Fetch anything enabled but not on disk. A mod list is written before its
    // downloads run, so a failure part-way leaves mods enabled with no zips —
    // recoverable only by re-saving the list by hand. Healing here makes the
    // download happen when it is actually needed.
    const failed = await this.mods.downloadMissing(row);
    if (failed.length > 0) {
      throw new ValidationError(
        `Could not download ${failed.length} mod(s) this server needs:\n` +
          failed.map((f) => `  • ${f.name}: ${f.error}`).join('\n'),
      );
    }
    // Refuse a mod set the game will reject. Without this the container exits(1)
    // ~7ms in and `unless-stopped` restarts it forever, with the only explanation
    // buried in the container log — and on a server with no save yet the failure
    // happens during `--create`, so no map is ever generated.
    const problems = await this.modProblems(id);
    if (problems.length > 0) throw new ValidationError(describeProblems(problems));
    // Custom map-gen settings (if any) written to config/ so the image's `--create`
    // (GENERATE_NEW_SAVE=true, or first start with no saves) honours them; also heals
    // any stale incomplete map-settings.json left by an earlier build.
    serverFiles.writeMapGenSettings(row);
    // The image reads its RCON password from config/rconpw (ignoring the env var),
    // so write our stored password there so the manager can authenticate.
    serverFiles.writeRconPassword(id, row.rcon_password);
    // Effective whitelist / admin list = global ∪ per-server. Written each start.
    serverFiles.writeWhitelist(id, this.effectiveWhitelist(id));
    serverFiles.writeAdminlist(id, this.effectiveAdminlist(id));
    const containerId = await this.startWithFreePorts(id);
    this.repo.setStatus(id, 'running', containerId);
    // Record intent so the server is resumed if the manager restarts.
    this.repo.setDesiredState(id, 'running');
  }

  /**
   * Create and start the container, moving off any port the host refuses.
   *
   * The allocator's table only records what this manager handed out. A Factorio
   * server someone runs outside the tool — another container, or a native process
   * — holds a real port that we would otherwise assign and only discover at start,
   * as `Bind for 0.0.0.0:34197 failed: port is already allocated`. Nothing short of
   * binding can tell us: the manager sits in its own network namespace, so probing
   * from here answers a different question.
   *
   * So the bind is the check. On a conflict the offending port is blocked, a
   * replacement claimed, and the attempt repeated — carrying the new game port into
   * DNS, since the SRV record advertises it.
   */
  private async startWithFreePorts(id: string): Promise<string> {
    const blocked = new Set(await this.docker.hostPortsInUse());
    for (let attempt = 1; ; attempt++) {
      let row = this.get(id);
      // Ports another container already publishes are known-bad before we try.
      for (const [kind, port] of [
        ['game', row.game_port],
        ['rcon', row.rcon_port],
      ] as const) {
        if (blocked.has(port)) await this.movePort(row, kind, blocked);
      }
      row = this.get(id);

      await this.docker.remove(id);
      const containerId = await this.docker.createContainer(
        row,
        serverFiles.hostDir(id),
        getFactorioAccount(this.db),
      );
      try {
        await this.docker.start(id);
        return containerId;
      } catch (err) {
        const conflicts = conflictingHostPorts(err);
        if (conflicts.length === 0 || attempt >= MAX_PORT_ATTEMPTS) throw err;
        for (const port of conflicts) blocked.add(port);
        console.warn(
          `[manager] ${id}: host port(s) ${conflicts.join(', ')} taken by something else; ` +
            'reallocating',
        );
      }
    }
  }

  /**
   * Move one of a server's ports out of the way and keep everything that quotes it
   * in step. Returns the new port.
   */
  private async movePort(
    row: ServerRow,
    kind: 'game' | 'rcon',
    blocked: ReadonlySet<number>,
  ): Promise<number> {
    const port = this.allocator.reallocate(row.id, kind, blocked);
    this.repo.update(row.id, { [kind === 'game' ? 'game_port' : 'rcon_port']: port } as never);
    if (kind === 'game') {
      // The SRV record advertises the port, so a silent change would leave every
      // player connecting by hostname pointed at a port nothing listens on.
      try {
        await this.dns.updateServerSrv(this.get(row.id));
      } catch (err) {
        console.warn(`[manager] ${row.id}: SRV update after port change failed: ${(err as Error).message}`);
      }
    }
    return port;
  }

  /**
   * Create a new named save offline (server must be stopped). Runs the Factorio
   * binary once in a throwaway container with `--create`. Throws with the job's
   * log tail if generation fails.
   */
  async createSave(id: string, saveName: string): Promise<{ name: string }> {
    const row = this.get(id);
    const name = sanitizeName(saveName);
    const cs = await this.docker.status(id);
    if (cs.running) {
      throw new ValidationError('Stop the server before creating a save');
    }
    if (serverFiles.saveExists(id, name)) {
      throw new ValidationError(`A save named "${name}" already exists`);
    }
    serverFiles.ensureDirs(id);
    // The one-shot overrides the entrypoint and invokes the binary directly, so the
    // image's own map-gen handling (incl. copying example configs) doesn't run. Write
    // our custom map-gen file (if the server has one) and pass it explicitly. We don't
    // pass --map-settings: omitting it uses Factorio's built-in, version-correct
    // defaults (a hand-written file risks the strict-schema crash).
    serverFiles.writeMapGenSettings(row);
    const args = ['--create', `/factorio/saves/${name}.zip`];
    if (row.map_gen_settings_json) {
      args.push('--map-gen-settings', '/factorio/config/map-gen-settings.json');
    }
    if (row.map_settings_json) {
      args.push('--map-settings', '/factorio/config/map-settings.json');
    }
    const { exitCode, logs } = await this.docker.runOneShot(row, serverFiles.hostDir(id), args);
    if (exitCode !== 0 || !serverFiles.saveExists(id, name)) {
      throw new DockerError(`save generation failed (exit ${exitCode}): ${logs.slice(-500)}`);
    }
    return { name };
  }

  /**
   * Restore the server onto a given save: select it (don't generate a new one) and
   * (re)start so it loads immediately. Starts the server if it was stopped, restarts
   * it if running. Discards any unsaved progress in the current game.
   */
  async restoreFromSave(id: string, saveName: string): Promise<ServerRow> {
    this.get(id);
    const name = sanitizeName(saveName);
    if (!serverFiles.saveExists(id, name)) throw new ValidationError(`No such save "${name}"`);
    await this.update(id, { saveName: name, generateNewSave: false });
    // start() recreates the container from scratch, so it loads the selected save
    // whether the server was previously running or stopped.
    await this.start(id);
    return this.get(id);
  }

  /**
   * Render a map preview PNG for the given settings (or the server's saved ones) via
   * a throwaway one-shot. Runs the binary with `--generate-map-preview`, mounting the
   * server's data dir (so its mods resolve), and returns the PNG bytes. Preview-only:
   * writes to a scratch dir, never touches the real save/config.
   */
  async previewMap(
    id: string,
    opts: { mapGen?: Record<string, unknown>; planet?: string; seed?: number; size?: number } = {},
  ): Promise<Buffer> {
    const row = this.get(id);
    serverFiles.ensureDirs(id);
    const settings = opts.mapGen ?? serverFiles.getMapGenSettings(row);
    const settingsPath = serverFiles.writePreviewSettings(id, settings);
    const size = Math.min(2048, Math.max(256, Math.floor(opts.size ?? 1024)));
    const args = [
      '--generate-map-preview',
      serverFiles.previewOutContainerPath(),
      '--map-preview-size',
      String(size),
      '--map-gen-settings',
      settingsPath,
    ];
    // Non-Nauvis planets (Vulcanus, Fulgora, …) only exist with Space Age loaded, so
    // enable it per game mode and mount the mod dir. Nauvis previews keep the original
    // bundled-defaults path untouched (no regression).
    const planet = opts.planet;
    if (planet && planet !== 'nauvis') {
      await this.applyGameModeMods(row);
      args.push('--mod-directory', '/factorio/mods');
    }
    if (planet) args.push('--map-preview-planet', planet);
    if (opts.seed !== undefined && Number.isFinite(opts.seed)) args.push('--map-gen-seed', String(Math.floor(opts.seed)));
    const { exitCode, logs } = await this.docker.runOneShot(row, serverFiles.hostDir(id), args, 90_000);
    if (exitCode !== 0) {
      throw new DockerError(`map preview failed (exit ${exitCode}): ${logs.slice(-500)}`);
    }
    return serverFiles.readPreview(id);
  }

  /**
   * Decode a Factorio map exchange string into JSON using Factorio's own parser
   * (`helpers.parse_map_exchange_string`) in a throwaway scenario one-shot — mounts
   * the server's mods so their controls resolve. Returns the map-gen + map settings.
   */
  async importExchangeString(
    id: string,
    exchangeString: string,
  ): Promise<{ mapGen: Record<string, unknown>; mapSettings: Record<string, unknown> }> {
    const row = this.get(id);
    const s = exchangeString.trim();
    if (!/^>>>[A-Za-z0-9+/=\r\n]+<<<$/.test(s)) {
      throw new ValidationError('Not a valid Factorio map exchange string (expected >>>…<<<)');
    }
    serverFiles.ensureDirs(id);
    serverFiles.writeDecoderScenario(id, s.replace(/[\r\n]/g, ''));
    const { logs } = await this.docker.runOneShot(
      row,
      serverFiles.hostDir(id),
      ['--start-server-load-scenario', 'ftm-decode', '--server-settings', '/factorio/.import/server-settings.json'],
      60_000,
    );
    const json = extractMarker(logs);
    if (!json) {
      if (/FTM_ERR:/.test(logs)) {
        throw new ValidationError(
          "Couldn't decode that exchange string — it may reference mods this server doesn't have, or be from a different Factorio version.",
        );
      }
      throw new DockerError(`exchange decode failed: ${logs.slice(-400)}`);
    }
    const data = JSON.parse(json) as { map_gen_settings?: Record<string, unknown>; map_settings?: Record<string, unknown> };
    if (!data.map_gen_settings) throw new DockerError('decode produced no map_gen_settings');
    return { mapGen: data.map_gen_settings, mapSettings: data.map_settings ?? {} };
  }

  /**
   * The default map-gen settings for this server's loaded mods — the complete control
   * set (including modded resources) at defaults. Runs a throwaway scenario with the
   * server's mod directory so downloaded mods load. Used to build dynamic sliders for
   * Modded servers.
   */
  async mapGenBaseline(
    id: string,
  ): Promise<{ mapGen: Record<string, unknown>; mapSettings: Record<string, unknown> }> {
    const row = this.get(id);
    serverFiles.ensureDirs(id);
    serverFiles.writeBaselineScenario(id);
    const { logs } = await this.docker.runOneShot(
      row,
      serverFiles.hostDir(id),
      [
        '--start-server-load-scenario',
        'ftm-baseline',
        '--server-settings',
        '/factorio/.import/server-settings.json',
        '--mod-directory',
        '/factorio/mods',
      ],
      90_000,
    );
    const json = extractMarker(logs);
    if (!json) throw new DockerError(`map-gen baseline failed: ${logs.slice(-400)}`);
    const data = JSON.parse(json) as { map_gen_settings?: Record<string, unknown>; map_settings?: Record<string, unknown> };
    if (!data.map_gen_settings) throw new DockerError('baseline produced no map_gen_settings');
    return { mapGen: data.map_gen_settings, mapSettings: data.map_settings ?? {} };
  }

  /**
   * Encode map-gen settings into a shareable exchange string via Factorio's own
   * `game.get_map_exchange_string()` (a throwaway scenario one-shot). On-demand only.
   */
  async exportExchangeString(id: string, mapGen?: Record<string, unknown>): Promise<string> {
    const row = this.get(id);
    const settings = mapGen ?? serverFiles.getMapGenSettings(row);
    serverFiles.ensureDirs(id);
    serverFiles.writeEncoderScenario(id);
    const mgsPath = serverFiles.writeEncodeSettings(id, settings);
    const { logs } = await this.docker.runOneShot(
      row,
      serverFiles.hostDir(id),
      [
        '--start-server-load-scenario',
        'ftm-encode',
        '--server-settings',
        '/factorio/.import/server-settings.json',
        '--map-gen-settings',
        mgsPath,
      ],
      60_000,
    );
    const str = extractMarker(logs);
    if (!str || !str.startsWith('>>>')) throw new DockerError(`exchange encode failed: ${logs.slice(-400)}`);
    return str.trim();
  }

  // ---- Backups ----

  /**
   * Create a backup of a save. If the server is running, first force a fresh save
   * over RCON (best-effort) so the backup captures current state. Backs up the given
   * save, or the newest one. `kind` tags it manual vs auto and selects which
   * retention window it's pruned against — manual and auto never evict each other.
   * Only 'auto' advances the scheduler clock, so a manual backup doesn't delay the
   * next scheduled one.
   */
  async backupNow(
    id: string,
    saveName?: string,
    kind: 'manual' | 'auto' = 'manual',
  ): Promise<{ name: string; source: string }> {
    const row = this.get(id);
    let cs;
    try {
      cs = await this.docker.status(id);
    } catch {
      cs = { running: false } as { running: boolean };
    }
    if (cs.running) {
      try {
        await this.rcon.send(row, '/server-save');
        await new Promise((r) => setTimeout(r, 2500)); // let the save flush to disk
      } catch (err) {
        console.warn(`[backup] /server-save on ${id} failed: ${(err as Error).message}`);
      }
    }
    const source = saveName ?? serverFiles.latestSaveName(id);
    if (!source) throw new ValidationError('No save available to back up');
    const name = serverFiles.backupSave(id, source, kind);
    serverFiles.pruneBackups(id, kind, kind === 'auto' ? row.backup_keep : row.backup_keep_manual);
    if (kind === 'auto') kvSet(this.db, `backup_last_${id}`, String(Date.now()));
    return { name, source };
  }

  listBackups(id: string) {
    this.get(id);
    return serverFiles.listBackups(id);
  }

  deleteBackup(id: string, name: string): void {
    this.get(id);
    serverFiles.deleteBackup(id, name);
  }

  /** Restore a backup into saves/ and select it. Server must be stopped. */
  async restoreBackup(id: string, name: string): Promise<string> {
    this.get(id);
    if ((await this.docker.status(id).catch(() => ({ running: false }))).running) {
      throw new ValidationError('Stop the server before restoring a backup');
    }
    const source = serverFiles.restoreBackup(id, name);
    await this.update(id, { saveName: source, generateNewSave: false });
    return source;
  }

  /** Run scheduled backups for any auto-backup server whose interval has elapsed. */
  async runDueBackups(): Promise<void> {
    const now = Date.now();
    for (const row of this.repo.list()) {
      if (row.auto_backup !== 1) continue;
      const last = Number(kvGet(this.db, `backup_last_${row.id}`) ?? 0);
      if (now - last < row.backup_interval_minutes * 60_000) continue;
      try {
        const { name } = await this.backupNow(row.id, undefined, 'auto');
        console.log(`[backup] auto-backed up ${row.subdomain}: ${name}`);
      } catch (err) {
        console.warn(`[backup] auto-backup of ${row.id} failed: ${(err as Error).message}`);
      }
    }
  }

  async stop(id: string): Promise<void> {
    this.get(id);
    await this.rcon.disconnect(id);
    await this.docker.stop(id);
    this.repo.setStatus(id, 'stopped');
    // Explicit stop = the server should stay stopped across a manager restart.
    this.repo.setDesiredState(id, 'stopped');
  }

  /**
   * On manager startup, start any server whose desired state is 'running' but
   * whose container isn't currently running (e.g. after STOP_SERVERS_ON_SHUTDOWN,
   * or a container that was removed). Best-effort per server; runs in the
   * background so it never blocks the API coming up.
   */
  async resumeDesiredRunning(): Promise<void> {
    const toResume: ServerRow[] = [];
    for (const row of this.repo.list()) {
      if (row.desired_state !== 'running') continue;
      try {
        if (!(await this.docker.status(row.id)).running) toResume.push(row);
      } catch {
        // Docker unreachable — skip; nothing we can do until it's back.
        return;
      }
    }
    if (toResume.length === 0) return;
    console.log(`[startup] resuming ${toResume.length} server(s) that were running`);
    for (const row of toResume) {
      try {
        await this.start(row.id);
        console.log(`[startup] resumed ${row.subdomain} (${row.id})`);
      } catch (err) {
        console.error(`[startup] failed to resume ${row.id}: ${(err as Error).message}`);
      }
    }
  }

  async restart(id: string): Promise<void> {
    // Full recreate to pick up any config changes.
    await this.start(id);
  }

  async delete(id: string): Promise<void> {
    const row = this.get(id);
    await this.rcon.disconnect(id);
    // Remove the container (best-effort; ignore if already gone).
    try {
      await this.docker.remove(id);
    } catch (err) {
      console.warn(`[manager] container remove during delete failed: ${(err as Error).message}`);
    }
    // Remove DNS records (best-effort).
    try {
      await this.dns.deleteServerSrv(id);
    } catch (err) {
      console.warn(`[manager] SRV delete during delete failed: ${(err as Error).message}`);
    }
    this.hardDelete(id);
    void row;
  }

  /** DB + filesystem teardown. Ports/dns rows cascade from the servers delete. */
  private hardDelete(id: string): void {
    this.db.transaction(() => {
      this.allocator.releaseServerPorts(id);
      this.repo.delete(id);
    })();
    serverFiles.removeAll(id);
  }

  /** Live status: container state + player count (RCON) when running. */
  async status(id: string): Promise<{
    id: string;
    status: string;
    running: boolean;
    startedAt?: string;
    restartCount?: number;
    players?: { count: number; names: string[] };
    playersError?: string;
  }> {
    const row = this.get(id);
    const cs = await this.docker.status(id);
    // 'crashed' is what points at the container log, where the reason always is.
    const status = containerStatusLabel(cs);
    if (this.repo.getById(id)!.status !== status) this.repo.setStatus(id, status);

    const result = {
      id,
      status,
      running: cs.running,
      startedAt: cs.startedAt,
      restartCount: cs.restartCount,
    } as Awaited<ReturnType<ServerManager['status']>>;

    if (cs.running) {
      try {
        result.players = await this.rcon.players(row);
      } catch (err) {
        result.playersError = (err as Error).message;
      }
    }
    return result;
  }
}
