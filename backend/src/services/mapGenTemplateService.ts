import { randomUUID } from 'node:crypto';
import { MapGenTemplatesRepo, type MapGenTemplateRow } from '../db/mapGenTemplatesRepo.js';
import { ServersRepo } from '../db/serversRepo.js';
import { serverFiles } from './serverFiles.js';
import { DuplicateMapGenTemplateError, NotFoundError, ValidationError } from '../lib/errors.js';

type Settings = Record<string, unknown>;

export interface MapGenTemplateDto {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export interface MapGenTemplateDetail extends MapGenTemplateDto {
  settings: Settings;
}
export interface MapGenTemplateManifest {
  name: string;
  description?: string;
  settings: Settings;
}

function isPlainObject(v: unknown): v is Settings {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The shared map-generation template registry: named, reusable map-gen-settings
 * presets (ore/water/terrain sliders, etc.) you build once and pick when creating a
 * server. A template holds only a settings object — no server reference. Selecting
 * one at create time copies its settings onto the new server; editing a template
 * afterwards does NOT retroactively change servers created from it. Templates are
 * exportable/importable as JSON manifests for sharing.
 */
export class MapGenTemplateService {
  constructor(
    private readonly repo: MapGenTemplatesRepo,
    private readonly servers: ServersRepo,
  ) {}

  /** The built-in default map-gen settings (image defaults), for a blank editor. */
  defaults(): Settings {
    return serverFiles.defaultMapGenSettings();
  }

  private toDto(row: MapGenTemplateRow): MapGenTemplateDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseSettings(row: MapGenTemplateRow): Settings {
    try {
      const s = JSON.parse(row.settings_json);
      return isPlainObject(s) ? s : {};
    } catch {
      return {};
    }
  }

  /**
   * Templates with their settings.
   *
   * The settings are included so a client holding a settings object can tell which
   * template it came from: the editor is handed raw settings (from a draft being
   * resumed, or the global default template applied at creation) with no record of
   * their origin, and would otherwise have to claim it knows nothing.
   */
  list(): MapGenTemplateDetail[] {
    return this.repo.list().map((r) => ({ ...this.toDto(r), settings: this.parseSettings(r) }));
  }

  get(id: string): MapGenTemplateDetail {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Map template');
    return { ...this.toDto(row), settings: this.parseSettings(row) };
  }

  /** The stored settings for a template (for applying at server-create time). */
  settingsOf(id: string): Settings {
    return this.get(id).settings;
  }

  /** Create a template. `dedupe` auto-suffixes the name so imports never clash. */
  create(
    input: { name: string; description?: string; settings: Settings },
    dedupe = false,
  ): MapGenTemplateDetail {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Template name is required');
    if (!isPlainObject(input.settings)) throw new ValidationError('Template settings must be an object');
    let finalName = name;
    if (this.repo.getByName(finalName)) {
      if (!dedupe) throw new DuplicateMapGenTemplateError(finalName);
      let n = 2;
      while (this.repo.getByName(`${name} (${n})`)) n++;
      finalName = `${name} (${n})`;
    }
    const id = randomUUID().slice(0, 8);
    this.repo.insert({
      id,
      name: finalName,
      description: input.description?.trim() ?? '',
      settings_json: JSON.stringify(input.settings),
    });
    return this.get(id);
  }

  update(
    id: string,
    fields: { name?: string; description?: string; settings?: Settings },
  ): MapGenTemplateDetail {
    const row = this.repo.getById(id);
    if (!row) throw new NotFoundError('Map template');
    const patch: Partial<Pick<MapGenTemplateRow, 'name' | 'description' | 'settings_json'>> = {};
    if (fields.name !== undefined) {
      const name = fields.name.trim();
      if (!name) throw new ValidationError('Template name is required');
      const existing = this.repo.getByName(name);
      if (existing && existing.id !== id) throw new DuplicateMapGenTemplateError(name);
      patch.name = name;
    }
    if (fields.description !== undefined) patch.description = fields.description.trim();
    if (fields.settings !== undefined) {
      if (!isPlainObject(fields.settings)) throw new ValidationError('Template settings must be an object');
      patch.settings_json = JSON.stringify(fields.settings);
    }
    this.repo.update(id, patch);
    return this.get(id);
  }

  delete(id: string): void {
    if (!this.repo.getById(id)) throw new NotFoundError('Map template');
    this.repo.delete(id);
  }

  /** Snapshot a server's current (effective) map-gen settings into a new template. */
  createFromServer(serverId: string, name: string): MapGenTemplateDetail {
    const server = this.servers.getById(serverId);
    if (!server) throw new NotFoundError('Server');
    return this.create({ name, settings: serverFiles.getMapGenSettings(server) });
  }

  exportManifest(id: string): MapGenTemplateManifest {
    const t = this.get(id);
    return { name: t.name, description: t.description, settings: t.settings };
  }

  /** Create a template from an exported manifest (name auto-deduped on clash). */
  importManifest(manifest: MapGenTemplateManifest): MapGenTemplateDetail {
    if (!manifest?.name || !isPlainObject(manifest.settings)) {
      throw new ValidationError('Invalid map template manifest');
    }
    return this.create(
      { name: manifest.name, description: manifest.description, settings: manifest.settings },
      true,
    );
  }

  /**
   * Seed a couple of handy built-in templates. Idempotent by name and guarded by a
   * kv flag at startup, so a user who deletes them won't have them reappear.
   */
  seedDefaults(): void {
    const base = serverFiles.defaultMapGenSettings();
    const withOreRichness = (mult: number): Settings => {
      const ac = base.autoplace_controls as Record<string, Record<string, number>>;
      const ores = ['coal', 'stone', 'copper-ore', 'iron-ore', 'uranium-ore', 'crude-oil'];
      const autoplace: Record<string, unknown> = { ...ac };
      for (const o of ores) autoplace[o] = { frequency: 1, size: 1.5, richness: mult };
      return { ...base, autoplace_controls: autoplace };
    };
    const presets: { name: string; description: string; settings: Settings }[] = [
      {
        name: 'Rich resources',
        description: 'Bigger, richer ore patches (size ×1.5, richness ×3) — less time hunting for ore.',
        settings: withOreRichness(3),
      },
      {
        name: 'Peaceful',
        description: 'Peaceful mode on and enemy bases sparse — build without biter pressure.',
        settings: {
          ...base,
          peaceful_mode: true,
          autoplace_controls: {
            ...(base.autoplace_controls as Record<string, unknown>),
            'enemy-base': { frequency: 0.5, size: 0.5 },
          },
        },
      },
    ];
    for (const p of presets) {
      if (this.repo.getByName(p.name)) continue;
      this.create(p);
    }
  }
}
