import type { Writable } from 'node:stream';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Cloud Logging expects WARNING, not warn.
const SEVERITY: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

// Core keys always win, with one exception: a caller severity of 'critical' becomes the
// Cloud Logging severity CRITICAL so alerts can filter on it. Callers pass exception
// details as `message`, which Cloud Logging reads as the log text, so that one field is
// emitted as `error_message`. Any other collision is kept as `field_<key>`, not dropped.
const CORE_KEYS: ReadonlySet<string> = new Set(['time', 'level', 'severity', 'msg', 'message']);

const CRITICAL_SEVERITY = 'critical';

function withoutCoreKeyCollisions(fields: LogFields | undefined): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key === 'message') safe.error_message = value;
    else if (key === 'severity' && value === CRITICAL_SEVERITY) continue;
    else safe[CORE_KEYS.has(key) ? `field_${key}` : key] = value;
  }
  return safe;
}

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

export function createLogger(level: LogLevel, stream: Writable = process.stdout): Logger {
  function write(eventLevel: LogLevel, message: string, fields?: LogFields): void {
    if (RANK[eventLevel] < RANK[level]) return;
    const event = redact({
      time: new Date().toISOString(),
      level: eventLevel,
      severity: fields?.severity === CRITICAL_SEVERITY ? 'CRITICAL' : SEVERITY[eventLevel],
      msg: message,
      message,
      ...withoutCoreKeyCollisions(fields),
    });
    stream.write(`${JSON.stringify(event)}\n`);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
