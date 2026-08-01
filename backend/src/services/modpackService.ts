import { randomUUID } from 'node:crypto';
import { ModpacksRepo, type ModpackRow } from '../db/modpacksRepo.js';
import { ServersRepo } from '../db/serversRepo.js';
import { ModService, type ModProgress } from './modService.js';
import type { ModEntry } from './serverFiles.js';
import { DuplicateModpackError, NotFoundError, ValidationError } from '../lib/errors.js';

export interface ModpackModDto {
  name: string;
  enabled: boolean;
  version: string | null;
}

/** The official Factorio Space Age expansion mods (ship with the DLC). */
export const SPACE_AGE_PACK = {
  name: 'Space Age',
  description:
    'Factorio Space Age expansion. Enables the official space-age, quality and elevated-rails mods. Requires the Space Age DLC in the server’s game data — these mods ship with the game and are not downloaded from the mod portal.',
  mods: [
    { name: 'space-age', enabled: true, version: null },
    { name: 'quality', enabled: true, version: null },
    { name: 'elevated-rails', enabled: true, version: null },
  ] as ModpackModDto[],
};
export interface ModpackDto {
  id: string;
  name: string;
  description: string;
  factorioVersion: string;
  modCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ModpackManifest {
  name: string;
  description?: string;
  factorioVersion?: string;
  mods: ModpackModDto[];
}

/** Apply/download result for one server. */
export interface ApplyResult {
  serverId: string;
  downloaded: { name: string; version: string }[];
  errors: { name: string; error: string }[];
}

/**
 * The shared modpack registry: named, reusable mod manifests you build once and
 * apply to any server. Packs hold only names + enabled flags + optional pinned
 * versions — no binaries, no credentials. Applying a pack replaces a server's
 * mod list and downloads the mods using that server's own portal credentials.
 * Editing a pack does NOT auto-propagate; re-apply is explicit.
 */
export class ModpackService {
  constructor(
    private readonly repo: ModpacksRepo,
    private readonly servers: ServersRepo,
    private readonly mods: ModService,
  ) {}

  private toDto(row: ModpackRow): ModpackDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      factorioVersion: row.factorio_version,
      modCount: this.repo.countMods(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private modsDto(id: string): ModpackModDto[] {
    return this.repo.listMods(id).map((m) => ({
      name: m.name,
      enabled: m.enabled === 1,
      version: m.version,
    }));
  }

  list(): ModpackDto[] {
    return this.repo.list().map((r) => this.toDto(r));
  }

  get(id: string): { pack: ModpackDto; mods: ModpackModDto[]; usedBy: { id: string; name: string }[] } {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Modpack');
    return {
      pack: this.toDto(row),
      mods: this.modsDto(id),
      usedBy: this.servers.listByModpack(id).map((s) => ({ id: s.id, name: s.name })),
    };
  }

  /** Create a pack, auto-deduping the name so imports never fail on a clash. */
  create(input: { name: string; description?: string; factorioVersion?: string }, dedupe = false): ModpackRow {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Modpack name is required');
    let finalName = name;
    if (this.repo.getByName(finalName)) {
      if (!dedupe) throw new DuplicateModpackError(finalName);
      let n = 2;
      while (this.repo.getByName(`${name} (${n})`)) n++;
      finalName = `${name} (${n})`;
    }
    const id = randomUUID().slice(0, 8);
    this.repo.insert({
      id,
      name: finalName,
      description: input.description?.trim() ?? '',
      factorio_version: input.factorioVersion ?? '',
    });
    return this.repo.getById(id)!;
  }

  update(id: string, fields: { name?: string; description?: string; factorioVersion?: string }): ModpackDto {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Modpack');
    const patch: Partial<Pick<ModpackRow, 'name' | 'description' | 'factorio_version'>> = {};
    if (fields.name !== undefined) {
      const name = fields.name.trim();
      const existing = this.repo.getByName(name);
      if (existing && existing.id !== id) throw new DuplicateModpackError(name);
      patch.name = name;
    }
    if (fields.description !== undefined) patch.description = fields.description.trim();
    if (fields.factorioVersion !== undefined) patch.factorio_version = fields.factorioVersion;
    this.repo.update(id, patch);
    return this.toDto(this.repo.getById(id)!);
  }

  delete(id: string): void {
    if (!this.repo.getById(id)) throw new NotFoundError('Modpack');
    // Clear the applied-pack pointer on any servers referencing it (no FK).
    for (const s of this.servers.listByModpack(id)) this.servers.setAppliedModpack(s.id, null);
    this.repo.delete(id);
  }

  setMods(id: string, mods: ModpackModDto[]): ModpackModDto[] {
    if (!this.repo.getById(id)) throw new NotFoundError('Modpack');
    this.repo.replaceMods(id, mods);
    return this.modsDto(id);
  }

  /** Snapshot a server's current mod list into a new pack. */
  createFromServer(serverId: string, name: string): ModpackRow {
    const server = this.servers.getById(serverId);
    if (!server) throw new NotFoundError('Server');
    const pack = this.create({ name }, false);
    const entries: ModpackModDto[] = this.mods
      .getModList(serverId)
      .filter((m) => m.name !== 'base')
      .map((m) => ({ name: m.name, enabled: m.enabled, version: null }));
    this.repo.replaceMods(pack.id, entries);
    return pack;
  }

  /** Apply a pack to one server: replace its mod list and download the mods. */
  /**
   * What applying this pack would need to download first, without applying it.
   *
   * Lets the UI ask before it acts: applying writes the mod list and only then
   * downloads, so an unattended failure leaves a server whose list names mods it
   * does not have. Asking first means that state is never created by surprise.
   */
  plan(id: string, serverId: string): { mods: string[]; missing: string[] } {
    const pack = this.repo.getById(id);
    if (!pack) throw new NotFoundError('Modpack');
    const server = this.servers.getById(serverId);
    if (!server) throw new NotFoundError('Server');
    const entries: ModEntry[] = this.repo
      .listMods(id)
      .map((m) => ({ name: m.name, enabled: m.enabled === 1, version: m.version ?? undefined }));
    return {
      mods: entries.map((e) => e.name),
      missing: this.mods.missingMods(serverId, entries),
    };
  }

  async apply(id: string, serverId: string, onProgress?: ModProgress): Promise<ApplyResult> {
    const pack = this.repo.getById(id);
    if (!pack) throw new NotFoundError('Modpack');
    const server = this.servers.getById(serverId);
    if (!server) throw new NotFoundError('Server');

    const entries: ModEntry[] = this.repo.listMods(id).map((m) => ({
      name: m.name,
      enabled: m.enabled === 1,
      version: m.version ?? undefined,
    }));
    const result = await this.mods.applyModList(server, entries, onProgress);
    this.servers.setAppliedModpack(serverId, id);
    return { serverId, downloaded: result.downloaded, errors: result.errors };
  }

  /**
   * Re-apply a pack to every server currently marked as using it (explicit).
   *
   * Progress is reported across the whole run rather than per server — the caller
   * is showing one bar for one button press, so each server's downloads continue
   * the same count instead of restarting it.
   */
  async applyToAllUsing(id: string, onProgress?: ModProgress): Promise<ApplyResult[]> {
    if (!this.repo.getById(id)) throw new NotFoundError('Modpack');
    const targets = this.servers.listByModpack(id);
    const perServer = this.repo.countMods(id);
    const out: ApplyResult[] = [];
    for (const [i, s] of targets.entries()) {
      const offset = i * perServer;
      out.push(
        await this.apply(id, s.id, (p) =>
          onProgress?.({
            current: p.current,
            completed: offset + p.completed,
            total: perServer * targets.length,
          }),
        ),
      );
    }
    return out;
  }

  exportManifest(id: string): ModpackManifest {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Modpack');
    return {
      name: row.name,
      description: row.description,
      factorioVersion: row.factorio_version,
      mods: this.modsDto(id),
    };
  }

  /**
   * Seed the built-in "Space Age" modpack. Idempotent by name — if a pack named
   * "Space Age" already exists (or the caller has seeded before), it does nothing,
   * so a user who deletes it won't have it reappear (see the kv guard in startup).
   */
  seedSpaceAge(): void {
    if (this.repo.getByName(SPACE_AGE_PACK.name)) return;
    const pack = this.create({ name: SPACE_AGE_PACK.name, description: SPACE_AGE_PACK.description });
    this.repo.replaceMods(pack.id, SPACE_AGE_PACK.mods);
  }

  /** Create a pack from an exported manifest (name auto-deduped on clash). */
  importManifest(manifest: ModpackManifest): ModpackDto {
    if (!manifest?.name || !Array.isArray(manifest.mods)) {
      throw new ValidationError('Invalid modpack manifest');
    }
    const pack = this.create(
      { name: manifest.name, description: manifest.description, factorioVersion: manifest.factorioVersion },
      true,
    );
    this.repo.replaceMods(
      pack.id,
      manifest.mods.map((m) => ({ name: m.name, enabled: m.enabled, version: m.version ?? null })),
    );
    return this.toDto(this.repo.getById(pack.id)!);
  }
}
