import type { Writable } from 'node:stream';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
      msg: message,
      ...fields,
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
