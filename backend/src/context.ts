import type { AppConfig } from './config.js';
import { openDb, type DB } from './db/index.js';
import { ServersRepo } from './db/serversRepo.js';
import { ModpacksRepo } from './db/modpacksRepo.js';
import { MapGenTemplatesRepo } from './db/mapGenTemplatesRepo.js';
import { PortAllocator } from './services/portAllocator.js';
import { ModpackService } from './services/modpackService.js';
import { MapGenTemplateService } from './services/mapGenTemplateService.js';
import { DockerService } from './services/dockerService.js';
import { DnsService } from './services/dnsService.js';
import { RconService } from './services/rconService.js';
import { ServerManager } from './services/serverManager.js';
import { ModService } from './services/modService.js';
import { ModJobService } from './services/modJobService.js';
import { ImageProfileService } from './services/imageProfile.js';
import { DdnsJob } from './jobs/ddns.js';
import { BackupJob } from './jobs/backup.js';
import { DraftPruneJob } from './jobs/draftPrune.js';
import { UpdateCheckJob } from './jobs/updateCheck.js';
import { TelemetryJob } from './jobs/telemetry.js';

/** Wires up all singletons from config. Built once at startup. */
export interface AppContext {
  config: AppConfig;
  db: DB;
  repo: ServersRepo;
  allocator: PortAllocator;
  docker: DockerService;
  dns: DnsService;
  rcon: RconService;
  mods: ModService;
  modJobs: ModJobService;
  modpacks: ModpackService;
  mapGenTemplates: MapGenTemplateService;
  manager: ServerManager;
  ddns: DdnsJob;
  backups: BackupJob;
  draftPrune: DraftPruneJob;
  updateCheck: UpdateCheckJob;
  telemetry: TelemetryJob;
}

export function buildContext(config: AppConfig): AppContext {
  const db = openDb(config.dbPath);
  const repo = new ServersRepo(db);
  const allocator = new PortAllocator(db, config.gamePortRange, config.rconPortRange);
  const docker = new DockerService(config);
  const dns = new DnsService(db);
  const rcon = new RconService(config);
  // Shared so mod downloads and the lifecycle agree on what the image ships.
  const imageProfiles = new ImageProfileService(docker);
  const mods = new ModService(db, imageProfiles);
  // Long mod downloads run here rather than inside the request that asked for them.
  const modJobs = new ModJobService();
  const modpacksRepo = new ModpacksRepo(db);
  const modpacks = new ModpackService(modpacksRepo, repo, mods);
  const mapGenTemplates = new MapGenTemplateService(new MapGenTemplatesRepo(db), repo);
  const manager = new ServerManager(db, repo, allocator, docker, dns, rcon, config, mods, imageProfiles);
  const ddns = new DdnsJob(dns);
  const backups = new BackupJob(manager);
  const draftPrune = new DraftPruneJob(manager);
  const updateCheck = new UpdateCheckJob(config);
  const telemetry = new TelemetryJob(config, db, repo);
  return { config, db, repo, allocator, docker, dns, rcon, mods, modJobs, modpacks, mapGenTemplates, manager, ddns, backups, draftPrune, updateCheck, telemetry };
}
