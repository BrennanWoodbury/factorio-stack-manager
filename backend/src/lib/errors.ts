/** Application errors that map to specific HTTP responses (see error middleware). */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class PortPoolExhaustedError extends AppError {
  constructor(kind: string) {
    super(`No free ${kind} port available in the configured range`, 409, 'PORT_POOL_EXHAUSTED');
  }
}

export class DuplicateSubdomainError extends AppError {
  constructor(subdomain: string) {
    super(`Subdomain "${subdomain}" is already in use`, 409, 'DUPLICATE_SUBDOMAIN');
  }
}

export class DuplicateModpackError extends AppError {
  constructor(name: string) {
    super(`A modpack named "${name}" already exists`, 409, 'DUPLICATE_MODPACK');
  }
}

export class DuplicateMapGenTemplateError extends AppError {
  constructor(name: string) {
    super(`A map template named "${name}" already exists`, 409, 'DUPLICATE_MAP_TEMPLATE');
  }
}

export class DnsSettingsConflictError extends AppError {
  constructor() {
    super(
      'DNS settings changed in another session. Reload the latest values and test them again before saving.',
      409,
      'DNS_SETTINGS_CONFLICT',
    );
  }
}

export class ModJobBusyError extends AppError {
  constructor() {
    super(
      'A mod download is already running here — wait for it to finish before starting another',
      409,
      'MOD_JOB_BUSY',
    );
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(`${what} not found`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION');
  }
}

export class DockerError extends AppError {
  constructor(message: string) {
    super(`Docker error: ${message}`, 502, 'DOCKER_ERROR');
  }
}

export class CloudflareError extends AppError {
  constructor(message: string) {
    super(`Cloudflare API error: ${message}`, 502, 'CLOUDFLARE_ERROR');
  }
}

export class RconError extends AppError {
  constructor(message: string) {
    super(`RCON error: ${message}`, 502, 'RCON_ERROR');
  }
}
