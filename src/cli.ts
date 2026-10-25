import type { Pool } from 'pg';
import { parseArgs } from 'node:util';
import { openInteractiveInput, runInteractiveSession } from './cli-interactive.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createCredentialStore } from './credentials.js';
import {
  listTenantInference,
  registerAnthropicConnection,
  registerModelDeployment,
  registerOpenAiConnection,
  registerOpenRouterDeployment,
  registerProviderDeployment,
  loadVertexOperatorConnection,
  registerRegistryConnection,
  replaceAnthropicCredential,
  replaceOpenAiCredential,
  approvePrivateEndpoint,
  setDeploymentConcurrency,
  setDeploymentHealth,
  setDeploymentStreaming,
  setDeploymentValidation,
  setModelAlias,
  setModelDeploymentEnabled,
  setOpenAiConnectionEnabled,
  setProviderConnectionEnabled,
  setTenantStreamingEnabled,
} from './db/inference-admin.js';
import { listPrivateModels, probePrivateHealth } from './inference/private-serve.js';
import { normalizeApproval } from './inference/private.js';
import { prepareRegistryConnection } from './inference/registry.js';
import { defaultVertexClientFactory, type VertexApiVersion, type VertexAuthMode, type VertexClientSpec } from './inference/vertex-client.js';
import { testVertexInference, validateVertexAccess, validateVertexCredential } from './inference/vertex-probe.js';
import { createPool } from './db/pools.js';
import {
  recoverTenantBudget,
  setApiKeyLimits,
  setConnectionLimit,
  setDeploymentLimit,
  setTenantBudget,
  setTenantLimits,
} from './db/admission.js';
import { resetDeploymentBreaker, setDeploymentBreaker } from './db/breaker.js';
import { setDeploymentExecutionPolicy } from './db/execution-policy.js';
import {
  setDeploymentContextLimit,
  setDeploymentDataCollection,
  setFallbackPolicy,
  showFallbackPolicy,
} from './db/fallback-policy.js';
import { reconcileAttemptCost, registerPrice, setDeploymentServiceTier } from './db/prices.js';
import { deleteTenantSample, setDeploymentDataClass, setSamplePolicy, showSamplePolicy, showSampleStats } from './db/sample-policy.js';
import { runSampleCleanup } from './inference/sample-jobs.js';
import { isDataClass, isSampleMode } from './inference/sample-policy.js';
import { resolveCaptureBounds } from './inference/sample-selection.js';
import { addTenantKey, provisionTenant, revokeTenantKey } from './db/provision.js';
import { createLogger, type Logger } from './logger.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function isVertexAuth(value: string): value is VertexAuthMode {
  return value === 'service_account' || value === 'adc' || value === 'workload_identity' || value === 'impersonation';
}

function isVertexApi(value: string): value is VertexApiVersion {
  return value === 'v1' || value === 'v1beta1';
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
  project?: string;
  location?: string;
  'auth-mode'?: string;
  status?: string;
  'service-account'?: string;
  'api-version'?: string;
  'downstream-providers'?: string;
  'data-collection'?: string;
  'allow-fallbacks'?: string;
  'require-serving-provider'?: string;
  host?: string;
  port?: string;
  addresses?: string;
  'tls-verify'?: string;
  'health-endpoint'?: string;
  'max-concurrency'?: string;
  'effective-at'?: string;
  source?: string;
  'service-tier'?: string;
  'serving-provider'?: string;
  'input-rate'?: string;
  'output-rate'?: string;
  'cache-read-rate'?: string;
  'cache-write-rate'?: string;
  'thinking-rate'?: string;
  'request-fee'?: string;
  'allocated-rate'?: string;
  'attempt-id'?: string;
  retries?: string;
  'connection-deadline-ms'?: string;
  'attempt-deadline-ms'?: string;
  'total-deadline-ms'?: string;
  'initial-backoff-ms'?: string;
  'max-backoff-ms'?: string;
  'window-ms'?: string;
  'min-samples'?: string;
  'failure-threshold'?: string;
  'cooldown-ms'?: string;
  'max-probes'?: string;
  mode?: string;
  'requests-per-minute'?: string;
  'concurrent-requests'?: string;
  'concurrent-streams'?: string;
  'token-rate'?: string;
  'lease-ms'?: string;
  'share-group'?: string;
  'monthly-amount'?: string;
  deployments?: string;
  failures?: string;
  'max-attempts'?: string;
  providers?: string;
  regions?: string;
  'min-remaining-deadline-ms'?: string;
  'context-limit'?: string;
  'content-capture'?: string;
  replay?: string;
  'judge-disclosure'?: string;
  'sample-rate'?: string;
  'max-sample-bytes'?: string;
  'max-sample-count'?: string;
  'retention-seconds'?: string;
  'recent-share'?: string;
  'sample-id'?: string;
  classifications?: string;
  'data-class'?: string;
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

function parseDefaultFalse(value: string | undefined): boolean | undefined {
  if (value === undefined) return false;
  return parseEnabled(value);
}

function parseSampleRate(value: string | undefined): string | undefined {
  const text = value ?? '0';
  if (!/^(?:0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?)$/.test(text)) return undefined;
  return text;
}

function parseRecentShare(value: string | undefined): string | undefined {
  const text = value ?? '0.600000';
  if (!/^(?:0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?)$/.test(text)) return undefined;
  return text;
}

function parseDefaultBounded(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return fallback;
  return parseBounded(value, minimum, maximum);
}

function parseCsv(value: string | undefined, allowEmpty: boolean): string[] | undefined {
  if (value === undefined || value.trim() === '') return allowEmpty ? [] : undefined;
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => item.length === 0)) return undefined;
  return items;
}

function parseBounded(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return undefined;
  return parsed;
}

function parseLimitValue(value: string | undefined, minimum: number, maximum: number): number | null | undefined {
  if (value === undefined || value === 'none') return null;
  return parseBounded(value, minimum, maximum);
}

function parseMode(value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  return allowed.includes(value) ? value : undefined;
}

function parsePolicyMs(value: string | undefined, minimum: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 600000) return undefined;
  return parsed;
}

function parseTimeout(value: string | undefined): number | null | undefined {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (parsed < 100 || parsed > 600000) return undefined;
  return parsed;
}

const DOWNSTREAM = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseOpenRouterRouting(
  provider: string,
  values: Flags,
):
  | null
  | 'invalid'
  | {
      downstreamProviders: string[] | null;
      dataCollection: 'allow' | 'deny' | null;
      allowFallbacks: boolean | null;
      requireServingProvider: boolean;
    } {
  const present =
    values['downstream-providers'] !== undefined ||
    values['data-collection'] !== undefined ||
    values['allow-fallbacks'] !== undefined ||
    values['require-serving-provider'] !== undefined;
  if (provider !== 'openrouter') return present ? 'invalid' : null;
  let downstreamProviders: string[] | null = null;
  if (values['downstream-providers'] !== undefined) {
    const parts = values['downstream-providers'].split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    if (parts.length === 0 || parts.length > 8 || parts.length !== new Set(parts).size || parts.some((item) => !DOWNSTREAM.test(item))) {
      return 'invalid';
    }
    downstreamProviders = parts;
  }
  let dataCollection: 'allow' | 'deny' | null = null;
  if (values['data-collection'] !== undefined) {
    if (values['data-collection'] !== 'allow' && values['data-collection'] !== 'deny') return 'invalid';
    dataCollection = values['data-collection'];
  }
  const allowFallbacks = parseEnabled(values['allow-fallbacks']);
  if (values['allow-fallbacks'] !== undefined && allowFallbacks === undefined) return 'invalid';
  const requireServingProvider = parseEnabled(values['require-serving-provider']);
  if (values['require-serving-provider'] !== undefined && requireServingProvider === undefined) return 'invalid';
  return {
    downstreamProviders,
    dataCollection,
    allowFallbacks: values['allow-fallbacks'] === undefined ? null : allowFallbacks ?? null,
    requireServingProvider: requireServingProvider ?? false,
  };
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

const RATE = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const PRICE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const REGION = /^(?:global|[a-z]+(?:-[a-z0-9]+){1,3})$/;
const SERVICE_TIER = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SERVING_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PRICE_PROVIDERS = new Set(['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx']);

function parseOptionalRate(value: string | undefined): string | null | undefined {
  if (value === undefined) return null;
  return RATE.test(value) ? value : undefined;
}

function parseServiceTier(value: string | undefined, required: boolean): string | null | undefined {
  if (value === undefined) return required ? undefined : null;
  if (required && value === 'none') return null;
  return SERVICE_TIER.test(value) ? value : undefined;
}

function parsePrice(values: Flags): {
  provider: string;
  model: string;
  region: string | null;
  serviceTier: string | null;
  servingProvider: string | null;
  effectiveAt: string;
  priceSource: string;
  verificationStatus: string;
  inputRate: string | null;
  outputRate: string | null;
  cacheReadRate: string | null;
  cacheWriteRate: string | null;
  thinkingRate: string | null;
  requestFee: string | null;
  allocatedRate: string | null;
} | undefined {
  const provider = values.provider ?? '';
  const model = values['upstream-model'] ?? '';
  const effectiveAt = values['effective-at'] ?? '';
  const priceSource = values.source ?? '';
  const verificationStatus = values.status ?? '';
  const serviceTier = parseServiceTier(values['service-tier'], false);
  const inputRate = parseOptionalRate(values['input-rate']);
  const outputRate = parseOptionalRate(values['output-rate']);
  const cacheReadRate = parseOptionalRate(values['cache-read-rate']);
  const cacheWriteRate = parseOptionalRate(values['cache-write-rate']);
  const thinkingRate = parseOptionalRate(values['thinking-rate']);
  const requestFee = parseOptionalRate(values['request-fee']);
  const allocatedRate = parseOptionalRate(values['allocated-rate']);
  const region = values.location === undefined ? null : values.location;
  const servingProvider = values['serving-provider'] === undefined ? null : values['serving-provider'];
  if (
    !PRICE_PROVIDERS.has(provider) ||
    model.length < 1 ||
    model.length > 128 ||
    /\s/.test(model) ||
    !PRICE_TIME.test(effectiveAt) ||
    Number.isNaN(Date.parse(effectiveAt)) ||
    priceSource.length < 1 ||
    priceSource.length > 128 ||
    /[\u0000-\u001F\u007F]/.test(priceSource) ||
    (verificationStatus !== 'verified' && verificationStatus !== 'unverified') ||
    (region !== null && !REGION.test(region)) ||
    (servingProvider !== null && !SERVING_PROVIDER.test(servingProvider)) ||
    serviceTier === undefined ||
    inputRate === undefined ||
    outputRate === undefined ||
    cacheReadRate === undefined ||
    cacheWriteRate === undefined ||
    thinkingRate === undefined ||
    requestFee === undefined ||
    allocatedRate === undefined
  ) {
    return undefined;
  }
  return {
    provider,
    model,
    region,
    serviceTier,
    servingProvider,
    effectiveAt,
    priceSource,
    verificationStatus,
    inputRate,
    outputRate,
    cacheReadRate,
    cacheWriteRate,
    thinkingRate,
    requestFee,
    allocatedRate,
  };
}

// Guided mode runs many commands in one session, so each command gets a fresh exit code
// and a thrown error is reported without ending the session.
async function runGuidedCommand(pool: Pool, config: Config, logger: Logger, command: string, values: Flags): Promise<void> {
  process.exitCode = 0;
  try {
    await runCommand(pool, config, logger, command, values);
  } catch (error) {
    logger.error('command failed', { message: errorMessage(error) });
    process.exitCode = 1;
  }
}

async function runCommand(pool: Pool, config: Config, logger: Logger, command: string, values: Flags): Promise<void> {
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

  if (command === 'register-vertex-connection') {
    const tenantId = requireTenant(values);
    const authMode = values['auth-mode']?.trim() || 'service_account';
    const apiKey = values['api-key'] ?? '';
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    if (authMode === 'service_account' && apiKey.length === 0) {
      logger.error('tenant-id and api-key are required');
      process.exitCode = 1;
      return;
    }
    const prepared = prepareRegistryConnection({
      provider: 'vertex',
      authMode,
      endpoint: values.endpoint,
      projectId: values.project,
      location: values.location,
      credential: apiKey,
      serviceAccountIdentity: values['service-account'],
      apiVersion: values['api-version'],
    });
    const protectedCredential =
      prepared.authMode === 'service_account'
        ? credentialStore(config.providerCredentialKey).protect(apiKey, 'service_account')
        : null;
    const created = await registerRegistryConnection(pool, {
      tenantId,
      provider: prepared.provider,
      protectedCredential,
      authMode: prepared.authMode,
      endpoint: prepared.endpoint,
      projectId: prepared.projectId,
      location: prepared.location,
      serviceAccountIdentity: prepared.serviceAccountIdentity,
      apiVersion: prepared.apiVersion,
    });
    process.stdout.write(
      `${JSON.stringify({
        ...created,
        tenantId,
        provider: prepared.provider,
        authMode: prepared.authMode,
        enabled: true,
        endpoint: prepared.endpoint,
        projectId: prepared.projectId,
        location: prepared.location,
        serviceAccountIdentity: prepared.serviceAccountIdentity,
        apiVersion: prepared.apiVersion,
      })}\n`,
    );
    return;
  }

  if (
    command === 'register-xai-connection' ||
    command === 'register-openrouter-connection' ||
    command === 'register-dgx-connection'
  ) {
    const tenantId = requireTenant(values);
    const apiKey = values['api-key'] ?? '';
    const provider = command.slice('register-'.length, command.indexOf('-connection'));
    if (tenantId === undefined || apiKey.length === 0) {
      logger.error('tenant-id and api-key are required');
      process.exitCode = 1;
      return;
    }
    const prepared = prepareRegistryConnection({
      provider,
      authMode: values['auth-mode'],
      endpoint: values.endpoint,
      projectId: values.project,
      location: values.location,
      credential: apiKey,
      serviceAccountIdentity: values['service-account'],
      apiVersion: values['api-version'],
    });
    const protectedCredential = credentialStore(config.providerCredentialKey).protect(apiKey, 'api_key');
    const created = await registerRegistryConnection(pool, {
      tenantId,
      provider: prepared.provider,
      protectedCredential,
      authMode: prepared.authMode,
      endpoint: prepared.endpoint,
      projectId: prepared.projectId,
      location: prepared.location,
      serviceAccountIdentity: prepared.serviceAccountIdentity,
      apiVersion: prepared.apiVersion,
    });
    process.stdout.write(
      `${JSON.stringify({
        ...created,
        tenantId,
        provider: prepared.provider,
        authMode: prepared.authMode,
        enabled: true,
        endpoint: prepared.endpoint,
        projectId: prepared.projectId,
        location: prepared.location,
      })}\n`,
    );
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
    const routing = parseOpenRouterRouting(provider, values);
    const defaultMaxText = values['default-max-output-tokens'];
    const defaultMaxOutputTokens = defaultMaxText === undefined ? null : Number(defaultMaxText);
    const deploymentProviders = new Set(['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx']);
    if (
      tenantId === undefined ||
      name.length === 0 ||
      upstreamModel.length === 0 ||
      !Number.isInteger(timeoutMs) ||
      capabilities === undefined ||
      !deploymentProviders.has(provider) ||
      routing === 'invalid' ||
      (values.enabled !== undefined && parseEnabled(values.enabled) === undefined) ||
      (defaultMaxOutputTokens !== null && !Number.isInteger(defaultMaxOutputTokens)) ||
      (provider !== 'anthropic' && defaultMaxText !== undefined)
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    if (provider === 'openrouter') {
      const created = await registerOpenRouterDeployment(pool, {
        tenantId,
        name,
        upstreamModel,
        timeoutMs,
        capabilities,
        enabled,
        downstreamProviders: routing?.downstreamProviders ?? null,
        dataCollection: routing?.dataCollection ?? null,
        allowFallbacks: routing?.allowFallbacks ?? null,
        requireServingProvider: routing?.requireServingProvider ?? false,
      });
      process.stdout.write(`${JSON.stringify({ tenantId, provider, name, enabled, ...created })}\n`);
      return;
    }
    if (provider !== 'openai') {
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

  if (command === 'validate-deployment' || command === 'set-deployment-health') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const status = values.status?.trim() ?? '';
    if (tenantId === undefined || name.length === 0 || status.length === 0) {
      logger.error('tenant-id, deployment, and status are required');
      process.exitCode = 1;
      return;
    }
    const updated = command === 'validate-deployment'
      ? await setDeploymentValidation(pool, tenantId, name, status)
      : await setDeploymentHealth(pool, tenantId, name, status);
    process.stdout.write(`${JSON.stringify({ tenantId, deployment: name, ...updated })}\n`);
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

  if (
    command === 'validate-vertex-credential' ||
    command === 'validate-vertex-access' ||
    command === 'test-vertex-inference'
  ) {
    const tenantId = requireTenant(values);
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    const loaded = await loadVertexOperatorConnection(pool, tenantId);
    if (loaded === null || !isVertexAuth(loaded.authMode) || !isVertexApi(loaded.apiVersion)) {
      logger.error('vertex connection was not found');
      process.exitCode = 1;
      return;
    }
    let upstreamModel = '';
    if (command === 'test-vertex-inference') {
      const deploymentName = values.deployment?.trim() ?? '';
      if (deploymentName.length === 0) {
        logger.error('deployment is required');
        process.exitCode = 1;
        return;
      }
      const listing = await listTenantInference(pool, tenantId);
      const deployment = listing.deployments.find((item) => item.name === deploymentName);
      if (deployment === undefined || deployment.connectionId !== loaded.connectionId) {
        logger.error('deployment was not found');
        process.exitCode = 1;
        return;
      }
      upstreamModel = deployment.upstreamModel;
    }
    let credentialJson: string | null = null;
    if (loaded.protectedCredential !== null) {
      credentialJson = credentialStore(config.providerCredentialKey).open(loaded.protectedCredential);
    }
    const spec: VertexClientSpec = {
      tenantId,
      connectionId: loaded.connectionId,
      connectionConfigVersion: loaded.configVersion,
      credentialVersion: loaded.credentialVersion,
      projectId: loaded.projectId,
      location: loaded.location,
      apiVersion: loaded.apiVersion,
      authMode: loaded.authMode,
      serviceAccountIdentity: loaded.serviceAccountIdentity,
      credentialJson,
    };
    const result =
      command === 'validate-vertex-credential'
        ? await validateVertexCredential(spec)
        : command === 'validate-vertex-access'
          ? await validateVertexAccess(await defaultVertexClientFactory(spec), spec)
          : await testVertexInference(await defaultVertexClientFactory(spec), upstreamModel);
    credentialJson = '';
    spec.credentialJson = null;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'approve-private-endpoint') {
    const tenantId = requireTenant(values);
    const host = values.host?.trim() ?? '';
    const port = Number(values.port);
    const addresses = (values.addresses ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    const tlsVerify = values['tls-verify'] === undefined ? true : parseEnabled(values['tls-verify']);
    const healthText = values['health-endpoint']?.trim() ?? '';
    if (tenantId === undefined || host.length === 0 || !Number.isInteger(port) || addresses.length === 0 || tlsVerify === undefined) {
      logger.error('endpoint is invalid');
      process.exitCode = 1;
      return;
    }
    const approval = normalizeApproval({
      host,
      port,
      addresses,
      tlsVerify,
      healthEndpoint: healthText.length === 0 ? null : healthText,
    });
    const approvalId = await approvePrivateEndpoint(pool, { tenantId, ...approval });
    process.stdout.write(`${JSON.stringify({ tenantId, approvalId, ...approval })}\n`);
    return;
  }

  if (command === 'set-deployment-concurrency') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const raw = values['max-concurrency']?.trim() ?? '';
    const limit = raw === 'none' ? null : Number(raw);
    if (tenantId === undefined || name.length === 0 || (limit !== null && !Number.isInteger(limit))) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const configVersion = await setDeploymentConcurrency(pool, tenantId, name, limit);
    process.stdout.write(`${JSON.stringify({ tenantId, deployment: name, maxConcurrency: limit, configVersion })}\n`);
    return;
  }

  if (command === 'list-private-models' || command === 'probe-private-health') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    if (tenantId === undefined || name.length === 0) {
      logger.error('tenant-id and deployment are required');
      process.exitCode = 1;
      return;
    }
    const runtimePool = createPool(config, 'runtime', logger, 1);
    const store = credentialStore(config.providerCredentialKey);
    try {
      const result = command === 'list-private-models'
        ? await listPrivateModels({ runtimePool, store, tenantId, deployment: name })
        : await probePrivateHealth({ runtimePool, store, tenantId, deployment: name });
      process.stdout.write(`${JSON.stringify({ tenantId, deployment: name, ...result })}\n`);
    } finally {
      await runtimePool.end();
    }
    return;
  }

  if (command === 'register-price') {
    const parsed = parsePrice(values);
    if (parsed === undefined) {
      logger.error('price arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const registered = await registerPrice(pool, parsed);
    process.stdout.write(`${JSON.stringify(registered)}\n`);
    return;
  }

  if (command === 'set-deployment-service-tier') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const tier = parseServiceTier(values['service-tier'], true);
    if (tenantId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === 'auto' || tier === undefined) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const serviceTier = await setDeploymentServiceTier(pool, tenantId, name, tier);
    process.stdout.write(`${JSON.stringify({ serviceTier })}\n`);
    return;
  }

  if (command === 'reconcile-attempt-cost') {
    const tenantId = requireTenant(values);
    const attemptId = values['attempt-id'] ?? '';
    if (tenantId === undefined || !UUID.test(attemptId)) {
      logger.error('attempt-id is required');
      process.exitCode = 1;
      return;
    }
    const reconciled = await reconcileAttemptCost(pool, tenantId, attemptId);
    process.stdout.write(`${JSON.stringify(reconciled)}\n`);
    return;
  }

  if (command === 'set-deployment-breaker') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const enabled = parseEnabled(values.enabled);
    const windowMs = parseBounded(values['window-ms'], 100, 3_600_000);
    const minSamples = parseBounded(values['min-samples'], 1, 10_000);
    const failureThreshold = parseBounded(values['failure-threshold'], 1, 10_000);
    const cooldownMs = parseBounded(values['cooldown-ms'], 0, 3_600_000);
    const maxProbes = parseBounded(values['max-probes'], 1, 8);
    const settingsInvalid = enabled === true && (
      windowMs === undefined
      || minSamples === undefined
      || failureThreshold === undefined
      || cooldownMs === undefined
      || maxProbes === undefined
      || failureThreshold > minSamples
    );
    if (
      tenantId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
      || name === 'auto'
      || enabled === undefined
      || settingsInvalid
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const deploymentId = await setDeploymentBreaker(
      pool,
      tenantId,
      name,
      enabled,
      enabled ? windowMs ?? null : null,
      enabled ? minSamples ?? null : null,
      enabled ? failureThreshold ?? null : null,
      enabled ? cooldownMs ?? null : null,
      enabled ? maxProbes ?? null : null,
    );
    process.stdout.write(`${JSON.stringify({ deploymentId, enabled })}\n`);
    return;
  }

  if (command === 'reset-deployment-breaker') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    if (tenantId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === 'auto') {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const deploymentId = await resetDeploymentBreaker(pool, tenantId, name);
    process.stdout.write(`${JSON.stringify({ deploymentId, state: 'closed' })}\n`);
    return;
  }

  if (command === 'set-execution-policy') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const retriesEnabled = parseEnabled(values.retries);
    const connectionDeadlineMs = parsePolicyMs(values['connection-deadline-ms'], 100);
    const attemptDeadlineMs = parsePolicyMs(values['attempt-deadline-ms'], 100);
    const totalDeadlineMs = parsePolicyMs(values['total-deadline-ms'], 100);
    const initialBackoffMs = parsePolicyMs(values['initial-backoff-ms'], 0);
    const maxBackoffMs = parsePolicyMs(values['max-backoff-ms'], 0);
    if (
      tenantId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
      || name === 'auto'
      || retriesEnabled === undefined
      || connectionDeadlineMs === undefined
      || attemptDeadlineMs === undefined
      || totalDeadlineMs === undefined
      || initialBackoffMs === undefined
      || maxBackoffMs === undefined
      || initialBackoffMs > maxBackoffMs
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const policyId = await setDeploymentExecutionPolicy(
      pool,
      tenantId,
      name,
      retriesEnabled,
      connectionDeadlineMs,
      attemptDeadlineMs,
      totalDeadlineMs,
      initialBackoffMs,
      maxBackoffMs,
    );
    process.stdout.write(`${JSON.stringify({ policyId, retriesEnabled })}\n`);
    return;
  }

  if (command === 'set-fallback-policy') {
    const tenantId = requireTenant(values);
    const alias = values.alias ?? '';
    const enabled = parseEnabled(values.enabled);
    const deployments = parseCsv(values.deployments, true);
    const failures = parseCsv(values.failures, false);
    const maxAttempts = parseBounded(values['max-attempts'], 1, 8);
    const capabilities = parseCsv(values.capabilities, true);
    const providers = parseCsv(values.providers, true);
    const regions = parseCsv(values.regions, true);
    const dataCollection = values['data-collection']?.trim() ?? '';
    const minRemainingDeadlineMs = parseBounded(values['min-remaining-deadline-ms'], 0, 600_000);
    if (
      tenantId === undefined
      || alias !== 'auto'
      || enabled === undefined
      || deployments === undefined
      || failures === undefined
      || maxAttempts === undefined
      || capabilities === undefined
      || providers === undefined
      || regions === undefined
      || (dataCollection !== 'allow' && dataCollection !== 'deny')
      || minRemainingDeadlineMs === undefined
      || (enabled && deployments.length < 1)
      || (enabled && providers.length < 1)
    ) {
      logger.error('fallback arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const stored = await setFallbackPolicy(
      pool,
      tenantId,
      alias,
      enabled,
      deployments,
      failures,
      maxAttempts,
      capabilities,
      providers,
      regions,
      dataCollection,
      minRemainingDeadlineMs,
    );
    process.stdout.write(`${JSON.stringify(stored)}\n`);
    return;
  }

  if (command === 'show-fallback-policy') {
    const tenantId = requireTenant(values);
    const alias = values.alias ?? '';
    if (tenantId === undefined || alias !== 'auto') {
      logger.error('fallback arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const stored = await showFallbackPolicy(pool, tenantId, alias);
    process.stdout.write(`${JSON.stringify(stored ?? { attached: false })}\n`);
    return;
  }

  if (command === 'set-deployment-context-limit') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const limit = parseBounded(values['context-limit'], 1, 10_000_000);
    if (tenantId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === 'auto' || limit === undefined) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const configVersion = await setDeploymentContextLimit(pool, tenantId, name, limit);
    process.stdout.write(`${JSON.stringify({ configVersion })}\n`);
    return;
  }

  if (command === 'set-deployment-data-collection') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const value = values['data-collection']?.trim() ?? '';
    if (
      tenantId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
      || name === 'auto'
      || (value !== 'allow' && value !== 'deny')
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const configVersion = await setDeploymentDataCollection(pool, tenantId, name, value);
    process.stdout.write(`${JSON.stringify({ configVersion })}\n`);
    return;
  }

  if (command === 'set-tenant-limits') {
    const tenantId = requireTenant(values);
    const mode = parseMode(values.mode, ['observe', 'hard']);
    const requestsPerMinute = parseLimitValue(values['requests-per-minute'], 1, 1_000_000);
    const concurrentRequests = parseLimitValue(values['concurrent-requests'], 1, 100_000);
    const concurrentStreams = parseLimitValue(values['concurrent-streams'], 1, 100_000);
    const tokenRate = parseLimitValue(values['token-rate'], 1, 1_000_000_000);
    const leaseMs = parseLimitValue(values['lease-ms'], 100, 600_000);
    if (
      tenantId === undefined
      || mode === undefined
      || requestsPerMinute === undefined
      || concurrentRequests === undefined
      || concurrentStreams === undefined
      || tokenRate === undefined
      || leaseMs === undefined
    ) {
      logger.error('limit arguments are invalid');
      process.exitCode = 1;
      return;
    }
    await setTenantLimits(
      pool,
      tenantId,
      mode,
      requestsPerMinute,
      concurrentRequests,
      concurrentStreams,
      tokenRate,
      leaseMs,
    );
    process.stdout.write(`${JSON.stringify({ tenantId, mode })}\n`);
    return;
  }

  if (command === 'set-api-key-limits') {
    const tenantId = requireTenant(values);
    const keyId = values['key-id'] ?? '';
    const mode = values.mode === 'none' ? null : parseMode(values.mode, ['observe', 'hard']);
    const requestsPerMinute = parseLimitValue(values['requests-per-minute'], 1, 1_000_000);
    const concurrentRequests = parseLimitValue(values['concurrent-requests'], 1, 100_000);
    const concurrentStreams = parseLimitValue(values['concurrent-streams'], 1, 100_000);
    const tokenRate = parseLimitValue(values['token-rate'], 1, 1_000_000_000);
    if (
      tenantId === undefined
      || !UUID.test(keyId)
      || (values.mode !== undefined && values.mode !== 'none' && mode === undefined)
      || requestsPerMinute === undefined
      || concurrentRequests === undefined
      || concurrentStreams === undefined
      || tokenRate === undefined
    ) {
      logger.error('limit arguments are invalid');
      process.exitCode = 1;
      return;
    }
    await setApiKeyLimits(
      pool,
      tenantId,
      keyId,
      mode ?? null,
      requestsPerMinute,
      concurrentRequests,
      concurrentStreams,
      tokenRate,
    );
    process.stdout.write(`${JSON.stringify({ tenantId, keyId, mode })}\n`);
    return;
  }

  if (command === 'set-connection-limit') {
    const tenantId = requireTenant(values);
    const provider = values.provider ?? '';
    const mode = parseMode(values.mode, ['observe', 'hard']) ?? 'observe';
    const maxConcurrency = parseLimitValue(values['max-concurrency'], 1, 100_000);
    const shareGroup = values['share-group'] === 'none' ? null : values['share-group'] ?? null;
    const shareValid = shareGroup === null || /^[a-z0-9][a-z0-9-]{0,63}$/.test(shareGroup);
    if (
      tenantId === undefined
      || !['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx'].includes(provider)
      || maxConcurrency === undefined
      || (maxConcurrency !== null && parseMode(values.mode, ['observe', 'hard']) === undefined)
      || !shareValid
    ) {
      logger.error('connection arguments are invalid');
      process.exitCode = 1;
      return;
    }
    await setConnectionLimit(pool, tenantId, provider, mode, maxConcurrency, shareGroup);
    process.stdout.write(`${JSON.stringify({ tenantId, provider, mode, maxConcurrency, shareGroup })}\n`);
    return;
  }

  if (command === 'set-deployment-limit') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const mode = parseMode(values.mode, ['observe', 'hard']) ?? 'observe';
    const maxConcurrency = parseLimitValue(values['max-concurrency'], 1, 100_000);
    if (
      tenantId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
      || name === 'auto'
      || maxConcurrency === undefined
      || (maxConcurrency !== null && parseMode(values.mode, ['observe', 'hard']) === undefined)
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    await setDeploymentLimit(pool, tenantId, name, mode, maxConcurrency);
    process.stdout.write(`${JSON.stringify({ tenantId, deployment: name, mode, maxConcurrency })}\n`);
    return;
  }

  if (command === 'set-tenant-budget') {
    const tenantId = requireTenant(values);
    const mode = parseMode(values.mode, ['observe', 'hard', 'disabled']);
    const amount = values['monthly-amount'] ?? '';
    if (tenantId === undefined || mode === undefined || !/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(amount)) {
      logger.error('budget arguments are invalid');
      process.exitCode = 1;
      return;
    }
    await setTenantBudget(pool, tenantId, mode, amount);
    process.stdout.write(`${JSON.stringify({ tenantId, mode, monthlyAmount: amount })}\n`);
    return;
  }

  if (command === 'recover-budget') {
    const tenantId = requireTenant(values);
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    const closed = await recoverTenantBudget(pool, tenantId, new Date());
    process.stdout.write(`${JSON.stringify({ tenantId, closed })}\n`);
    return;
  }

  if (command === 'set-sample-policy') {
    const tenantId = requireTenant(values);
    const mode = values.mode ?? '';
    const contentCapture = parseDefaultFalse(values['content-capture']);
    const replay = parseDefaultFalse(values.replay);
    const judgeDisclosure = parseDefaultFalse(values['judge-disclosure']);
    const sampleRate = parseSampleRate(values['sample-rate']);
    const maxSampleBytes = parseDefaultBounded(values['max-sample-bytes'], 0, 0, 1_000_000);
    const maxSampleCount = values['max-sample-count'] === undefined
      ? null
      : parseBounded(values['max-sample-count'], 0, 1_000_000);
    const retentionSeconds = values['retention-seconds'] === undefined
      ? null
      : parseBounded(values['retention-seconds'], 0, 315_360_000);
    const recentShare = parseRecentShare(values['recent-share']);
    const classifications = parseCsv(values.classifications, true);
    const providers = parseCsv(values.providers, true);
    const deployments = parseCsv(values.deployments, true);
    if (
      tenantId === undefined
      || !isSampleMode(mode)
      || contentCapture === undefined
      || replay === undefined
      || judgeDisclosure === undefined
      || sampleRate === undefined
      || maxSampleBytes === undefined
      || (values['max-sample-count'] !== undefined && maxSampleCount === undefined)
      || (values['retention-seconds'] !== undefined && retentionSeconds === undefined)
      || maxSampleCount === undefined
      || retentionSeconds === undefined
      || recentShare === undefined
      || classifications === undefined
      || providers === undefined
      || deployments === undefined
    ) {
      logger.error('sample arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const bounds = resolveCaptureBounds({
      mode,
      contentCapture,
      maxSampleCount,
      retentionSeconds,
    });
    const stored = await setSamplePolicy(
      pool,
      tenantId,
      mode,
      contentCapture,
      replay,
      judgeDisclosure,
      sampleRate,
      maxSampleBytes,
      bounds.maxSampleCount,
      bounds.retentionSeconds,
      classifications,
      providers,
      deployments,
      recentShare,
    );
    process.stdout.write(`${JSON.stringify(stored)}\n`);
    return;
  }

  if (command === 'set-deployment-data-class') {
    const tenantId = requireTenant(values);
    const name = values.deployment?.trim() ?? '';
    const value = values['data-class']?.trim() ?? '';
    const dataClass = value === 'none' ? null : value;
    if (
      tenantId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
      || name === 'auto'
      || (dataClass !== null && !isDataClass(dataClass))
    ) {
      logger.error('deployment arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const configVersion = await setDeploymentDataClass(pool, tenantId, name, dataClass);
    process.stdout.write(`${JSON.stringify({ configVersion })}\n`);
    return;
  }

  if (command === 'show-sample-policy') {
    const tenantId = requireTenant(values);
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    const stored = await showSamplePolicy(pool, tenantId);
    process.stdout.write(`${JSON.stringify(stored ?? { attached: false })}\n`);
    return;
  }

  if (command === 'delete-sample') {
    const tenantId = requireTenant(values);
    const sampleId = values['sample-id'] ?? '';
    if (tenantId === undefined || !UUID.test(sampleId)) {
      logger.error('sample arguments are invalid');
      process.exitCode = 1;
      return;
    }
    const deleted = await deleteTenantSample(pool, tenantId, sampleId);
    process.stdout.write(`${JSON.stringify({ deleted })}\n`);
    return;
  }

  if (command === 'cleanup-expired-samples') {
    const tenantId = requireTenant(values);
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    const bucket = new Date().toISOString().slice(0, 16);
    const result = await runSampleCleanup(pool, {
      idempotencyKey: `expire-cleanup:${tenantId}:${bucket}`,
      tenantId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }

  if (command === 'show-sample-stats') {
    const tenantId = requireTenant(values);
    if (tenantId === undefined) {
      logger.error('tenant-id is required');
      process.exitCode = 1;
      return;
    }
    const stats = await showSampleStats(pool, tenantId);
    process.stdout.write(`${JSON.stringify(stats ?? { attached: false })}\n`);
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
  const argv = process.argv.slice(2);
  if (argv.includes('--interactive')) {
    if (argv.length !== 1 || argv[0] !== '--interactive') {
      logger.error('invalid command arguments');
      process.exit(1);
    }
    const pool = createPool(config, 'migrator', logger, 1);
    const input = openInteractiveInput();
    const guided = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    try {
      await runInteractiveSession({
        guided,
        ask: (prompt) => input.ask(prompt),
        say: (text) => {
          process.stderr.write(`${text}\n`);
        },
        run: guided
          ? (nextCommand, nextValues) => runGuidedCommand(pool, config, logger, nextCommand, nextValues as Flags)
          : (nextCommand, nextValues) => runCommand(pool, config, logger, nextCommand, nextValues as Flags),
        failed: () => process.exitCode === 1,
        reject(message) {
          logger.error(message);
          process.exitCode = 1;
        },
      });
    } catch (error) {
      logger.error('command failed', { message: errorMessage(error) });
      process.exitCode = 1;
    } finally {
      input.close();
      await pool.end();
    }
    return;
  }
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
        project: { type: 'string' },
        location: { type: 'string' },
        'auth-mode': { type: 'string' },
        status: { type: 'string' },
        'service-account': { type: 'string' },
        'api-version': { type: 'string' },
        'downstream-providers': { type: 'string' },
        'data-collection': { type: 'string' },
        'allow-fallbacks': { type: 'string' },
        'require-serving-provider': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        addresses: { type: 'string' },
        'tls-verify': { type: 'string' },
        'health-endpoint': { type: 'string' },
        'max-concurrency': { type: 'string' },
        'effective-at': { type: 'string' },
        source: { type: 'string' },
        'service-tier': { type: 'string' },
        'serving-provider': { type: 'string' },
        'input-rate': { type: 'string' },
        'output-rate': { type: 'string' },
        'cache-read-rate': { type: 'string' },
        'cache-write-rate': { type: 'string' },
        'thinking-rate': { type: 'string' },
        'request-fee': { type: 'string' },
        'allocated-rate': { type: 'string' },
        'attempt-id': { type: 'string' },
        retries: { type: 'string' },
        'connection-deadline-ms': { type: 'string' },
        'attempt-deadline-ms': { type: 'string' },
        'total-deadline-ms': { type: 'string' },
        'initial-backoff-ms': { type: 'string' },
        'max-backoff-ms': { type: 'string' },
        'window-ms': { type: 'string' },
        'min-samples': { type: 'string' },
        'failure-threshold': { type: 'string' },
        'cooldown-ms': { type: 'string' },
        'max-probes': { type: 'string' },
        mode: { type: 'string' },
        'requests-per-minute': { type: 'string' },
        'concurrent-requests': { type: 'string' },
        'concurrent-streams': { type: 'string' },
        'token-rate': { type: 'string' },
        'lease-ms': { type: 'string' },
        'share-group': { type: 'string' },
        'monthly-amount': { type: 'string' },
        deployments: { type: 'string' },
        failures: { type: 'string' },
        'max-attempts': { type: 'string' },
        providers: { type: 'string' },
        regions: { type: 'string' },
        'min-remaining-deadline-ms': { type: 'string' },
        'context-limit': { type: 'string' },
        'content-capture': { type: 'string' },
        replay: { type: 'string' },
        'judge-disclosure': { type: 'string' },
        'sample-rate': { type: 'string' },
        'max-sample-bytes': { type: 'string' },
        'max-sample-count': { type: 'string' },
        'retention-seconds': { type: 'string' },
        classifications: { type: 'string' },
        'data-class': { type: 'string' },
        'recent-share': { type: 'string' },
        'sample-id': { type: 'string' },
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

  const strayPrivateFlag = (
    (values.host !== undefined && command !== 'approve-private-endpoint')
    || (values.port !== undefined && command !== 'approve-private-endpoint')
    || (values.addresses !== undefined && command !== 'approve-private-endpoint')
    || (values['tls-verify'] !== undefined && command !== 'approve-private-endpoint')
    || (values['health-endpoint'] !== undefined && command !== 'approve-private-endpoint')
    || (
      values['max-concurrency'] !== undefined
      && command !== 'set-deployment-concurrency'
      && command !== 'set-connection-limit'
      && command !== 'set-deployment-limit'
    )
    || (
      values.mode !== undefined
      && command !== 'set-tenant-limits'
      && command !== 'set-api-key-limits'
      && command !== 'set-connection-limit'
      && command !== 'set-deployment-limit'
      && command !== 'set-tenant-budget'
      && command !== 'set-sample-policy'
    )
    || (
      values['requests-per-minute'] !== undefined
      && command !== 'set-tenant-limits'
      && command !== 'set-api-key-limits'
    )
    || (
      values['concurrent-requests'] !== undefined
      && command !== 'set-tenant-limits'
      && command !== 'set-api-key-limits'
    )
    || (
      values['concurrent-streams'] !== undefined
      && command !== 'set-tenant-limits'
      && command !== 'set-api-key-limits'
    )
    || (
      values['token-rate'] !== undefined
      && command !== 'set-tenant-limits'
      && command !== 'set-api-key-limits'
    )
    || (values['lease-ms'] !== undefined && command !== 'set-tenant-limits')
    || (values['share-group'] !== undefined && command !== 'set-connection-limit')
    || (values['monthly-amount'] !== undefined && command !== 'set-tenant-budget')
    || (values['effective-at'] !== undefined && command !== 'register-price')
    || (values.source !== undefined && command !== 'register-price')
    || (values['serving-provider'] !== undefined && command !== 'register-price')
    || (values['input-rate'] !== undefined && command !== 'register-price')
    || (values['output-rate'] !== undefined && command !== 'register-price')
    || (values['cache-read-rate'] !== undefined && command !== 'register-price')
    || (values['cache-write-rate'] !== undefined && command !== 'register-price')
    || (values['thinking-rate'] !== undefined && command !== 'register-price')
    || (values['request-fee'] !== undefined && command !== 'register-price')
    || (values['allocated-rate'] !== undefined && command !== 'register-price')
    || (
      values['service-tier'] !== undefined
      && command !== 'register-price'
      && command !== 'set-deployment-service-tier'
    )
    || (values['attempt-id'] !== undefined && command !== 'reconcile-attempt-cost')
    || (values.retries !== undefined && command !== 'set-execution-policy')
    || (values['connection-deadline-ms'] !== undefined && command !== 'set-execution-policy')
    || (values['attempt-deadline-ms'] !== undefined && command !== 'set-execution-policy')
    || (values['total-deadline-ms'] !== undefined && command !== 'set-execution-policy')
    || (values['initial-backoff-ms'] !== undefined && command !== 'set-execution-policy')
    || (values['max-backoff-ms'] !== undefined && command !== 'set-execution-policy')
    || (values['window-ms'] !== undefined && command !== 'set-deployment-breaker')
    || (values['min-samples'] !== undefined && command !== 'set-deployment-breaker')
    || (values['failure-threshold'] !== undefined && command !== 'set-deployment-breaker')
    || (values['cooldown-ms'] !== undefined && command !== 'set-deployment-breaker')
    || (values['max-probes'] !== undefined && command !== 'set-deployment-breaker')
    || (values.deployments !== undefined && command !== 'set-fallback-policy' && command !== 'set-sample-policy')
    || (values.failures !== undefined && command !== 'set-fallback-policy')
    || (values['max-attempts'] !== undefined && command !== 'set-fallback-policy')
    || (values.providers !== undefined && command !== 'set-fallback-policy' && command !== 'set-sample-policy')
    || (values.regions !== undefined && command !== 'set-fallback-policy')
    || (values['min-remaining-deadline-ms'] !== undefined && command !== 'set-fallback-policy')
    || (values['context-limit'] !== undefined && command !== 'set-deployment-context-limit')
    || (values['content-capture'] !== undefined && command !== 'set-sample-policy')
    || (values.replay !== undefined && command !== 'set-sample-policy')
    || (values['judge-disclosure'] !== undefined && command !== 'set-sample-policy')
    || (values['sample-rate'] !== undefined && command !== 'set-sample-policy')
    || (values['max-sample-bytes'] !== undefined && command !== 'set-sample-policy')
    || (values['max-sample-count'] !== undefined && command !== 'set-sample-policy')
    || (values['retention-seconds'] !== undefined && command !== 'set-sample-policy')
    || (values.classifications !== undefined && command !== 'set-sample-policy')
    || (values['data-class'] !== undefined && command !== 'set-deployment-data-class')
    || (values['recent-share'] !== undefined && command !== 'set-sample-policy')
    || (values['sample-id'] !== undefined && command !== 'delete-sample')
  );
  if (strayPrivateFlag) {
    logger.error('invalid command arguments');
    process.exit(1);
  }

  const pool = createPool(config, 'migrator', logger, 1);
  try {
    await runCommand(pool, config, logger, command, values);
  } catch (error) {
    logger.error('command failed', { message: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
