import winston, { type Logger } from 'winston';

const { combine, timestamp, printf } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, label }) => {
  const tag = label ? `[${label}] ` : '';
  return `${timestamp} ${level}: ${tag}${message}`;
});

// Read directly from process.env rather than ../config.js: config.js validates
// required vars like ADMIN_PASSWORD at import time, and this module needs to
// stay loadable (e.g. from tests) without pulling that in.
const root = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), consoleFormat),
  transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn'] })],
});

/**
 * A logger scoped to one module/subsystem: every line it writes is tagged
 * `[label]`, matching the `[tag] message` convention the console.* calls used
 * before this. Call once per file/class with a name for that subsystem
 * (`docker`, `dns`, `manager`, ...) and use the result like `console.*`.
 */
export function getLogger(label: string): Logger {
  return root.child({ label });
}
