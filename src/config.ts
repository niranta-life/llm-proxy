import type { LogLevel } from './logger.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const REQUIRED_ENV = [
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'MIGRATOR_USER',
  'MIGRATOR_PASSWORD',
  'AUTH_USER',
  'AUTH_PASSWORD',
  'RUNTIME_USER',
  'RUNTIME_PASSWORD',
] as const;

const ROLE_USERS = {
  MIGRATOR_USER: 'llm_migrator',
  AUTH_USER: 'llm_auth',
  RUNTIME_USER: 'llm_runtime',
} as const;

export class ConfigError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`invalid configuration: ${errors.join(', ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

export type DatabaseRole = 'migrator' | 'auth' | 'runtime';

export type Config = {
  host: string;
  port: number;
  logLevel: LogLevel;
  database: {
    host: string;
    port: number;
    name: string;
  };
  roles: Record<DatabaseRole, { user: string; password: string }>;
};

function readRequired(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readPort(value: string, label: string, errors: string[]): number | undefined {
  if (!/^\d+$/.test(value)) {
    errors.push(`${label} must be an integer from 1 to 65535`);
    return undefined;
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    errors.push(`${label} must be an integer from 1 to 65535`);
    return undefined;
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const errors: string[] = [];

  for (const key of REQUIRED_ENV) {
    if (readRequired(env, key) === undefined) errors.push(`missing ${key}`);
  }

  for (const [key, expected] of Object.entries(ROLE_USERS)) {
    const value = readRequired(env, key);
    if (value !== undefined && value !== expected) errors.push(`${key} must be ${expected}`);
  }

  const portText = readRequired(env, 'PORT') ?? '8080';
  const port = readPort(portText, 'PORT', errors);
  const databasePortText = readRequired(env, 'DATABASE_PORT');
  const databasePort =
    databasePortText === undefined ? undefined : readPort(databasePortText, 'DATABASE_PORT', errors);

  const logLevelText = readRequired(env, 'LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.includes(logLevelText as LogLevel)) {
    errors.push('LOG_LEVEL must be debug, info, warn, or error');
  }

  const host = readRequired(env, 'HOST') ?? '0.0.0.0';

  if (errors.length > 0 || port === undefined || databasePort === undefined) {
    throw new ConfigError(errors);
  }

  const databaseHost = readRequired(env, 'DATABASE_HOST');
  const databaseName = readRequired(env, 'DATABASE_NAME');
  const migratorPassword = readRequired(env, 'MIGRATOR_PASSWORD');
  const authPassword = readRequired(env, 'AUTH_PASSWORD');
  const runtimePassword = readRequired(env, 'RUNTIME_PASSWORD');
  if (
    databaseHost === undefined ||
    databaseName === undefined ||
    migratorPassword === undefined ||
    authPassword === undefined ||
    runtimePassword === undefined
  ) {
    throw new ConfigError(errors);
  }

  return {
    host,
    port,
    logLevel: logLevelText as LogLevel,
    database: {
      host: databaseHost,
      port: databasePort,
      name: databaseName,
    },
    roles: {
      migrator: { user: 'llm_migrator', password: migratorPassword },
      auth: { user: 'llm_auth', password: authPassword },
      runtime: { user: 'llm_runtime', password: runtimePassword },
    },
  };
}
