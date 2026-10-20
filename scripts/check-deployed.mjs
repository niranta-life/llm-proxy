#!/usr/bin/env node
// Request/response checks against a deployed llm-proxy.
// --prepare-local builds the fixtures on the Colima Compose stack, including
// the database and process cases. It restores the previous app environment.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = process.env.COLIMA_PROFILE || 'default';
const socket = process.env.COLIMA_SOCKET || join(process.env.HOME || '', '.colima', profile, 'docker.sock');
const mockName = 'llm-proxy-check-mock';
const mockInternal = 'http://llm-proxy-check-mock:8081/v1';
const officialOpenAi = 'https://api.openai.com/v1';
const unsupportedKeys = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'modalities',
  'audio',
  'reasoning_effort',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'store',
  'metadata',
  'service_tier',
  'stream_options',
  'prediction',
  'web_search_options',
];

const httpRequired = [
  'health live',
  'health ready',
  'unknown route',
  'accepts a matching tenant and secret',
  'rejects missing, malformed, unknown, and mismatched credentials',
  'rejects a caller provider and api key',
  'keeps another active key working after one key is revoked',
  'accepts text messages and stream false',
  'rejects stream=true',
  'rejects tools, images, audio, and unknown parameters',
  'rejects a supported parameter the deployment does not allow',
  'resolves an alias and an explicit deployment name',
  'skips a disabled deployment',
  'uses only that tenant alias',
  'hides an upstream 500 and does not retry',
  'maps an upstream 429',
  'rejects an invalid upstream body',
  'omits missing usage and reports it',
  'times out one upstream call',
  'cancels one upstream call',
  'makes one upstream call per concurrent request',
  'lists only that tenant models',
  'openai sdk success, error, and models',
  'metrics window',
  'does not call upstream when no deployment is enabled',
];

const localRequired = [
  'does not call upstream when inference is disabled',
  'skips a disabled connection',
  'stores a protected verifier and ciphertext',
  'lists inference config without credential material',
  'tenant isolation holds for runtime queries',
  'runtime role fails closed',
  'clears tenant context before a connection returns to the pool',
  'logs omit secrets, prompts, and verifiers',
  'persistence failure makes no upstream call',
  'telemetry failure still returns the completion',
  'readiness follows postgres and SIGTERM closes pools',
  'migrations keep tenant rows on a second boot',
  'rejects incomplete configuration without echoing secrets',
  'rejects an invalid log level',
  'exits before listening when a required setting is missing',
  'requires a credential key when inference is enabled and does not echo it',
];

const state = {
  dockerHost: '',
  baseUrl: 'http://127.0.0.1:8080',
  mockUrl: 'http://127.0.0.1:18081',
  credentialKey: '',
  savedEnv: null,
  prepared: false,
  admin: false,
  leavePrepared: false,
  image: '',
  fixtures: null,
  postgresStopped: false,
  listOutput: '',
  registerOutput: '',
};

const passed = [];
const failed = [];

function describeError(error) {
  if (!(error instanceof Error)) return redact(String(error));
  const cause = error.cause;
  const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause ? String(cause) : '';
  return redact(`${error.stack ?? error.message}${causeText ? `\ncause: ${causeText}` : ''}`);
}

function redact(text) {
  return String(text)
    .replace(/yck_[A-Za-z0-9_-]+/g, 'yck_[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/aes-256-gcm\$\S+/g, 'aes-256-gcm$[redacted]')
    .replace(/scrypt\$\S+/g, 'scrypt$[redacted]')
    .replace(/migrator_local_dev|auth_local_dev|runtime_local_dev/g, '[local-password]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  if (state.dockerHost) env.DOCKER_HOST = state.dockerHost;
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env,
    input: options.input,
    timeout: options.timeout,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function compose(args, options = {}) {
  const result = run('docker', ['compose', ...args], options);
  if (result.status !== 0) {
    throw new Error(`docker compose ${args[0]} failed: ${redact(result.stderr || result.stdout).slice(0, 500)}`);
  }
  return result;
}

function appContainerId() {
  const result = run('docker', ['compose', 'ps', '-aq', 'app']);
  const id = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (!id) throw new Error('app container is missing');
  return id;
}

function appLogs() {
  const id = appContainerId();
  const result = run('docker', ['logs', id]);
  return `${result.stdout}\n${result.stderr}`;
}

function captureEnv() {
  const inspected = run('docker', ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', appContainerId()]);
  if (inspected.status !== 0) throw new Error('could not read the app environment');
  const env = {
    INFERENCE_ENABLED: 'false',
    OPENAI_BASE_URL: officialOpenAi,
    PROVIDER_CREDENTIAL_KEY: '',
  };
  for (const line of inspected.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index);
    if (key in env) env[key] = line.slice(index + 1);
  }
  return env;
}

function recreateApp(env) {
  process.env.INFERENCE_ENABLED = env.INFERENCE_ENABLED;
  process.env.OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  process.env.PROVIDER_CREDENTIAL_KEY = env.PROVIDER_CREDENTIAL_KEY;
  compose(['up', '-d', '--force-recreate', '--no-deps', '--wait', 'app'], {
    env,
    timeout: 180000,
  });
}

async function waitReady() {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    try {
      const response = await fetch(`${state.baseUrl}/health/ready`);
      if (response.status === 200) {
        const body = await response.json();
        if (body.status === 'ready' && body.database === 'ready') return;
      }
    } catch {
      // The app is still starting.
    }
    await sleep(500);
  }
  throw new Error('the app did not become ready');
}

async function mockFetch(path, options) {
  let last = new Error('mock request failed');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetch(`${state.mockUrl}${path}`, { ...options, headers: { connection: 'close', ...(options?.headers ?? {}) } });
    } catch (error) {
      last = error;
      await sleep(150);
    }
  }
  throw last;
}

async function waitMock() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await mockFetch('/health');
      if (response.ok) return;
    } catch {
      // The mock is still starting.
    }
    await sleep(250);
  }
  const logs = run('docker', ['logs', mockName]);
  throw new Error(`mock did not become ready: ${redact(logs.stderr || logs.stdout).slice(0, 300)}`);
}

async function setMode(mode) {
  const response = await mockFetch('/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (response.status !== 204) throw new Error(`mock control returned ${response.status}`);
}

async function mockHits() {
  const response = await mockFetch('/hits');
  if (!response.ok) throw new Error(`mock hits returned ${response.status}`);
  return response.json();
}

function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')) {
    throw new Error('expected a uuid');
  }
  return value;
}

function psql(sql, user = 'postgres') {
  return run(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', 'llm_proxy', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
    { input: sql },
  );
}

function query(sql, user = 'postgres') {
  const result = psql(sql, user);
  if (result.status !== 0) {
    throw new Error(`sql failed: ${redact(result.stderr || result.stdout).slice(0, 400)}`);
  }
  return result.stdout.trim();
}

function queryFails(sql, user, pattern) {
  const result = psql(sql, user);
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.status === 0 || !pattern.test(text)) {
    throw new Error(`expected sql failure ${pattern}`);
  }
}

async function request(method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.tenant) headers['x-tenant-id'] = options.tenant;
  if (options.secret) headers.authorization = `Bearer ${options.secret}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const url = new URL(path, state.baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

function chatBody(model, content, extra = {}) {
  return { model, messages: [{ role: 'user', content }], ...extra };
}

function expectError(response, status, code, param) {
  const actualCode = response.json?.error?.code;
  if (response.status !== status || actualCode !== code) {
    throw new Error(`expected ${status} ${code} but got ${response.status} ${actualCode ?? ''} ${response.text.slice(0, 160)}`);
  }
  if (param !== undefined && response.json.error.param !== param) {
    throw new Error(`expected param ${param} but got ${response.json.error.param}`);
  }
}

async function check(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push(name);
    const message = redact(error instanceof Error ? error.message : String(error));
    console.error(`FAIL ${name}: ${message}`);
  }
}

function cli(args) {
  const result = run('docker', ['compose', 'run', '--rm', '-T', '--no-deps', 'app', 'node', 'dist/cli.js', ...args], {
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`cli ${args[0]} failed: ${redact(result.stderr || result.stdout).slice(0, 400)}`);
  }
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`cli ${args[0]} returned no json`);
  return JSON.parse(line);
}

function ensureColima() {
  const status = run('colima', ['status', '-p', profile]);
  const text = `${status.stdout}\n${status.stderr}`;
  if (!text.includes('colima is running')) {
    console.log(`starting colima profile ${profile}`);
    const started = run('colima', ['start', '-p', profile], { timeout: 300000 });
    if (started.status !== 0) throw new Error(`colima start failed: ${redact(started.stderr).slice(0, 300)}`);
  }
  if (!existsSync(socket)) throw new Error(`Colima socket is missing: ${socket}`);
  state.dockerHost = `unix://${socket}`;
  process.env.DOCKER_HOST = state.dockerHost;
}

function startMock() {
  run('docker', ['rm', '-f', mockName]);
  const result = run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      mockName,
      '--network',
      'llm-proxy_default',
      '-p',
      '127.0.0.1:18081:8081',
      '-v',
      `${root}/scripts/check-mock.mjs:/opt/mock.mjs:ro`,
      'node:24-bookworm-slim',
      'node',
      '/opt/mock.mjs',
    ],
    { timeout: 180000 },
  );
  if (result.status !== 0) throw new Error(`mock start failed: ${redact(result.stderr || result.stdout).slice(0, 400)}`);
}

function registerTenant(tenantId, apiKey, deployment, upstreamModel, timeoutMs, capabilities, enabled) {
  const registered = cli(['register-openai-connection', '--tenant-id', tenantId, '--api-key', apiKey]);
  state.registerOutput += `${JSON.stringify(registered)}\n`;
  if (JSON.stringify(registered).includes(apiKey)) throw new Error('register printed the api key');
  cli([
    'register-deployment',
    '--tenant-id',
    tenantId,
    '--name',
    deployment,
    '--upstream-model',
    upstreamModel,
    '--timeout-ms',
    String(timeoutMs),
    '--capabilities',
    capabilities,
    '--enabled',
    enabled ? 'true' : 'false',
  ]);
}

function prepareLocal() {
  ensureColima();
  const existing = run('docker', ['compose', 'ps', '-aq', 'app']);
  if (existing.stdout.trim()) {
    compose(['up', '-d', '--wait', '--no-recreate'], { timeout: 180000 });
  } else {
    process.env.INFERENCE_ENABLED = 'false';
    process.env.OPENAI_BASE_URL = officialOpenAi;
    process.env.PROVIDER_CREDENTIAL_KEY = '';
    compose(['up', '-d', '--wait'], {
      env: {
        INFERENCE_ENABLED: 'false',
        OPENAI_BASE_URL: officialOpenAi,
        PROVIDER_CREDENTIAL_KEY: '',
      },
      timeout: 300000,
    });
  }
  state.savedEnv = captureEnv();
  state.image = run('docker', ['inspect', '-f', '{{.Image}}', appContainerId()]).stdout.trim();
  if (!state.image) throw new Error('app image is missing');
  startMock();
  state.credentialKey = randomBytes(32).toString('base64');
  recreateApp({
    INFERENCE_ENABLED: 'true',
    OPENAI_BASE_URL: mockInternal,
    PROVIDER_CREDENTIAL_KEY: state.credentialKey,
  });
  state.prepared = true;
  state.admin = true;
}

async function provisionFixtures() {
  const alpha = cli(['provision-tenant', '--name', 'Check Alpha', '--label', 'primary']);
  const alphaSecond = cli(['add-key', '--tenant-id', alpha.tenantId, '--label', 'secondary']);
  const beta = cli(['provision-tenant', '--name', 'Check Beta', '--label', 'beta-label']);
  const empty = cli(['provision-tenant', '--name', 'Check Empty']);
  const usage = cli(['provision-tenant', '--name', 'Check Usage']);
  const alphaKey = `sk-check-alpha-${randomBytes(4).toString('hex')}`;
  const betaKey = `sk-check-beta-${randomBytes(4).toString('hex')}`;
  const emptyKey = `sk-check-empty-${randomBytes(4).toString('hex')}`;
  const usageKey = `sk-check-usage-${randomBytes(4).toString('hex')}`;
  registerTenant(alpha.tenantId, alphaKey, 'primary', 'gpt-check-alpha', 30000, 'temperature', true);
  cli([
    'register-deployment',
    '--tenant-id',
    alpha.tenantId,
    '--name',
    'parked',
    '--upstream-model',
    'gpt-parked',
    '--timeout-ms',
    '30000',
    '--capabilities',
    '',
    '--enabled',
    'false',
  ]);
  cli([
    'register-deployment',
    '--tenant-id',
    alpha.tenantId,
    '--name',
    'quick',
    '--upstream-model',
    'gpt-quick',
    '--timeout-ms',
    '1000',
    '--capabilities',
    '',
    '--enabled',
    'true',
  ]);
  cli(['set-alias', '--tenant-id', alpha.tenantId, '--alias', 'auto', '--deployment', 'primary']);
  registerTenant(beta.tenantId, betaKey, 'beta', 'gpt-check-beta', 30000, '', true);
  cli(['set-alias', '--tenant-id', beta.tenantId, '--alias', 'auto', '--deployment', 'beta']);
  registerTenant(empty.tenantId, emptyKey, 'unused', 'gpt-unused', 30000, '', false);
  registerTenant(usage.tenantId, usageKey, 'usage-chat', 'gpt-usage', 30000, '', true);
  cli(['set-alias', '--tenant-id', usage.tenantId, '--alias', 'auto', '--deployment', 'usage-chat']);
  const listing = cli(['list-inference', '--tenant-id', alpha.tenantId]);
  state.listOutput = JSON.stringify(listing);
  state.fixtures = {
    alpha: {
      id: alpha.tenantId,
      secret: alpha.secret,
      keyId: alpha.keyId,
      secret2: alphaSecond.secret,
      keyId2: alphaSecond.keyId,
      apiKey: alphaKey,
      name: 'Check Alpha',
    },
    beta: { id: beta.tenantId, secret: beta.secret, keyId: beta.keyId, apiKey: betaKey, name: 'Check Beta' },
    empty: { id: empty.tenantId, secret: empty.secret, apiKey: emptyKey, name: 'Check Empty' },
    usage: { id: usage.tenantId, secret: usage.secret, apiKey: usageKey, name: 'Check Usage' },
    activeSecret: alphaSecond.secret,
  };
}

function fixturesFromEnv() {
  const names = [
    'CHECK_ALPHA_ID',
    'CHECK_ALPHA_SECRET',
    'CHECK_ALPHA_SECRET_2',
    'CHECK_BETA_ID',
    'CHECK_BETA_SECRET',
    'CHECK_EMPTY_ID',
    'CHECK_EMPTY_SECRET',
    'CHECK_USAGE_ID',
    'CHECK_USAGE_SECRET',
    'CHECK_MOCK_URL',
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (!state.baseUrl || missing.length > 0) {
    console.error(`Missing ${missing.join(', ') || 'PROXY_BASE_URL'}.`);
    console.error('Use --prepare-local to cover every case on the Colima stack.');
    return false;
  }
  state.mockUrl = process.env.CHECK_MOCK_URL.replace(/\/+$/, '');
  state.admin = process.env.CHECK_ADMIN === 'local';
  state.fixtures = {
    alpha: {
      id: process.env.CHECK_ALPHA_ID,
      secret: process.env.CHECK_ALPHA_SECRET,
      secret2: process.env.CHECK_ALPHA_SECRET_2,
      keyId: process.env.CHECK_ALPHA_KEY_ID ?? '',
      keyId2: process.env.CHECK_ALPHA_KEY_ID_2 ?? '',
      apiKey: process.env.CHECK_ALPHA_API_KEY ?? '',
      name: process.env.CHECK_ALPHA_NAME ?? 'Check Alpha',
    },
    beta: {
      id: process.env.CHECK_BETA_ID,
      secret: process.env.CHECK_BETA_SECRET,
      keyId: process.env.CHECK_BETA_KEY_ID ?? '',
      apiKey: process.env.CHECK_BETA_API_KEY ?? '',
      name: process.env.CHECK_BETA_NAME ?? 'Check Beta',
    },
    empty: {
      id: process.env.CHECK_EMPTY_ID,
      secret: process.env.CHECK_EMPTY_SECRET,
      apiKey: '',
      name: process.env.CHECK_EMPTY_NAME ?? 'Check Empty',
    },
    usage: {
      id: process.env.CHECK_USAGE_ID,
      secret: process.env.CHECK_USAGE_SECRET,
      apiKey: '',
      name: 'Check Usage',
    },
    activeSecret: process.env.CHECK_ALPHA_SECRET_2,
  };
  return true;
}

async function runHttpChecks() {
  const fx = state.fixtures;
  const alpha = fx.alpha;
  const beta = fx.beta;
  const active = () => fx.activeSecret;

  await check('health live', async () => {
    const response = await request('GET', '/health/live');
    if (response.status !== 200 || response.json?.status !== 'live') throw new Error('liveness failed');
  });

  await check('health ready', async () => {
    const response = await request('GET', '/health/ready');
    if (response.status !== 200 || response.json?.status !== 'ready' || response.json?.database !== 'ready') {
      throw new Error('readiness failed');
    }
  });

  await check('unknown route', async () => {
    const response = await request('GET', '/no-such-route');
    if (response.status !== 404 || response.json?.error !== 'not_found') throw new Error('not_found shape failed');
  });

  await check('accepts a matching tenant and secret', async () => {
    const response = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: alpha.secret });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const body = response.json;
    if (body.id !== alpha.id || body.name !== alpha.name) throw new Error('tenant body mismatch');
    if (Object.keys(body).sort().join() !== 'id,keys,name') throw new Error('tenant fields mismatch');
    if (response.text.includes(alpha.secret) || response.text.includes('scrypt$')) throw new Error('tenant body leaked a secret');
    if (!body.keys.some((key) => key.id === alpha.keyId)) throw new Error('key id missing');
  });

  await check('rejects missing, malformed, unknown, and mismatched credentials', async () => {
    const cases = [
      { secret: alpha.secret },
      { tenant: alpha.id },
      { tenant: alpha.id, headers: { authorization: 'Basic abc' } },
      { tenant: 'not-a-uuid', secret: alpha.secret },
      { tenant: '00000000-0000-4000-8000-000000000000', secret: alpha.secret },
      { tenant: alpha.id, secret: 'yck_wrongwrongwrongwrongwrongwrongwrong' },
      { tenant: beta.id, secret: alpha.secret },
    ];
    for (const item of cases) {
      const response = await request('GET', '/v1/tenant', item);
      if (response.status !== 401 || response.json?.error !== 'unauthorized') throw new Error(`status ${response.status}`);
      if (response.text.includes(alpha.name) || response.text.includes(beta.name)) throw new Error('unauthorized body named a tenant');
      if (response.text.includes(alpha.secret) || response.text.includes(alpha.id) || response.text.includes(beta.id)) {
        throw new Error('unauthorized body leaked tenant data');
      }
    }
  });

  await check('rejects a caller provider and api key', async () => {
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'openai',
        apiKey: 'sk-check-caller-secret',
      },
    });
    expectError(response, 400, 'unknown_parameter');
    if (response.text.includes('sk-check-caller-secret') || response.json?.choices || response.json?.object === 'chat.completion') {
      throw new Error('caller credential was accepted or echoed');
    }
  });

  await check('keeps another active key working after one key is revoked', async () => {
    const first = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: alpha.secret });
    const second = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: alpha.secret2 });
    if (!state.admin) {
      if (first.status !== 401 || second.status !== 200) throw new Error('remote revoked-key pair did not match');
    } else {
      if (first.status !== 200 || second.status !== 200) throw new Error('both keys should work before revocation');
      if (alpha.secret === alpha.secret2 || alpha.keyId === alpha.keyId2) throw new Error('keys were not distinct');
      const revoked = cli(['revoke-key', '--tenant-id', alpha.id, '--key-id', alpha.keyId]);
      if (revoked.revoked !== true) throw new Error('revoke did not report success');
    }
    const rejected = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: alpha.secret });
    const still = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: alpha.secret2 });
    if (rejected.status !== 401 || rejected.json?.error !== 'unauthorized') throw new Error('revoked key was accepted');
    if (rejected.text.includes(alpha.secret)) throw new Error('revoked response leaked the secret');
    if (still.status !== 200 || still.json?.id !== alpha.id || still.json?.name !== alpha.name) throw new Error('active key failed');
    if (still.text.includes(alpha.secret2) || still.text.includes('scrypt$')) throw new Error('active response leaked a secret');
    const ids = still.json.keys.map((key) => key.id);
    if (alpha.keyId && !ids.includes(alpha.keyId)) throw new Error('revoked key id missing');
    if (alpha.keyId2 && !ids.includes(alpha.keyId2)) throw new Error('active key id missing');
    fx.activeSecret = alpha.secret2;
  });

  await setMode('ok');
  const beforeSuccess = (await mockHits()).length;
  await check('accepts text messages and stream false', async () => {
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'alpha-only-prompt', { stream: false, temperature: 0.2 }),
    });
    if (response.status !== 200) throw new Error(`status ${response.status} ${response.text.slice(0, 160)}`);
    if (response.json?.object !== 'chat.completion') throw new Error('object mismatch');
    if (response.json?.model !== 'gpt-check-alpha') throw new Error(`model ${response.json?.model}`);
    if (response.json?.choices?.[0]?.message?.content !== 'saw alpha-only-prompt') throw new Error('content mismatch');
    if (response.json?.usage?.prompt_tokens !== 11 || response.json?.usage?.completion_tokens !== 7 || response.json?.usage?.total_tokens !== 18) {
      throw new Error('usage mismatch');
    }
    if (response.text.includes(alpha.apiKey) || response.text.includes(active())) throw new Error('response leaked a credential');
    const hits = await mockHits();
    const hit = hits.at(-1);
    if (hits.length !== beforeSuccess + 1) throw new Error(`hits ${hits.length}`);
    if (hit?.temperature !== 0.2 || hit?.model !== 'gpt-check-alpha') throw new Error('temperature was not forwarded');
    if (alpha.apiKey && hit?.authorization !== `Bearer ${alpha.apiKey}`) throw new Error('upstream authorization mismatch');
  });

  await check('rejects stream=true', async () => {
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'stream-prompt', { stream: true }),
    });
    expectError(response, 400, 'unsupported_parameter', 'stream');
    if ((await mockHits()).length !== hits) throw new Error('stream=true called upstream');
  });

  await check('rejects tools, images, audio, and unknown parameters', async () => {
    const hits = (await mockHits()).length;
    for (const key of unsupportedKeys) {
      const body = chatBody('auto', 'hi');
      body[key] = key === 'tools' ? [] : false;
      const response = await request('POST', '/v1/chat/completions', { tenant: alpha.id, secret: active(), body });
      expectError(response, 400, 'unsupported_parameter', key);
    }
    const image = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://img' } }] }] },
    });
    expectError(image, 400, 'unsupported_modality');
    const audio = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: { model: 'auto', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'aa' } }] }] },
    });
    expectError(audio, 400, 'unsupported_modality');
    const baseUrl = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'hi', { base_url: 'https://evil.example/v1' }),
    });
    expectError(baseUrl, 400, 'unknown_parameter', 'base_url');
    const format = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'hi', { response_format: { type: 'json_object' } }),
    });
    expectError(format, 400, 'unsupported_response_format', 'response_format');
    if ((await mockHits()).length !== hits) throw new Error('rejected parameters called upstream');
  });

  await check('rejects a supported parameter the deployment does not allow', async () => {
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'hi', { top_p: 0.5 }),
    });
    expectError(response, 400, 'unsupported_parameter', 'top_p');
    const count = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'hi', { n: 2 }),
    });
    expectError(count, 400, 'unsupported_parameter', 'n');
    if ((await mockHits()).length !== hits) throw new Error('disallowed parameter called upstream');
  });

  await check('resolves an alias and an explicit deployment name', async () => {
    const explicit = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('primary', 'explicit-primary'),
    });
    if (explicit.status !== 200 || explicit.json?.model !== 'gpt-check-alpha') throw new Error('explicit deployment failed');
    const betaResponse = await request('POST', '/v1/chat/completions', {
      tenant: beta.id,
      secret: beta.secret,
      body: chatBody('auto', 'beta-only-prompt'),
    });
    if (betaResponse.status !== 200 || betaResponse.json?.model !== 'gpt-check-beta') throw new Error('beta alias failed');
    if (betaResponse.json?.choices?.[0]?.message?.content !== 'saw beta-only-prompt') throw new Error('beta content mismatch');
    const from = new Date(Date.now() - 120000).toISOString();
    const to = new Date(Date.now() + 120000).toISOString();
    const alphaMetrics = await request('GET', '/internal/v1/metrics/summary', {
      tenant: alpha.id,
      secret: active(),
      query: { from, to },
    });
    const betaMetrics = await request('GET', '/internal/v1/metrics/summary', {
      tenant: beta.id,
      secret: beta.secret,
      query: { from, to },
    });
    if (alphaMetrics.status !== 200 || betaMetrics.status !== 200) throw new Error('metrics status failed');
    if (betaMetrics.json?.requests?.total !== 1) throw new Error('beta metrics included another tenant');
    if ((alphaMetrics.json?.requests?.total ?? 0) < 1) throw new Error('alpha metrics missing');
    if (JSON.stringify(alphaMetrics.json).includes('beta-only-prompt')) throw new Error('metrics leaked a prompt');
  });

  await check('skips a disabled deployment', async () => {
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('parked', 'parked-prompt'),
    });
    expectError(response, 404, 'model_not_found', 'model');
    const missing = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('missing', 'missing-prompt'),
    });
    expectError(missing, 404, 'model_not_found', 'model');
    if ((await mockHits()).length !== hits) throw new Error('disabled deployment called upstream');
  });

  await check('uses only that tenant alias', async () => {
    const hits = (await mockHits()).length;
    const crossed = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('beta', 'cross-prompt'),
    });
    expectError(crossed, 404, 'model_not_found', 'model');
    const other = await request('POST', '/v1/chat/completions', {
      tenant: beta.id,
      secret: beta.secret,
      body: chatBody('primary', 'cross-primary'),
    });
    expectError(other, 404, 'model_not_found', 'model');
    if ((await mockHits()).length !== hits) throw new Error('cross-tenant model called upstream');
  });

  await check('hides an upstream 500 and does not retry', async () => {
    await setMode('error500');
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'failure-prompt'),
    });
    expectError(response, 502, 'upstream_error');
    if (response.text.includes('upstream blew up') || response.text.includes('sk-check-upstream-secret')) {
      throw new Error('upstream error text was forwarded');
    }
    if ((await mockHits()).length !== hits + 1) throw new Error('upstream 500 was retried');
    await setMode('ok');
  });

  await check('maps an upstream 429', async () => {
    await setMode('rate429');
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'rate-prompt'),
    });
    expectError(response, 429, 'rate_limit');
    if (response.text.includes('sk-check-upstream-secret')) throw new Error('rate limit text was forwarded');
    if ((await mockHits()).length !== hits + 1) throw new Error('rate limit was retried');
    await setMode('ok');
  });

  await check('rejects an invalid upstream body', async () => {
    await setMode('invalid');
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'invalid-prompt'),
    });
    expectError(response, 502, 'invalid_upstream_response');
    await setMode('ok');
  });

  await check('omits missing usage and reports it', async () => {
    await setMode('omit-usage');
    const from = new Date(Date.now() - 60000).toISOString();
    const response = await request('POST', '/v1/chat/completions', {
      tenant: fx.usage.id,
      secret: fx.usage.secret,
      body: chatBody('auto', 'missing-usage-prompt'),
    });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    if (response.json?.usage !== undefined) throw new Error('missing usage was filled in');
    const to = new Date(Date.now() + 60000).toISOString();
    const metrics = await request('GET', '/internal/v1/metrics/summary', {
      tenant: fx.usage.id,
      secret: fx.usage.secret,
      query: { from, to },
    });
    if (metrics.status !== 200) throw new Error(`metrics ${metrics.status}`);
    if (metrics.json?.requests?.succeeded !== 1 || metrics.json?.requests?.total !== 1) throw new Error('usage request count mismatch');
    if (metrics.json?.usage?.promptTokens !== null || metrics.json?.usage?.responsesMissingUsage !== 1) {
      throw new Error('missing usage was summed as zero');
    }
    if (metrics.json?.latency?.samples !== 1) throw new Error('latency sample missing');
    const serialized = JSON.stringify(metrics.json);
    if (serialized.includes('cost') || serialized.includes('quality')) throw new Error('metrics included cost or quality');
    await setMode('ok');
  });

  await check('times out one upstream call', async () => {
    await setMode('hang');
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('quick', 'timeout-prompt'),
      signal: AbortSignal.timeout(15000),
    });
    expectError(response, 504, 'timeout');
    if ((await mockHits()).length !== hits + 1) throw new Error('timeout made more than one upstream call');
    await setMode('ok');
  });

  await check('cancels one upstream call', async () => {
    await setMode('hang');
    const hits = (await mockHits()).length;
    const controller = new AbortController();
    const pending = request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: active(),
      body: chatBody('auto', 'cancel-prompt'),
      signal: controller.signal,
    });
    const started = Date.now();
    while ((await mockHits()).length < hits + 1) {
      if (Date.now() - started > 10000) throw new Error('cancel request did not reach upstream');
      await sleep(50);
    }
    controller.abort();
    let aborted = false;
    try {
      await pending;
    } catch {
      aborted = true;
    }
    if (!aborted) throw new Error('cancelled request returned a response');
    if ((await mockHits()).length !== hits + 1) throw new Error('cancel made more than one upstream call');
    if (state.admin) {
      const tenantId = uuid(alpha.id);
      const deadline = Date.now() + 5000;
      let code = '';
      while (Date.now() < deadline) {
        code = query(
          `SELECT coalesce(error_code, '') FROM model_attempts WHERE tenant_id = '${tenantId}' AND upstream_model = 'gpt-check-alpha' ORDER BY created_at DESC LIMIT 1;`,
        );
        if (code === 'request_cancelled') break;
        await sleep(50);
      }
      if (code !== 'request_cancelled') throw new Error(`stored code ${code}`);
    }
    await setMode('ok');
  });

  await check('makes one upstream call per concurrent request', async () => {
    await setMode('ok');
    const hits = (await mockHits()).length;
    const responses = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        request('POST', '/v1/chat/completions', {
          tenant: alpha.id,
          secret: active(),
          body: chatBody('auto', `concurrent-prompt-${index}`),
        }),
      ),
    );
    if (responses.some((response) => response.status !== 200)) throw new Error('a concurrent request failed');
    const seen = await mockHits();
    const added = seen.slice(hits);
    if (added.length !== 4) throw new Error(`concurrent hits ${added.length}`);
    for (const index of [0, 1, 2, 3]) {
      if (added.filter((hit) => hit.content === `concurrent-prompt-${index}`).length !== 1) {
        throw new Error(`missing concurrent prompt ${index}`);
      }
    }
  });

  await check('lists only that tenant models', async () => {
    const alphaModels = await request('GET', '/v1/models', { tenant: alpha.id, secret: active() });
    const betaModels = await request('GET', '/v1/models', { tenant: beta.id, secret: beta.secret });
    if (alphaModels.json?.object !== 'list' || betaModels.json?.object !== 'list') throw new Error('models object mismatch');
    const alphaIds = new Map(alphaModels.json.data.map((item) => [item.id, item]));
    const betaIds = new Map(betaModels.json.data.map((item) => [item.id, item]));
    if (alphaIds.get('auto')?.owned_by !== 'llm-proxy') throw new Error('auto owned_by mismatch');
    if (alphaIds.get('primary')?.owned_by !== 'openai' || alphaIds.get('quick')?.owned_by !== 'openai') {
      throw new Error('deployment owned_by mismatch');
    }
    if (alphaIds.has('parked') || alphaIds.has('beta') || alphaIds.has('usage-chat')) throw new Error('alpha list leaked a model');
    if (!betaIds.has('auto') || !betaIds.has('beta') || betaIds.has('primary')) throw new Error('beta list mismatch');
    const unauthenticated = await request('GET', '/v1/models');
    expectError(unauthenticated, 401, 'invalid_api_key');
  });

  await check('openai sdk success, error, and models', async () => {
    const { default: OpenAI } = await import('openai');
    const hits = (await mockHits()).length;
    const client = new OpenAI({
      apiKey: active(),
      baseURL: `${state.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20000,
      defaultHeaders: { 'X-Tenant-ID': alpha.id },
    });
    const completion = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'contract-prompt' }],
    });
    if (completion.object !== 'chat.completion' || completion.model !== 'gpt-check-alpha') throw new Error('sdk success mismatch');
    if (completion.choices[0]?.message?.content !== 'saw contract-prompt') throw new Error('sdk content mismatch');
    if ((await mockHits()).length !== hits + 1) throw new Error('sdk success hit count mismatch');
    try {
      await client.chat.completions.create({
        model: 'auto',
        messages: [{ role: 'user', content: 'tools' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      });
      throw new Error('sdk accepted tools');
    } catch (error) {
      if (error?.status !== 400) throw new Error(`sdk tools status ${error?.status}`);
    }
    if ((await mockHits()).length !== hits + 1) throw new Error('sdk tools called upstream');
    const ids = [];
    for await (const model of client.models.list()) ids.push(model.id);
    if (!ids.includes('auto') || !ids.includes('primary') || ids.includes('beta')) throw new Error('sdk model list mismatch');
  });

  await check('metrics window', async () => {
    const missing = await request('GET', '/internal/v1/metrics/summary', { tenant: alpha.id, secret: active() });
    expectError(missing, 400, 'invalid_window');
    const huge = await request('GET', '/internal/v1/metrics/summary', {
      tenant: alpha.id,
      secret: active(),
      query: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
    });
    expectError(huge, 400, 'invalid_window', 'to');
    const backwards = await request('GET', '/internal/v1/metrics/summary', {
      tenant: alpha.id,
      secret: active(),
      query: { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    });
    expectError(backwards, 400, 'invalid_window');
    const ok = await request('GET', '/internal/v1/metrics/summary', {
      tenant: alpha.id,
      secret: active(),
      query: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
    });
    if (ok.status !== 200 || !ok.json?.requests || !ok.json?.usage || !ok.json?.latency) throw new Error('valid window failed');
    const chat = await request('POST', '/v1/chat/completions', { tenant: alpha.id, body: chatBody('auto', 'no-auth') });
    expectError(chat, 401, 'invalid_api_key');
  });

  await check('does not call upstream when no deployment is enabled', async () => {
    const hits = (await mockHits()).length;
    const response = await request('POST', '/v1/chat/completions', {
      tenant: fx.empty.id,
      secret: fx.empty.secret,
      body: chatBody('auto', 'empty-prompt'),
    });
    expectError(response, 404, 'model_not_found', 'model');
    if ((await mockHits()).length !== hits) throw new Error('empty tenant called upstream');
  });
}

async function runLocalChecks() {
  const fx = state.fixtures;
  const alpha = fx.alpha;
  const beta = fx.beta;

  await check('lists inference config without credential material', async () => {
    if (state.listOutput.includes(alpha.apiKey) || state.listOutput.includes('aes-256-gcm$') || state.listOutput.includes('sk-')) {
      throw new Error('list-inference exposed credential material');
    }
    if (state.registerOutput.includes(alpha.apiKey)) throw new Error('register exposed the api key');
    const listing = JSON.parse(state.listOutput);
    if (!listing.deployments?.some((item) => item.name === 'primary' && item.enabled === true)) {
      throw new Error('primary deployment was not listed');
    }
  });

  await check('stores a protected verifier and ciphertext', async () => {
    const tenantId = uuid(alpha.id);
    const keyId = uuid(alpha.keyId);
    const verifier = query(`SELECT verifier FROM tenant_api_keys WHERE id = '${keyId}';`);
    if (!verifier.startsWith('scrypt$') || verifier.includes(alpha.secret)) throw new Error('verifier was not protected');
    const ciphertext = query(`SELECT protected_credential FROM provider_connections WHERE tenant_id = '${tenantId}';`);
    if (!ciphertext.startsWith('aes-256-gcm$') || ciphertext.includes(alpha.apiKey)) throw new Error('ciphertext was not protected');
    const leaked = query(
      `SELECT count(*) FROM (
         SELECT name AS value FROM tenants
         UNION ALL SELECT verifier FROM tenant_api_keys
         UNION ALL SELECT coalesce(label, '') FROM tenant_api_keys
       ) rows WHERE strpos(value, '${alpha.secret.replace(/'/g, '')}') > 0;`,
    );
    if (leaked !== '0') throw new Error('secret was stored in a readable column');
  });

  await check('does not call upstream when inference is disabled', async () => {
    const hits = (await mockHits()).length;
    recreateApp({
      INFERENCE_ENABLED: 'false',
      OPENAI_BASE_URL: mockInternal,
      PROVIDER_CREDENTIAL_KEY: state.credentialKey,
    });
    try {
      await waitReady();
      const rejected = await request('POST', '/v1/chat/completions', {
        tenant: alpha.id,
        secret: fx.activeSecret,
        body: chatBody('auto', 'disabled-tools', { tools: [] }),
      });
      expectError(rejected, 400, 'unsupported_parameter', 'tools');
      const response = await request('POST', '/v1/chat/completions', {
        tenant: alpha.id,
        secret: fx.activeSecret,
        body: chatBody('auto', 'disabled-prompt'),
      });
      expectError(response, 503, 'inference_disabled');
      if ((await mockHits()).length !== hits) throw new Error('disabled inference called upstream');
    } finally {
      recreateApp({
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: mockInternal,
        PROVIDER_CREDENTIAL_KEY: state.credentialKey,
      });
      await waitReady();
    }
  });

  await check('skips a disabled connection', async () => {
    const hits = (await mockHits()).length;
    try {
      cli(['set-connection-enabled', '--tenant-id', alpha.id, '--enabled', 'false']);
      const response = await request('POST', '/v1/chat/completions', {
        tenant: alpha.id,
        secret: fx.activeSecret,
        body: chatBody('auto', 'connection-off'),
      });
      expectError(response, 404, 'model_not_found', 'model');
      if ((await mockHits()).length !== hits) throw new Error('disabled connection called upstream');
    } finally {
      cli(['set-connection-enabled', '--tenant-id', alpha.id, '--enabled', 'true']);
    }
    const restored = await request('POST', '/v1/chat/completions', {
      tenant: alpha.id,
      secret: fx.activeSecret,
      body: chatBody('auto', 'connection-on'),
    });
    if (restored.status !== 200) throw new Error('connection was not re-enabled');
  });

  await check('tenant isolation holds for runtime queries', async () => {
    const alphaId = uuid(alpha.id);
    const betaId = uuid(beta.id);
    const betaKey = uuid(beta.keyId);
    const seen = query(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${alphaId}', true) IS NOT NULL;
       SELECT id::text FROM tenants ORDER BY id;
       COMMIT;`,
      'llm_runtime',
    );
    const ids = seen.split('\n').map((line) => line.trim()).filter((line) => line.includes('-'));
    if (ids.length !== 1 || ids[0] !== alphaId) throw new Error('runtime saw another tenant');
    const keys = query(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${alphaId}', true) IS NOT NULL;
       SELECT id::text FROM tenant_api_keys ORDER BY id;
       COMMIT;`,
      'llm_runtime',
    );
    if (keys.includes(betaKey)) throw new Error('runtime saw another tenant key');
    const crossed = await request('GET', '/v1/tenant', { tenant: beta.id, secret: alpha.secret2 });
    if (crossed.status !== 401 || crossed.text.includes(beta.name)) throw new Error('crossed credential revealed a tenant');
    query('GRANT UPDATE (label, tenant_id) ON tenant_api_keys TO llm_runtime;');
    try {
      query(
        `BEGIN;
         SELECT set_config('app.tenant_id', '${alphaId}', true) IS NOT NULL;
         UPDATE tenant_api_keys SET label = 'hacked' WHERE tenant_id = '${betaId}';
         COMMIT;`,
        'llm_runtime',
      );
      queryFails(
        `BEGIN;
         SELECT set_config('app.tenant_id', '${alphaId}', true) IS NOT NULL;
         UPDATE tenant_api_keys SET tenant_id = '${betaId}' WHERE tenant_id = '${alphaId}';
         COMMIT;`,
        'llm_runtime',
        /row-level security/i,
      );
    } finally {
      query('REVOKE UPDATE (label, tenant_id) ON tenant_api_keys FROM llm_runtime;');
    }
    const label = query(`SELECT label FROM tenant_api_keys WHERE id = '${betaKey}';`);
    if (label === 'hacked') throw new Error('beta label changed');
    const deployments = query(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${alphaId}', true) IS NOT NULL;
       SELECT name FROM model_deployments ORDER BY name;
       COMMIT;`,
      'llm_runtime',
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 't');
    if (deployments.includes('beta') || deployments.includes('usage-chat') || !deployments.includes('primary')) {
      throw new Error('deployment list crossed tenants');
    }
  });

  await check('runtime role fails closed', async () => {
    const roles = query(
      `SELECT rolname || '|' || rolsuper::text || '|' || rolbypassrls::text || '|' || rolcanlogin::text || '|' || rolinherit::text
       FROM pg_roles
       WHERE rolname IN ('llm_owner', 'llm_migrator', 'llm_auth', 'llm_runtime')
       ORDER BY rolname;`,
    );
    const byName = new Map(roles.split('\n').filter(Boolean).map((line) => [line.split('|')[0], line.split('|')]));
    const expectRole = (name, flags) => {
      const row = byName.get(name);
      if (!row || row.slice(1).join('|') !== flags) throw new Error(`role ${name} flags ${row?.join('|')}`);
    };
    expectRole('llm_auth', 'false|false|true|false');
    expectRole('llm_migrator', 'false|false|true|false');
    expectRole('llm_owner', 'false|true|false|true');
    expectRole('llm_runtime', 'false|false|true|false');
    const members = query(
      `SELECT count(*)
       FROM pg_auth_members m
       JOIN pg_roles parent ON parent.oid = m.roleid
       JOIN pg_roles child ON child.oid = m.member
       WHERE parent.rolname = 'llm_owner'
         AND child.rolname IN ('llm_runtime', 'llm_auth');`,
    );
    if (!members.includes('0')) throw new Error('runtime or auth can assume llm_owner');
    const forced = query(
      `SELECT relname || '|' || relrowsecurity::text || '|' || relforcerowsecurity::text
       FROM pg_class
       WHERE relname IN ('tenants', 'tenant_api_keys', 'provider_connections', 'model_deployments', 'model_aliases', 'proxy_requests', 'model_attempts')
       ORDER BY relname;`,
    );
    for (const line of forced.split('\n').filter(Boolean)) {
      if (!line.endsWith('|true|true')) throw new Error(`row security is not forced for ${line}`);
    }
    if (query('SELECT count(*) FROM tenants;', 'llm_runtime') !== '0') throw new Error('unset tenant saw rows');
    if (query('SELECT count(*) FROM proxy_requests;', 'llm_runtime') !== '0') throw new Error('unset tenant saw requests');
    queryFails('SELECT verifier FROM tenant_api_keys;', 'llm_runtime', /permission denied/i);
    queryFails('SELECT id FROM tenants;', 'llm_auth', /permission denied/i);
    queryFails("SELECT key_id FROM list_active_key_verifiers('00000000-0000-4000-8000-000000000000');", 'llm_runtime', /permission denied/i);
    queryFails('SELECT id, name FROM tenants;', 'llm_migrator', /permission denied/i);
    queryFails('SET ROLE llm_owner;', 'llm_runtime', /permission denied|cannot/i);
    queryFails(
      `BEGIN; SELECT set_config('app.tenant_id', '${uuid(alpha.id)}', true); SELECT protected_credential FROM provider_connections; COMMIT;`,
      'llm_runtime',
      /permission denied/i,
    );
  });

  await check('clears tenant context before a connection returns to the pool', async () => {
    await request('GET', '/v1/tenant', { tenant: alpha.id, secret: fx.activeSecret });
    const setting = query(`SELECT coalesce(current_setting('app.tenant_id', true), '');`, 'llm_runtime');
    if (setting !== '') throw new Error('a new runtime session kept a tenant setting');
    if (query('SELECT count(*) FROM tenants;', 'llm_runtime') !== '0') throw new Error('a new runtime session saw tenant rows');
    const tenantId = uuid(beta.id);
    const scoped = query(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true) IS NOT NULL;
       SELECT id::text FROM tenants;
       COMMIT;`,
      'llm_runtime',
    );
    if (!scoped.includes(tenantId) || scoped.includes(alpha.id)) throw new Error('scoped session saw the wrong tenant');
    if (query(`SELECT coalesce(current_setting('app.tenant_id', true), '');`, 'llm_runtime') !== '') {
      throw new Error('tenant setting survived the transaction');
    }
  });

  await check('logs omit secrets, prompts, and verifiers', async () => {
    await request('GET', '/v1/tenant', {
      tenant: alpha.id,
      secret: 'yck_wrongwrongwrongwrongwrongwrongwrong',
    });
    await request('GET', '/v1/tenant', { tenant: alpha.id, secret: fx.activeSecret });
    const text = appLogs();
    const forbidden = [
      alpha.secret,
      alpha.secret2,
      beta.secret,
      fx.empty.secret,
      fx.usage.secret,
      alpha.apiKey,
      beta.apiKey,
      'yck_wrongwrongwrongwrongwrongwrongwrong',
      'alpha-only-prompt',
      'beta-only-prompt',
      'scrypt$',
      'aes-256-gcm$',
      state.credentialKey,
    ];
    for (const value of forbidden) {
      if (value && text.includes(value)) throw new Error('app log contained protected material');
    }
    if (!text.includes('credential rejected') || !text.includes('tenant request accepted')) {
      throw new Error('expected auth log events were missing');
    }
  });

  await check('persistence failure makes no upstream call', async () => {
    const hits = (await mockHits()).length;
    query('REVOKE INSERT ON proxy_requests FROM llm_runtime;');
    try {
      const response = await request('POST', '/v1/chat/completions', {
        tenant: alpha.id,
        secret: fx.activeSecret,
        body: chatBody('auto', 'persist-prompt'),
      });
      expectError(response, 503, 'service_unavailable');
      if (response.text.includes('persist-prompt')) throw new Error('persistence error echoed the prompt');
      if ((await mockHits()).length !== hits) throw new Error('persistence failure called upstream');
    } finally {
      query('GRANT SELECT, INSERT ON proxy_requests TO llm_runtime;');
    }
  });

  await check('telemetry failure still returns the completion', async () => {
    const hits = (await mockHits()).length;
    query('REVOKE UPDATE ON model_attempts FROM llm_runtime;');
    try {
      const response = await request('POST', '/v1/chat/completions', {
        tenant: alpha.id,
        secret: fx.activeSecret,
        body: chatBody('auto', 'telemetry-prompt-zeta'),
      });
      if (response.status !== 200 || response.json?.choices?.[0]?.message?.content !== 'saw telemetry-prompt-zeta') {
        throw new Error('telemetry failure hid the completion');
      }
      if ((await mockHits()).length !== hits + 1) throw new Error('telemetry failure retried upstream');
      const logs = appLogs();
      if (!logs.includes('attempt result was not recorded') || !logs.includes('"severity":"critical"')) {
        throw new Error('critical telemetry log was missing');
      }
      if (logs.includes('telemetry-prompt-zeta') || logs.includes(alpha.apiKey)) throw new Error('telemetry log leaked material');
      const status = query(
        `SELECT status FROM proxy_requests WHERE tenant_id = '${uuid(alpha.id)}' ORDER BY created_at DESC LIMIT 1;`,
      );
      if (status !== 'pending') throw new Error(`request status ${status}`);
    } finally {
      query(
        `GRANT UPDATE (
           status, error_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
           provider_request_id, stop_reason, uncached_input_tokens, cache_creation_input_tokens,
           cache_read_input_tokens
         )
         ON model_attempts TO llm_runtime;`,
      );
    }
  });

  await check('readiness follows postgres and SIGTERM closes pools', async () => {
    const before = query('SELECT count(*) FROM tenants;');
    state.postgresStopped = true;
    compose(['stop', 'postgres'], { timeout: 60000 });
    const live = await request('GET', '/health/live');
    if (live.status !== 200 || live.json?.status !== 'live') throw new Error('liveness failed while postgres was down');
    const started = Date.now();
    let readyStatus = 0;
    while (Date.now() - started < 30000) {
      try {
        const ready = await request('GET', '/health/ready', { signal: AbortSignal.timeout(8000) });
        readyStatus = ready.status;
        if (ready.status === 503 && ready.json?.status === 'not_ready' && ready.json?.database === 'unavailable') break;
      } catch {
        readyStatus = 0;
      }
      await sleep(300);
    }
    if (readyStatus !== 503) throw new Error(`readiness stayed ${readyStatus}`);
    compose(['start', 'postgres'], { timeout: 60000 });
    state.postgresStopped = false;
    await waitReady();
    const id = appContainerId();
    const stopped = run('docker', ['stop', '-t', '25', id], { timeout: 40000 });
    if (stopped.status !== 0) throw new Error('docker stop failed');
    const logs = run('docker', ['logs', id]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    if (!text.includes('"pools":"closed"')) throw new Error('shutdown did not close the pools');
    if (text.includes(alpha.secret2)) throw new Error('shutdown log leaked a secret');
    compose(['start', 'app'], { timeout: 60000 });
    await waitReady();
    const again = await request('GET', '/v1/tenant', { tenant: alpha.id, secret: fx.activeSecret });
    if (again.status !== 200 || again.json?.name !== alpha.name) throw new Error('tenant failed after restart');
    if (query('SELECT count(*) FROM tenants;') !== before) throw new Error('tenant count changed across restart');
  });

  await check('migrations keep tenant rows on a second boot', async () => {
    const before = query('SELECT count(*) FROM tenants;');
    const versions = query('SELECT version FROM schema_migrations ORDER BY version;');
    for (const version of ['001_schema.sql', '002_security.sql', '003_inference.sql']) {
      if (!versions.includes(version)) throw new Error(`missing ${version}`);
    }
    const id = appContainerId();
    const stopped = run('docker', ['stop', '-t', '25', id], { timeout: 40000 });
    if (stopped.status !== 0) throw new Error('restart stop failed');
    compose(['start', 'app'], { timeout: 60000 });
    await waitReady();
    const logs = appLogs();
    const applied = logs
      .split('\n')
      .filter((line) => line.includes('migrations complete'))
      .at(-1);
    if (!applied || !applied.includes('"applied":[]')) throw new Error('second boot applied migrations again');
    if (query('SELECT count(*) FROM tenants;') !== before) throw new Error('second boot changed tenant rows');
    const row = query(
      `SELECT r.id::text || '|' || a.id::text || '|' || r.status || '|' || a.status || '|' || a.prompt_tokens || '|' || a.completion_tokens || '|' || a.total_tokens
       FROM proxy_requests r
       JOIN model_attempts a ON a.request_id = r.id AND a.tenant_id = r.tenant_id
       WHERE r.tenant_id = '${uuid(alpha.id)}' AND a.upstream_model = 'gpt-check-alpha' AND a.prompt_tokens = 11
       ORDER BY r.created_at
       LIMIT 1;`,
    );
    const parts = row.split('|');
    if (parts.length !== 7 || parts[0] === parts[1] || parts[2] !== 'succeeded' || parts[3] !== 'succeeded') {
      throw new Error('persisted success row mismatch');
    }
    if (parts[4] !== '11' || parts[5] !== '7' || parts[6] !== '18') throw new Error('persisted usage mismatch');
    const columns = query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('proxy_requests', 'model_attempts');`,
    );
    const sensitive = columns
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name && !name.endsWith('_tokens') && /prompt|messages|content|response|secret|credential/i.test(name));
    if (sensitive.length > 0) throw new Error('request tables store prompt or credential columns');
  });

  const marker = `marker-${randomBytes(8).toString('hex')}`;
  const authMarker = `auth-${randomBytes(8).toString('hex')}`;
  const runtimeMarker = `runtime-${randomBytes(8).toString('hex')}`;

  function runImage(env, extraArgs = []) {
    return run(
      'docker',
      ['run', '--rm', ...extraArgs, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), state.image],
      { timeout: 20000 },
    );
  }

  const baseEnv = {
    MIGRATOR_USER: 'llm_migrator',
    MIGRATOR_PASSWORD: marker,
    AUTH_USER: 'llm_auth',
    AUTH_PASSWORD: authMarker,
    RUNTIME_USER: 'llm_runtime',
    RUNTIME_PASSWORD: runtimeMarker,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'llm_proxy',
    LOG_LEVEL: 'info',
  };

  await check('rejects incomplete configuration without echoing secrets', async () => {
    const result = runImage(baseEnv, ['--network', 'none']);
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1) throw new Error(`exit ${result.status}`);
    if (!text.includes('DATABASE_HOST') || !text.includes('invalid configuration')) throw new Error('missing setting was not reported');
    if (text.includes(marker) || text.includes(authMarker) || text.includes(runtimeMarker)) throw new Error('config error echoed a secret');
  });

  await check('rejects an invalid log level', async () => {
    const result = runImage({ ...baseEnv, DATABASE_HOST: '127.0.0.1', LOG_LEVEL: 'verbose' }, ['--network', 'none']);
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1 || !text.includes('LOG_LEVEL')) throw new Error('invalid log level was accepted');
    if (text.includes(marker)) throw new Error('log level error echoed a secret');
  });

  await check('exits before listening when a required setting is missing', async () => {
    const result = runImage({ ...baseEnv, PORT: '8080' }, ['-p', '127.0.0.1:18082:8080']);
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1) throw new Error(`exit ${result.status}`);
    if (text.includes('listening') || text.includes(marker)) throw new Error('process listened or echoed a secret');
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
    if (lines.length === 0) throw new Error('config failure was not json');
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.msg !== 'invalid configuration') throw new Error('unexpected log event');
    }
    let refused = false;
    try {
      await fetch('http://127.0.0.1:18082/health/ready');
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a listener stayed up after config failure');
  });

  await check('requires a credential key when inference is enabled and does not echo it', async () => {
    const result = runImage(
      { ...baseEnv, DATABASE_HOST: '127.0.0.1', INFERENCE_ENABLED: 'true' },
      ['--network', 'none'],
    );
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 1 || !text.includes('PROVIDER_CREDENTIAL_KEY')) throw new Error('missing credential key was accepted');
    if (text.includes(marker) || text.includes(authMarker) || text.includes(runtimeMarker)) {
      throw new Error('credential key error echoed a secret');
    }
  });
}

async function cleanup() {
  if (!state.prepared) return;
  try {
    query(
      `GRANT SELECT, INSERT ON proxy_requests TO llm_runtime;
       GRANT UPDATE (
         status, error_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
         provider_request_id, stop_reason, uncached_input_tokens, cache_creation_input_tokens,
         cache_read_input_tokens
       ) ON model_attempts TO llm_runtime;
       REVOKE UPDATE (label, tenant_id) ON tenant_api_keys FROM llm_runtime;`,
    );
  } catch (error) {
    failed.push('restore grants');
    console.error(`FAIL restore grants: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  if (state.postgresStopped) {
    compose(['start', 'postgres'], { timeout: 60000 });
    state.postgresStopped = false;
  }
  if (state.leavePrepared) {
    console.log('left the local app pointed at the check mock');
    return;
  }
  if (state.savedEnv) {
    recreateApp(state.savedEnv);
    await waitReady();
  }
  run('docker', ['rm', '-f', mockName]);
}

function usage() {
  console.log(`Usage:
  node scripts/check-deployed.mjs --prepare-local [--leave-prepared]
  node scripts/check-deployed.mjs --base-url <url> [--http-only]

--prepare-local covers every request/response case on the Colima Compose stack.
It also covers the database and process cases. The app is restored afterwards.

A configured instance uses PROXY_BASE_URL or --base-url, plus:
  CHECK_MOCK_URL
  CHECK_ALPHA_ID CHECK_ALPHA_SECRET CHECK_ALPHA_SECRET_2
  CHECK_BETA_ID CHECK_BETA_SECRET
  CHECK_EMPTY_ID CHECK_EMPTY_SECRET
  CHECK_USAGE_ID CHECK_USAGE_SECRET
CHECK_ALPHA_SECRET is revoked. CHECK_ALPHA_SECRET_2 is active.
Deployments: primary (temperature, alias auto), parked (disabled), quick (short timeout),
beta (alias auto), usage-chat (alias auto), and an empty tenant with no enabled deployment.
Set CHECK_ADMIN=local to include the database and process cases.
--http-only exits after the HTTP cases.
`);
}

async function main() {
  const options = {
    prepareLocal: false,
    httpOnly: false,
    leavePrepared: false,
    baseUrl: process.env.PROXY_BASE_URL ?? '',
    help: false,
  };
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--prepare-local') options.prepareLocal = true;
    else if (arg === '--http-only') options.httpOnly = true;
    else if (arg === '--leave-prepared') options.leavePrepared = true;
    else if (arg === '--base-url') {
      options.baseUrl = process.argv[index + 1] ?? '';
      index += 1;
    } else {
      console.error(`Unknown argument ${arg}`);
      usage();
      process.exit(2);
    }
  }
  if (options.help || (!options.prepareLocal && !options.baseUrl)) {
    usage();
    process.exit(options.help ? 0 : 2);
  }
  state.leavePrepared = options.leavePrepared;
  state.baseUrl = (options.prepareLocal ? 'http://127.0.0.1:8080' : options.baseUrl).replace(/\/+$/, '');

  try {
    if (options.prepareLocal) {
      console.log('preparing the local Colima stack');
      prepareLocal();
      console.log('waiting for the mock');
      await waitMock();
      console.log('waiting for the app');
      await waitReady();
      console.log('provisioning fixtures');
      await provisionFixtures();
      console.log('fixtures are ready');
    } else if (!fixturesFromEnv()) {
      process.exit(2);
    }
    await setMode('ok');
    await runHttpChecks();
    if (state.admin) await runLocalChecks();
    else if (!options.httpOnly) {
      failed.push('local deployment cases');
      console.error('FAIL local deployment cases: set --prepare-local or CHECK_ADMIN=local');
    }
  } catch (error) {
    failed.push('setup');
    console.error(`FAIL setup: ${describeError(error)}`);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failed.push('cleanup');
      console.error(`FAIL cleanup: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }

  const required = state.admin ? [...httpRequired, ...localRequired] : options.httpOnly ? httpRequired : httpRequired;
  const finished = new Set([...passed, ...failed]);
  for (const name of required) {
    if (!finished.has(name)) {
      failed.push(name);
      console.error(`FAIL ${name}: not run`);
    }
  }
  console.log(`${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
