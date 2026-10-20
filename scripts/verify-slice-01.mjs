#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.argv[2];
if (!scratch) {
  process.stderr.write('usage: node scripts/verify-slice-01.mjs <scratch-dir>\n');
  process.exit(1);
}
const journeyDir = join(scratch, 'journey');
mkdirSync(journeyDir, { recursive: true });

const credentialKey = randomBytes(32).toString('base64');
const alphaApiKey = 'sk-test-journey-alpha';
const betaApiKey = 'sk-test-journey-beta';
const alphaPrompt = 'journey-prompt-alpha';
const betaPrompt = 'journey-prompt-beta';
const secrets = [credentialKey, alphaApiKey, betaApiKey];
const notes = [];
const state = {
  inference: 'false',
  baseUrl: 'https://api.openai.com/v1',
};

const MOCK_NAME = 'llm-proxy-journey-mock';
const PREVIOUS_NAME = 'llm-proxy-slice00-run';

function note(line) {
  notes.push(line);
  process.stdout.write(`${line}\n`);
}

function redact(text) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/yck_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/scrypt\$[A-Za-z0-9_$./-]+/g, '[REDACTED]')
    .replace(/aes-256-gcm\$[A-Za-z0-9_$-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/migrator_local_dev/g, '[REDACTED]')
    .replace(/auth_local_dev/g, '[REDACTED]')
    .replace(/runtime_local_dev/g, '[REDACTED]')
    .replace(/postgres:\/\/\S+/g, '[REDACTED]');
}

function writeNotes() {
  writeFileSync(join(journeyDir, 'transcript.txt'), `${notes.join('\n')}\n`);
}

function fail(message) {
  note(`FAIL ${message}`);
  writeNotes();
  cleanup();
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compose(args, options = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      INFERENCE_ENABLED: state.inference,
      OPENAI_BASE_URL: state.baseUrl,
      PROVIDER_CREDENTIAL_KEY: credentialKey,
    },
    ...options,
  });
}

function must(result, label) {
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}: ${redact(result.stderr || result.stdout || '')}`);
  }
  return result;
}

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function psql(sql) {
  const result = must(
    compose(
      ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'llm_proxy', '-v', 'ON_ERROR_STOP=1', '-t', '-A'],
      { input: sql },
    ),
    'psql',
  );
  return result.stdout.trim();
}

function remember(secret) {
  if (!secret || !secret.startsWith('yck_') || secret.length < 40) fail('credential was not a high-entropy secret');
  secrets.push(secret);
}

function cli(args) {
  const result = compose(['run', '--rm', '--no-deps', 'app', 'node', 'dist/cli.js', ...args]);
  if (result.status !== 0) {
    fail(`cli ${args[0]} exited ${result.status}: ${redact(result.stderr || result.stdout || '')}`);
  }
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .at(-1);
  if (!line) fail(`cli ${args[0]} did not print JSON`);
  return JSON.parse(line);
}

function previousCli(args) {
  const result = docker([
    'run',
    '--rm',
    '--network',
    networkName(),
    ...dbEnv(),
    'llm-proxy:slice-00',
    'node',
    'dist/cli.js',
    ...args,
  ]);
  if (result.status !== 0) {
    fail(`slice-00 cli ${args[0]} exited ${result.status}: ${redact(result.stderr || result.stdout || '')}`);
  }
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .at(-1);
  if (!line) fail(`slice-00 cli ${args[0]} did not print JSON`);
  return JSON.parse(line);
}

let network = '';

function networkName() {
  if (network) return network;
  const id = must(compose(['ps', '-q', 'postgres']), 'compose ps postgres').stdout.trim().split('\n')[0];
  if (!id) fail('postgres container is missing');
  const inspected = must(
    docker(['inspect', '-f', '{{range $name, $net := .NetworkSettings.Networks}}{{$name}}{{end}}', id]),
    'inspect network',
  );
  network = inspected.stdout.trim();
  if (!network) fail('compose network is missing');
  return network;
}

function dbEnv() {
  return [
    '-e',
    'HOST=0.0.0.0',
    '-e',
    'PORT=8080',
    '-e',
    'DATABASE_HOST=postgres',
    '-e',
    'DATABASE_PORT=5432',
    '-e',
    'DATABASE_NAME=llm_proxy',
    '-e',
    'MIGRATOR_USER=llm_migrator',
    '-e',
    'MIGRATOR_PASSWORD=migrator_local_dev',
    '-e',
    'AUTH_USER=llm_auth',
    '-e',
    'AUTH_PASSWORD=auth_local_dev',
    '-e',
    'RUNTIME_USER=llm_runtime',
    '-e',
    'RUNTIME_PASSWORD=runtime_local_dev',
    '-e',
    'LOG_LEVEL=info',
  ];
}

function serverContainerId() {
  const result = must(compose(['ps', '-q', 'app']), 'compose ps app');
  const id = result.stdout.trim().split('\n').filter(Boolean)[0];
  if (!id) fail('app container is missing');
  return id;
}

async function waitReady() {
  const started = Date.now();
  let last = 'not started';
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch('http://127.0.0.1:8080/health/ready');
      const text = await response.text();
      last = `${response.status} ${text}`;
      if (response.ok && text.includes('"database":"ready"')) return text;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await sleep(1000);
  }
  fail(`readiness timeout: ${last}`);
}

async function waitPostgres() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const ready = compose(['exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', '-d', 'llm_proxy']);
    const roles = compose(
      ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'llm_proxy', '-t', '-A', '-c', "SELECT count(*) FROM pg_roles WHERE rolname = 'llm_runtime'"],
    );
    if (ready.status === 0 && roles.stdout.trim() === '1') return;
    await sleep(1000);
  }
  fail('postgres did not become ready');
}

function appLogs() {
  const logs = docker(['logs', serverContainerId()]);
  return `${logs.stdout || ''}${logs.stderr || ''}`;
}

function assertNoSensitiveLogs(rawLogs, path) {
  if (
    rawLogs.includes(alphaPrompt) ||
    rawLogs.includes(betaPrompt) ||
    rawLogs.includes('alpha-ok') ||
    rawLogs.includes('beta-ok') ||
    secrets.some((secret) => rawLogs.includes(secret))
  ) {
    fail('app logs contained a prompt, response, or secret');
  }
  writeFileSync(path, redact(rawLogs));
}

function migrationAppliedLines() {
  return appLogs()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('migrations complete'));
}

async function hits() {
  const result = docker([
    'exec',
    MOCK_NAME,
    'node',
    '-e',
    "fetch('http://127.0.0.1:8081/hits').then((response) => response.text()).then((text) => process.stdout.write(text))",
  ]);
  if (result.status !== 0) fail(`mock hits exited ${result.status}: ${redact(result.stderr || '')}`);
  return JSON.parse(result.stdout || '[]');
}

async function chat(tenantId, secret, body) {
  const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : {} };
}

async function tenantRead(tenantId, secret) {
  const response = await fetch('http://127.0.0.1:8080/v1/tenant', {
    headers: {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
    },
  });
  const text = await response.text();
  return { status: response.status, text };
}

function startPrevious() {
  const result = docker([
    'run',
    '-d',
    '--name',
    PREVIOUS_NAME,
    '--network',
    networkName(),
    '-p',
    '8080:8080',
    ...dbEnv(),
    'llm-proxy:slice-00',
  ]);
  if (result.status !== 0) fail(`previous image start failed: ${redact(result.stderr || result.stdout || '')}`);
}

function stopPrevious() {
  docker(['rm', '-f', PREVIOUS_NAME]);
}

function startMock() {
  const source = `
const http = require('http');
const hits = [];
const server = http.createServer((request, response) => {
  if (request.url === '/hits') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(hits));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = {}; }
    const content = parsed.messages && parsed.messages[0] && parsed.messages[0].content;
    hits.push({
      authorization: String(request.headers.authorization || ''),
      model: typeof parsed.model === 'string' ? parsed.model : '',
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : null,
      contentLength: typeof content === 'string' ? content.length : 0,
    });
    const text = parsed.model === 'gpt-journey-alpha' ? 'alpha-ok' : 'beta-ok';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-journey',
      object: 'chat.completion',
      created: 1700000000,
      model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
});
server.listen(8081, '0.0.0.0');
`;
  const result = docker([
    'run',
    '-d',
    '--name',
    MOCK_NAME,
    '--network',
    networkName(),
    'node:24-bookworm-slim',
    'node',
    '-e',
    source,
  ]);
  if (result.status !== 0) fail(`mock start failed: ${redact(result.stderr || result.stdout || '')}`);
}

function cleanup() {
  stopPrevious();
  docker(['rm', '-f', MOCK_NAME]);
  compose(['down', '-v', '--remove-orphans']);
}

function registerTenant(tenant, apiKey, deployment, upstreamModel) {
  cli(['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', apiKey]);
  cli([
    'register-deployment',
    '--tenant-id',
    tenant.tenantId,
    '--name',
    deployment,
    '--upstream-model',
    upstreamModel,
    '--timeout-ms',
    '5000',
    '--capabilities',
    'temperature',
    '--enabled',
    'true',
  ]);
  cli(['set-alias', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--deployment', deployment]);
}

async function main() {
  const imageFiles = docker(['run', '--rm', '--entrypoint', 'ls', 'llm-proxy:slice-00', 'migrations']);
  if (imageFiles.status !== 0) fail(`slice-00 image is missing: ${redact(imageFiles.stderr || '')}`);
  if (!imageFiles.stdout.includes('002_security.sql') || imageFiles.stdout.includes('003_inference.sql')) {
    fail('slice-00 image does not match the previous service');
  }
  note('previous image contains 002_security.sql and does not contain 003_inference.sql');

  must(compose(['down', '-v', '--remove-orphans']), 'compose down');
  must(compose(['up', '-d', 'postgres']), 'postgres up');
  await waitPostgres();
  note(`network ${networkName()}`);
  startMock();
  state.baseUrl = `http://${MOCK_NAME}:8081/v1`;
  state.inference = 'true';

  startPrevious();
  const previousReady = await waitReady();
  note(`slice-00 ready ${previousReady}`);
  const kept = previousCli(['provision-tenant', '--name', 'Kept']);
  remember(kept.secret);
  const keptBefore = await tenantRead(kept.tenantId, kept.secret);
  if (keptBefore.status !== 200 || !keptBefore.text.includes('Kept')) fail('slice-00 tenant read failed');
  const versionsBefore = psql('SELECT version FROM schema_migrations ORDER BY 1');
  note(`versions before 003: ${versionsBefore.replaceAll('\n', ',')}`);
  if (versionsBefore !== '001_schema.sql\n002_security.sql') fail(`unexpected versions before 003: ${versionsBefore}`);
  const keptCountBefore = psql("SELECT count(*) FROM tenants WHERE name = 'Kept'");
  if (keptCountBefore !== '1') fail('kept tenant was not stored');
  stopPrevious();

  const up = compose(['up', '-d', '--build', 'app']);
  if (up.status !== 0) fail(`app up exited ${up.status}: ${redact(up.stderr || up.stdout || '')}`);
  const ready = await waitReady();
  writeFileSync(join(scratch, 'ready.json'), ready.endsWith('\n') ? ready : `${ready}\n`);
  const live = await fetch('http://127.0.0.1:8080/health/live');
  const liveBody = await live.text();
  writeFileSync(join(scratch, 'live.json'), liveBody.endsWith('\n') ? liveBody : `${liveBody}\n`);
  note(`ready ${ready}`);
  note(`live ${live.status} ${liveBody}`);
  if (live.status !== 200 || !liveBody.includes('"status":"live"')) fail('liveness failed');

  const versionsAfter = psql('SELECT version FROM schema_migrations ORDER BY 1');
  note(`versions after 003: ${versionsAfter.replaceAll('\n', ',')}`);
  if (versionsAfter !== '001_schema.sql\n002_security.sql\n003_inference.sql') fail('003 was not applied beside 001 and 002');
  const keptAfter = await tenantRead(kept.tenantId, kept.secret);
  if (keptAfter.status !== 200 || !keptAfter.text.includes('Kept')) fail('kept tenant did not survive 003');
  const firstMigration = migrationAppliedLines().at(-1) ?? '';
  if (!firstMigration.includes('003_inference.sql')) fail(`first boot did not record 003: ${redact(firstMigration)}`);

  must(compose(['restart', 'app']), 'restart app');
  const readyAgain = await waitReady();
  if (!readyAgain.includes('"database":"ready"')) fail('second boot was not ready');
  const secondMigration = migrationAppliedLines().at(-1) ?? '';
  note(`second migrate ${redact(secondMigration)}`);
  if (!secondMigration.includes('"applied":[]')) fail('second migrate applied a file');
  const keptStill = await tenantRead(kept.tenantId, kept.secret);
  if (keptStill.status !== 200) fail('kept tenant failed after the second boot');
  note('kept tenant survived the additive migration and a second boot applied nothing');

  const alpha = cli(['provision-tenant', '--name', 'Alpha']);
  const beta = cli(['provision-tenant', '--name', 'Beta']);
  remember(alpha.secret);
  remember(beta.secret);
  registerTenant(alpha, alphaApiKey, 'alpha-chat', 'gpt-journey-alpha');
  registerTenant(beta, betaApiKey, 'beta-chat', 'gpt-journey-beta');
  cli([
    'register-deployment',
    '--tenant-id',
    alpha.tenantId,
    '--name',
    'quiet-chat',
    '--upstream-model',
    'gpt-journey-quiet',
    '--timeout-ms',
    '5000',
    '--enabled',
    'false',
  ]);
  const listed = cli(['list-inference', '--tenant-id', alpha.tenantId]);
  const listedText = JSON.stringify(listed);
  if (listedText.includes(alphaApiKey) || listedText.includes('aes-256-gcm$') || listedText.includes(credentialKey)) {
    fail('list-inference exposed credential material');
  }
  note('list-inference omitted credential material');

  const before = (await hits()).length;
  const alphaResponse = await chat(alpha.tenantId, alpha.secret, {
    model: 'auto',
    messages: [{ role: 'user', content: alphaPrompt }],
    temperature: 0.2,
  });
  if (alphaResponse.status !== 200 || alphaResponse.json.object !== 'chat.completion') {
    fail(`alpha completion failed: ${alphaResponse.status} ${redact(alphaResponse.text)}`);
  }
  if (alphaResponse.json.model !== 'gpt-journey-alpha' || alphaResponse.json.choices?.[0]?.message?.content !== 'alpha-ok') {
    fail('alpha completion did not come from the configured model');
  }
  if (JSON.stringify(alphaResponse.json.usage) !== JSON.stringify({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })) {
    fail('alpha usage did not match the mock');
  }
  const betaResponse = await chat(beta.tenantId, beta.secret, {
    model: 'auto',
    messages: [{ role: 'user', content: betaPrompt }],
  });
  if (betaResponse.status !== 200 || betaResponse.json.model !== 'gpt-journey-beta') {
    fail('beta alias did not resolve to the beta deployment');
  }
  const crossed = await chat(alpha.tenantId, alpha.secret, {
    model: 'beta-chat',
    messages: [{ role: 'user', content: alphaPrompt }],
  });
  const disabled = await chat(alpha.tenantId, alpha.secret, {
    model: 'quiet-chat',
    messages: [{ role: 'user', content: alphaPrompt }],
  });
  const callerUrl = await chat(alpha.tenantId, alpha.secret, {
    model: 'auto',
    messages: [{ role: 'user', content: alphaPrompt }],
    base_url: 'https://evil.example/v1',
  });
  const afterAccepted = await hits();
  if (afterAccepted.length !== before + 2) fail(`expected 2 upstream calls, got ${afterAccepted.length - before}`);
  if (crossed.status !== 404 || disabled.status !== 404 || callerUrl.status !== 400) {
    fail(`rejected calls had unexpected status ${crossed.status} ${disabled.status} ${callerUrl.status}`);
  }
  const alphaHit = afterAccepted.find((hit) => hit.model === 'gpt-journey-alpha');
  const betaHit = afterAccepted.find((hit) => hit.model === 'gpt-journey-beta');
  if (!alphaHit || alphaHit.authorization !== `Bearer ${alphaApiKey}` || alphaHit.contentLength !== alphaPrompt.length) {
    fail('alpha upstream call did not use the alpha credential and prompt');
  }
  if (!betaHit || betaHit.authorization !== `Bearer ${betaApiKey}` || betaHit.temperature !== null) {
    fail('beta upstream call was not isolated');
  }
  if (alphaHit.temperature !== 0.2) fail('temperature was not forwarded');
  note('auto resolved per tenant and rejected calls made no upstream request');

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const metricsResponse = await fetch(
    `http://127.0.0.1:8080/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { 'x-tenant-id': alpha.tenantId, authorization: `Bearer ${alpha.secret}` } },
  );
  const metricsText = await metricsResponse.text();
  const metrics = JSON.parse(metricsText);
  if (metricsResponse.status !== 200 || metrics.requests?.total !== 1 || metrics.usage?.promptTokens !== 11) {
    fail(`alpha metrics were wrong: ${metricsResponse.status} ${redact(metricsText)}`);
  }
  const betaMetricsResponse = await fetch(
    `http://127.0.0.1:8080/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { 'x-tenant-id': beta.tenantId, authorization: `Bearer ${beta.secret}` } },
  );
  const betaMetrics = await betaMetricsResponse.json();
  if (betaMetrics.requests?.total !== 1 || betaMetrics.usage?.promptTokens !== 11) fail('beta metrics were not isolated');
  const modelsResponse = await fetch('http://127.0.0.1:8080/v1/models', {
    headers: { 'x-tenant-id': alpha.tenantId, authorization: `Bearer ${alpha.secret}` },
  });
  const models = await modelsResponse.json();
  const modelIds = (models.data ?? []).map((item) => item.id).sort();
  if (JSON.stringify(modelIds) !== JSON.stringify(['alpha-chat', 'auto'])) fail(`alpha models were ${modelIds.join(',')}`);
  note('metrics and model list stayed inside the tenant');

  const stored = psql(`
    SELECT r.id || ' ' || a.id || ' ' || r.status || ' ' || a.status || ' ' ||
           r.requested_model || ' ' || a.upstream_model || ' ' ||
           coalesce(a.prompt_tokens::text, 'null') || ' ' ||
           coalesce(a.completion_tokens::text, 'null') || ' ' ||
           coalesce(a.total_tokens::text, 'null') || ' ' ||
           coalesce(a.duration_ms::text, 'null') || ' ' ||
           r.deployment_config_version::text
    FROM proxy_requests r
    JOIN model_attempts a ON a.request_id = r.id AND a.tenant_id = r.tenant_id
    ORDER BY r.created_at
  `);
  const storedLines = stored.split('\n').filter(Boolean);
  if (storedLines.length !== 2) fail(`expected 2 persisted requests, got ${storedLines.length}`);
  for (const line of storedLines) {
    const [requestId, attemptId, requestStatus, attemptStatus, requested, upstream, promptTokens] = line.split(' ');
    if (requestId === attemptId) fail('request id and attempt id were the same');
    if (requestStatus !== 'succeeded' || attemptStatus !== 'succeeded') fail('persisted status was not succeeded');
    if (promptTokens !== '11') fail('persisted usage did not match the mock');
    if (requested !== 'auto' || !upstream.startsWith('gpt-journey-')) fail(`persisted routing was ${requested} ${upstream}`);
  }
  const leaked = psql(`
    SELECT count(*) FROM (
      SELECT requested_model AS value FROM proxy_requests
      UNION ALL SELECT coalesce(status, '') FROM proxy_requests
      UNION ALL SELECT upstream_model FROM model_attempts
      UNION ALL SELECT coalesce(error_code, '') FROM model_attempts
      UNION ALL SELECT protected_credential FROM provider_connections
      UNION ALL SELECT name FROM model_deployments
      UNION ALL SELECT upstream_model FROM model_deployments
      UNION ALL SELECT alias FROM model_aliases
    ) rows
    WHERE position('${alphaPrompt}' in value) > 0
       OR position('${betaPrompt}' in value) > 0
       OR position('alpha-ok' in value) > 0
       OR position('beta-ok' in value) > 0
       OR position('${alphaApiKey}' in value) > 0
       OR position('${betaApiKey}' in value) > 0
  `);
  if (leaked !== '0') fail('stored rows contained a prompt, response, or provider credential');
  const protectedCount = psql("SELECT count(*) FROM provider_connections WHERE protected_credential LIKE 'aes-256-gcm$%'");
  const connectionCount = psql('SELECT count(*) FROM provider_connections');
  if (protectedCount !== connectionCount || connectionCount !== '2') fail('provider credentials were not protected');
  note('persisted rows kept usage and identifiers and omitted prompt text');

  const requestExample = {
    model: 'auto',
    messages: [{ role: 'user', content: '[REDACTED]' }],
    temperature: 0.2,
  };
  const responseExample = alphaResponse.json;
  writeFileSync(join(journeyDir, 'request.json'), `${JSON.stringify(requestExample, null, 2)}\n`);
  writeFileSync(join(journeyDir, 'response.json'), `${JSON.stringify(responseExample, null, 2)}\n`);
  writeFileSync(join(journeyDir, 'persisted.txt'), `${stored}\n`);
  writeFileSync(join(journeyDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  writeFileSync(join(journeyDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  assertNoSensitiveLogs(appLogs(), join(journeyDir, 'app-logs.jsonl'));

  const hitsBeforeDisable = (await hits()).length;
  state.inference = 'false';
  const disabledUp = compose(['up', '-d', '--force-recreate', '--no-deps', 'app']);
  if (disabledUp.status !== 0) fail(`disable recreate failed: ${redact(disabledUp.stderr || '')}`);
  await waitReady();
  const blocked = await chat(alpha.tenantId, alpha.secret, {
    model: 'auto',
    messages: [{ role: 'user', content: alphaPrompt }],
  });
  const hitsAfterDisable = (await hits()).length;
  if (blocked.status !== 503 || blocked.json?.error?.code !== 'inference_disabled') {
    fail(`disabled inference returned ${blocked.status} ${redact(blocked.text)}`);
  }
  if (hitsAfterDisable !== hitsBeforeDisable) fail('disabled inference called upstream');
  note('disabled inference made no upstream call');

  must(compose(['stop', 'app']), 'stop current app');
  startPrevious();
  const rollbackReady = await waitReady();
  const rollbackTenant = await tenantRead(kept.tenantId, kept.secret);
  const rollbackLive = await fetch('http://127.0.0.1:8080/health/live');
  const rollbackLiveBody = await rollbackLive.text();
  const rollbackText = [
    `ready ${rollbackReady}`,
    `live ${rollbackLive.status} ${rollbackLiveBody}`,
    `tenant ${rollbackTenant.status} ${redact(rollbackTenant.text)}`,
    `versions ${psql('SELECT version FROM schema_migrations ORDER BY 1').replaceAll('\n', ',')}`,
  ].join('\n');
  writeFileSync(join(scratch, 'rollback.txt'), `${rollbackText}\n`);
  note(`rollback ${rollbackReady}`);
  if (!rollbackReady.includes('"database":"ready"')) fail('previous image was not ready');
  if (rollbackTenant.status !== 200 || !rollbackTenant.text.includes('Kept')) fail('previous image could not read the kept tenant');
  if (rollbackTenant.text.includes('yck_') || rollbackTenant.text.includes(alphaApiKey)) fail('rollback response leaked a secret');
  note('previous image served the kept tenant after 003');
  writeNotes();
  note('journey complete');
  cleanup();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'journey failed');
});
