import type { LogLevel } from './logger.js';

export const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';

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
  inferenceEnabled: boolean;
  providerCredentialKey: Buffer | null;
  previousCredentialKeys: Buffer[];
  openAiBaseUrl: string;
  maxActiveStreams: number;
  maxStreamsPerTenant: number;
  streamShutdownDrainMs: number;
  database: {
    host: string;
    port: number;
    name: string;
  };
  roles: Record<DatabaseRole, { user: string; password: string }>;
};

function readInferenceEnabled(env: NodeJS.ProcessEnv, errors: string[]): boolean {
  const value = env.INFERENCE_ENABLED;
  if (value === undefined || value.trim() === '') return false;
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  errors.push('INFERENCE_ENABLED must be true or false');
  return false;
}

function readOpenAiBaseUrl(env: NodeJS.ProcessEnv, errors: string[]): string {
  const value = readRequired(env, 'OPENAI_BASE_URL') ?? OFFICIAL_OPENAI_BASE_URL;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
      errors.push('OPENAI_BASE_URL must be an http or https URL');
    } else if (url.username !== '' || url.password !== '') {
      errors.push('OPENAI_BASE_URL must not include credentials');
    }
  } catch {
    errors.push('OPENAI_BASE_URL must be an http or https URL');
  }
  return value.replace(/\/+$/, '');
}

function decodeKey(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return decoded.length === 32 ? decoded : null;
}

function readCredentialKey(
  env: NodeJS.ProcessEnv,
  inferenceEnabled: boolean,
  errors: string[],
): Buffer | null {
  const text = readRequired(env, 'PROVIDER_CREDENTIAL_KEY');
  if (text === undefined) {
    if (inferenceEnabled) errors.push('missing PROVIDER_CREDENTIAL_KEY');
    return null;
  }
  const decoded = decodeKey(text);
  if (decoded === null) {
    errors.push('PROVIDER_CREDENTIAL_KEY must be 32 bytes, base64-encoded');
    return null;
  }
  return decoded;
}

function readPreviousCredentialKeys(env: NodeJS.ProcessEnv, errors: string[]): Buffer[] {
  const text = readRequired(env, 'PROVIDER_CREDENTIAL_KEY_PREVIOUS');
  if (text === undefined) return [];
  const parts = text.split(',').map((item) => item.trim());
  if (parts.length === 0 || parts.some((item) => item.length === 0)) {
    errors.push('PROVIDER_CREDENTIAL_KEY_PREVIOUS must be 32-byte keys, base64-encoded, comma-separated');
    return [];
  }
  const keys: Buffer[] = [];
  for (const part of parts) {
    const decoded = decodeKey(part);
    if (decoded === null) {
      errors.push('PROVIDER_CREDENTIAL_KEY_PREVIOUS must be 32-byte keys, base64-encoded, comma-separated');
      return [];
    }
    keys.push(decoded);
  }
  return keys;
}

function readRequired(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  min: number,
  max: number,
  errors: string[],
): number {
  const text = readRequired(env, key) ?? fallback;
  const label = `${key} must be an integer from ${min} to ${max}`;
  if (!/^\d+$/.test(text)) {
    errors.push(label);
    return Number(fallback);
  }
  const value = Number(text);
  if (value < min || value > max) {
    errors.push(label);
    return Number(fallback);
  }
  return value;
}

function readMaxActiveStreams(env: NodeJS.ProcessEnv, errors: string[]): number {
  return readBoundedInteger(env, 'MAX_ACTIVE_STREAMS', '32', 1, 10_000, errors);
}

function readMaxStreamsPerTenant(env: NodeJS.ProcessEnv, errors: string[]): number {
  return readBoundedInteger(env, 'MAX_STREAMS_PER_TENANT', '32', 1, 10_000, errors);
}

function readStreamShutdownDrainMs(env: NodeJS.ProcessEnv, errors: string[]): number {
  return readBoundedInteger(env, 'STREAM_SHUTDOWN_DRAIN_MS', '5000', 0, 600_000, errors);
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
  const inferenceEnabled = readInferenceEnabled(env, errors);
  const openAiBaseUrl = readOpenAiBaseUrl(env, errors);
  const providerCredentialKey = readCredentialKey(env, inferenceEnabled, errors);
  const previousCredentialKeys = readPreviousCredentialKeys(env, errors);
  const maxActiveStreams = readMaxActiveStreams(env, errors);
  const maxStreamsPerTenant = readMaxStreamsPerTenant(env, errors);
  const streamShutdownDrainMs = readStreamShutdownDrainMs(env, errors);

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
    inferenceEnabled,
    providerCredentialKey,
    previousCredentialKeys,
    openAiBaseUrl,
    maxActiveStreams,
    maxStreamsPerTenant,
    streamShutdownDrainMs,
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
