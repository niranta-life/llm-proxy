import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { createCredentialStore } from './credentials.js';
import {
  listTenantInference,
  registerAnthropicConnection,
  registerModelDeployment,
  registerOpenAiConnection,
  registerProviderDeployment,
  replaceAnthropicCredential,
  replaceOpenAiCredential,
  setDeploymentStreaming,
  setModelAlias,
  setModelDeploymentEnabled,
  setOpenAiConnectionEnabled,
  setProviderConnectionEnabled,
  setTenantStreamingEnabled,
} from './db/inference-admin.js';
import { createPool } from './db/pools.js';
import { addTenantKey, provisionTenant, revokeTenantKey } from './db/provision.js';
import { createLogger } from './logger.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITIES = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'user',
  'response_format_text',
]);

type Flags = {
  name?: string;
  'tenant-id'?: string;
  'key-id'?: string;
  label?: string;
  'api-key'?: string;
  'upstream-model'?: string;
  'timeout-ms'?: string;
  capabilities?: string;
  enabled?: string;
  alias?: string;
  deployment?: string;
  endpoint?: string;
  'workspace-id'?: string;
  provider?: string;
  'default-max-output-tokens'?: string;
  'connect-timeout-ms'?: string;
  'idle-timeout-ms'?: string;
  'total-timeout-ms'?: string;
  'backpressure-timeout-ms'?: string;
};

function requireTenant(values: Flags): string | undefined {
  const tenantId = values['tenant-id'] ?? '';
  return UUID.test(tenantId) ? tenantId : undefined;
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseTimeout(value: string | undefined): number | null | undefined {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (parsed < 100 || parsed > 600000) return undefined;
  return parsed;
}

function parseCapabilities(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return [];
  const parts = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (parts.length !== new Set(parts).size || parts.some((item) => !CAPABILITIES.has(item))) return undefined;
  return parts;
}

function credentialStore(key: Buffer | null) {
  if (key === null) throw new Error('PROVIDER_CREDENTIAL_KEY is required');
  return createCredentialStore(key);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const logger = createLogger('error', process.stderr);
    if (error instanceof ConfigError) {
      logger.error('invalid configuration', { errors: error.errors });
    } else {
      logger.error('invalid configuration');
    }
    process.exit(1);
  }

  const logger = createLogger(config.logLevel, process.stderr);
  let command = '';
  let values: Flags;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        name: { type: 'string' },
        'tenant-id': { type: 'string' },
        'key-id': { type: 'string' },
        label: { type: 'string' },
        'api-key': { type: 'string' },
        'upstream-model': { type: 'string' },
        'timeout-ms': { type: 'string' },
        capabilities: { type: 'string' },
        enabled: { type: 'string' },
        alias: { type: 'string' },
        deployment: { type: 'string' },
        endpoint: { type: 'string' },
        'workspace-id': { type: 'string' },
        provider: { type: 'string' },
        'default-max-output-tokens': { type: 'string' },
        'connect-timeout-ms': { type: 'string' },
        'idle-timeout-ms': { type: 'string' },
        'total-timeout-ms': { type: 'string' },
        'backpressure-timeout-ms': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    command = parsed.positionals[0] ?? '';
    values = parsed.values;
  } catch {
    logger.error('invalid command arguments');
    process.exit(1);
  }

  const pool = createPool(config, 'migrator', logger, 1);
  try {
    if (command === 'provision-tenant') {
      const name = values.name?.trim() ?? '';
      if (name.length === 0) {
        logger.error('name is required');
        process.exitCode = 1;
        return;
      }
      const created = await provisionTenant(pool, { name, label: values.label });
      process.stdout.write(`${JSON.stringify(created)}\n`);
      return;
    }

    if (command === 'add-key') {
      const tenantId = requireTenant(values);
      if (tenantId === undefined) {
        logger.error('tenant-id is required');
        process.exitCode = 1;
        return;
      }
      const created = await addTenantKey(pool, { tenantId, label: values.label });
      process.stdout.write(`${JSON.stringify(created)}\n`);
      return;
    }

    if (command === 'revoke-key') {
      const tenantId = requireTenant(values);
      const keyId = values['key-id'] ?? '';
      if (tenantId === undefined || !UUID.test(keyId)) {
        logger.error('tenant-id and key-id are required');
        process.exitCode = 1;
        return;
      }
      const revoked = await revokeTenantKey(pool, { tenantId, keyId });
      if (!revoked) {
        logger.error('key was not revoked');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify({ tenantId, keyId, revoked: true })}\n`);
      return;
    }

    if (command === 'register-anthropic-connection' || command === 'set-anthropic-credential') {
      const tenantId = requireTenant(values);
      const apiKey = values['api-key'] ?? '';
      const endpoint = values.endpoint?.trim() ?? '';
      const workspaceId = values['workspace-id']?.trim() ?? '';
      if (tenantId === undefined || apiKey.length === 0 || (command === 'register-anthropic-connection' && endpoint.length === 0)) {
        logger.error('tenant-id, api-key, and endpoint are required');
        process.exitCode = 1;
        return;
      }
      const protectedCredential = credentialStore(config.providerCredentialKey).protect(apiKey);
      if (command === 'register-anthropic-connection') {
        const created = await registerAnthropicConnection(
          pool,
          tenantId,
          protectedCredential,
          endpoint,
          workspaceId.length === 0 ? null : workspaceId,
        );
        process.stdout.write(
          `${JSON.stringify({ ...created, tenantId, provider: 'anthropic', enabled: true })}\n`,
        );
        return;
      }
      const credentialVersion = await replaceAnthropicCredential(pool, tenantId, protectedCredential);
      process.stdout.write(`${JSON.stringify({ tenantId, provider: 'anthropic', credentialVersion })}\n`);
      return;
    }

    if (command === 'register-openai-connection' || command === 'set-openai-credential') {
      const tenantId = requireTenant(values);
      const apiKey = values['api-key'] ?? '';
      if (tenantId === undefined || apiKey.length === 0) {
        logger.error('tenant-id and api-key are required');
        process.exitCode = 1;
        return;
      }
      const protectedCredential = credentialStore(config.providerCredentialKey).protect(apiKey);
      if (command === 'register-openai-connection') {
        const created = await registerOpenAiConnection(pool, tenantId, protectedCredential);
        process.stdout.write(
          `${JSON.stringify({ ...created, tenantId, provider: 'openai', enabled: true })}\n`,
        );
        return;
      }
      const credentialVersion = await replaceOpenAiCredential(pool, tenantId, protectedCredential);
      process.stdout.write(`${JSON.stringify({ tenantId, credentialVersion })}\n`);
      return;
    }

    if (command === 'set-connection-enabled') {
      const tenantId = requireTenant(values);
      const enabled = parseEnabled(values.enabled);
      if (tenantId === undefined || enabled === undefined) {
        logger.error('tenant-id and enabled are required');
        process.exitCode = 1;
        return;
      }
      const provider = values.provider ?? 'openai';
      const credentialVersion = provider === 'openai'
        ? await setOpenAiConnectionEnabled(pool, tenantId, enabled)
        : await setProviderConnectionEnabled(pool, tenantId, provider, enabled);
      process.stdout.write(`${JSON.stringify({ tenantId, provider, enabled, credentialVersion })}\n`);
      return;
    }

    if (command === 'register-deployment') {
      const tenantId = requireTenant(values);
      const name = values.name?.trim() ?? '';
      const upstreamModel = values['upstream-model']?.trim() ?? '';
      const timeoutMs = Number(values['timeout-ms']);
      const capabilities = parseCapabilities(values.capabilities);
      const enabled = parseEnabled(values.enabled) ?? false;
      const provider = values.provider ?? 'openai';
      const defaultMaxText = values['default-max-output-tokens'];
      const defaultMaxOutputTokens = defaultMaxText === undefined ? null : Number(defaultMaxText);
      if (
        tenantId === undefined ||
        name.length === 0 ||
        upstreamModel.length === 0 ||
        !Number.isInteger(timeoutMs) ||
        capabilities === undefined ||
        (provider !== 'openai' && provider !== 'anthropic') ||
        (values.enabled !== undefined && parseEnabled(values.enabled) === undefined) ||
        (defaultMaxOutputTokens !== null && !Number.isInteger(defaultMaxOutputTokens)) ||
        (provider === 'openai' && defaultMaxText !== undefined)
      ) {
        logger.error('deployment arguments are invalid');
        process.exitCode = 1;
        return;
      }
      if (provider === 'anthropic') {
        const created = await registerProviderDeployment(pool, {
          tenantId,
          provider,
          name,
          upstreamModel,
          timeoutMs,
          capabilities,
          enabled,
          defaultMaxOutputTokens,
        });
        process.stdout.write(`${JSON.stringify({ tenantId, provider, name, enabled, ...created })}\n`);
        return;
      }
      const created = await registerModelDeployment(pool, {
        tenantId,
        name,
        upstreamModel,
        timeoutMs,
        capabilities,
        enabled,
      });
      process.stdout.write(`${JSON.stringify({ tenantId, name, enabled, ...created })}\n`);
      return;
    }

    if (command === 'set-deployment-enabled') {
      const tenantId = requireTenant(values);
      const name = values.name?.trim() ?? '';
      const enabled = parseEnabled(values.enabled);
      if (tenantId === undefined || name.length === 0 || enabled === undefined) {
        logger.error('tenant-id, name, and enabled are required');
        process.exitCode = 1;
        return;
      }
      const configVersion = await setModelDeploymentEnabled(pool, tenantId, name, enabled);
      process.stdout.write(`${JSON.stringify({ tenantId, name, enabled, configVersion })}\n`);
      return;
    }

    if (command === 'set-alias') {
      const tenantId = requireTenant(values);
      const alias = values.alias ?? '';
      const deployment = values.deployment?.trim() ?? '';
      if (tenantId === undefined || alias !== 'auto' || deployment.length === 0) {
        logger.error('tenant-id, alias auto, and deployment are required');
        process.exitCode = 1;
        return;
      }
      const aliasId = await setModelAlias(pool, tenantId, alias, deployment);
      process.stdout.write(`${JSON.stringify({ tenantId, alias, deployment, aliasId })}\n`);
      return;
    }

    if (command === 'set-tenant-streaming') {
      const tenantId = requireTenant(values);
      const enabled = parseEnabled(values.enabled);
      if (tenantId === undefined || enabled === undefined) {
        logger.error('tenant-id and enabled are required');
        process.exitCode = 1;
        return;
      }
      const streamingEnabled = await setTenantStreamingEnabled(pool, tenantId, enabled);
      process.stdout.write(`${JSON.stringify({ tenantId, streamingEnabled })}\n`);
      return;
    }

    if (command === 'set-deployment-streaming') {
      const tenantId = requireTenant(values);
      const name = values.deployment?.trim() ?? '';
      const enabled = parseEnabled(values.enabled);
      const connectTimeoutMs = parseTimeout(values['connect-timeout-ms']);
      const idleTimeoutMs = parseTimeout(values['idle-timeout-ms']);
      const totalTimeoutMs = parseTimeout(values['total-timeout-ms']);
      const backpressureTimeoutMs = parseTimeout(values['backpressure-timeout-ms']);
      if (
        tenantId === undefined ||
        name.length === 0 ||
        enabled === undefined ||
        connectTimeoutMs === undefined ||
        idleTimeoutMs === undefined ||
        totalTimeoutMs === undefined ||
        backpressureTimeoutMs === undefined
      ) {
        logger.error('deployment streaming arguments are invalid');
        process.exitCode = 1;
        return;
      }
      const configVersion = await setDeploymentStreaming(pool, {
        tenantId,
        name,
        enabled,
        connectTimeoutMs,
        idleTimeoutMs,
        totalTimeoutMs,
        backpressureTimeoutMs,
      });
      process.stdout.write(`${JSON.stringify({ tenantId, deployment: name, streamingEnabled: enabled, configVersion })}\n`);
      return;
    }

    if (command === 'list-inference') {
      const tenantId = requireTenant(values);
      if (tenantId === undefined) {
        logger.error('tenant-id is required');
        process.exitCode = 1;
        return;
      }
      const listing = await listTenantInference(pool, tenantId);
      process.stdout.write(`${JSON.stringify(listing)}\n`);
      return;
    }

    logger.error('unknown command');
    process.exitCode = 1;
  } catch (error) {
    logger.error('command failed', { message: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
