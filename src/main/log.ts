import fs from 'node:fs';
import path from 'node:path';

// Small structured logger: console + rotating file in userData/logs.
// Never log secrets: callers pass only non-sensitive context.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let logFile: string | null = null;
let minLevel: Level = process.env.NOVA_LOG_LEVEL === 'debug' ? 'debug' : 'info';
const MAX_BYTES = 2 * 1024 * 1024;

export function initFileLogging(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'nova.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, path.join(dir, 'nova.1.log'));
    }
  } catch {
    // rotation is best-effort
  }
  return logFile;
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${
    extra === undefined ? '' : ' ' + safeStringify(extra)
  }`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      // ignore disk errors for logging
    }
  }
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
