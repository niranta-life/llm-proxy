import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.argv[2];
if (!scratch) {
  process.stderr.write('usage: node scripts/verify-slice-00.mjs <scratch-dir>\n');
  process.exit(1);
}
mkdirSync(scratch, { recursive: true });

const secrets = [];
const notes = [];

function note(line) {
  notes.push(line);
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  note(`FAIL ${message}`);
  writeFileSync(join(scratch, 'journey.txt'), `${notes.join('\n')}\n`);
  process.exit(1);
}

function compose(args, options = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

function must(result, label) {
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}: ${redact(result.stderr || result.stdout || '')}`);
  }
  return result;
}

function redact(text) {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/yck_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/scrypt\$[A-Za-z0-9_$.-]+/g, '[REDACTED]')
    .replace(/migrator_local_dev/g, '[REDACTED]')
    .replace(/auth_local_dev/g, '[REDACTED]')
    .replace(/runtime_local_dev/g, '[REDACTED]')
    .replace(/postgres:\/\/\S+/g, '[REDACTED]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady() {
  const started = Date.now();
  let last = 'not started';
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch('http://127.0.0.1:8080/health/ready');
      const text = await response.text();
      last = `${response.status} ${text}`;
      if (response.ok) return text;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await sleep(1000);
  }
  fail(`readiness timeout: ${last}`);
}

function serverContainerId() {
  const result = must(compose(['ps', '-q', 'app']), 'compose ps app');
  const id = result.stdout.trim().split('\n').filter(Boolean)[0];
  if (!id) fail('app container is missing');
  return id;
}

function cli(args) {
  const result = compose(['run', '--rm', 'app', 'node', 'dist/cli.js', ...args]);
  if (result.status !== 0) {
    fail(`cli ${args[0]} exited ${result.status}: ${redact(result.stderr || '')}`);
  }
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('{'))
    .at(-1);
  if (!line) fail(`cli ${args[0]} did not print JSON`);
  return JSON.parse(line);
}

function psql(sql, variables = {}) {
  const args = ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'llm_proxy', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
  for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
  const result = must(compose(args, { input: sql }), 'psql');
  return result.stdout.trim();
}

function remember(secret) {
  if (!secret || !secret.startsWith('yck_') || secret.length < 40) fail('credential was not a high-entropy secret');
  secrets.push(secret);
}

async function auth(tenantId, secret) {
  const response = await fetch('http://127.0.0.1:8080/v1/tenant', {
    headers: {
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
    },
  });
  const text = await response.text();
  return { status: response.status, text };
}

const down = compose(['down', '-v', '--remove-orphans']);
if (down.status !== 0) fail(`compose down exited ${down.status}: ${redact(down.stderr || '')}`);

note('compose up');
const up = compose(['up', '-d', '--build']);
if (up.status !== 0) fail(`compose up exited ${up.status}: ${redact(up.stderr || up.stdout || '')}`);

const ready1 = await waitReady();
writeFileSync(join(scratch, 'ready-1.json'), ready1.endsWith('\n') ? ready1 : `${ready1}\n`);
note(`ready-1 ${ready1}`);

const appId = serverContainerId();
const version = must(compose(['exec', '-T', 'app', 'node', '-p', 'process.versions.node']), 'node version');
const nodeVersion = version.stdout.trim();
note(`node ${nodeVersion}`);
if (!nodeVersion.startsWith('24.')) fail(`container node is ${nodeVersion}`);

const alpha = cli(['provision-tenant', '--name', 'Alpha']);
const beta = cli(['provision-tenant', '--name', 'Beta']);
const second = cli(['add-key', '--tenant-id', alpha.tenantId, '--label', 'backup']);
remember(alpha.secret);
remember(beta.secret);
remember(second.secret);
if (alpha.secret === beta.secret || alpha.secret === second.secret) fail('secrets were not unique');
note('provisioned two tenants and a second active key');
for (const secret of [alpha.secret, beta.secret, second.secret]) {
  const stored = psql(
    `SELECT count(*) FROM (
       SELECT name AS value FROM tenants
       UNION ALL SELECT verifier FROM tenant_api_keys
       UNION ALL SELECT label FROM tenant_api_keys
     ) rows
     WHERE position(:'secret' in value) > 0`,
    { secret },
  );
  if (stored !== '0') fail('a tenant secret was stored in the database');
}
note('secretStoredRecoverable=0');
const protectedVerifiers = psql(`SELECT count(*) FROM tenant_api_keys WHERE verifier LIKE 'scrypt$%'`);
const keyCount = psql('SELECT count(*) FROM tenant_api_keys');
note(`protectedVerifiers=${protectedVerifiers} keyCount=${keyCount}`);
if (protectedVerifiers !== keyCount || keyCount !== '3') fail('keys are not stored as protected verifiers');

const roles = psql(`
  SELECT rolname || ' super=' || rolsuper || ' bypass=' || rolbypassrls || ' login=' || rolcanlogin
  FROM pg_roles
  WHERE rolname IN ('llm_owner', 'llm_migrator', 'llm_auth', 'llm_runtime')
  ORDER BY rolname
`);
note(`roles ${roles.replaceAll('\n', ' | ')}`);

const alphaPrimary = await auth(alpha.tenantId, alpha.secret);
const alphaOk = await auth(alpha.tenantId, second.secret);
const betaOk = await auth(beta.tenantId, beta.secret);
const revokedLater = cli(['revoke-key', '--tenant-id', alpha.tenantId, '--key-id', alpha.keyId]);
const revokedAuth = await auth(alpha.tenantId, alpha.secret);
const backupAuth = await auth(alpha.tenantId, second.secret);
const wrongAuth = await auth(alpha.tenantId, beta.secret);
const crossed = await auth(beta.tenantId, second.secret);
note(`beforeRevokePrimary=${alphaPrimary.status} beforeRevokeBackup=${alphaOk.status} beta=${betaOk.status}`);
note(`revoke=${revokedLater.revoked} revokedKey=${revokedAuth.status} backupKey=${backupAuth.status}`);
note(`wrongSecret=${wrongAuth.status} crossTenant=${crossed.status}`);

for (const result of [alphaPrimary, alphaOk, betaOk, backupAuth]) {
  if (result.status !== 200) fail(`expected success, got ${result.status}`);
  const body = JSON.parse(result.text);
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['id', 'keys', 'name'])) {
    fail('success body has unexpected fields');
  }
  if (result.text.includes('yck_') || result.text.includes('scrypt$')) fail('success body contains a secret');
}
if (!alphaOk.text.includes('Alpha') || alphaOk.text.includes('Beta')) fail('alpha response was not limited to alpha');
if (!betaOk.text.includes('Beta') || betaOk.text.includes('Alpha')) fail('beta response was not limited to beta');
if (revokedAuth.status !== 401 || wrongAuth.status !== 401 || crossed.status !== 401) {
  fail('rejected credentials were not denied');
}
for (const result of [revokedAuth, wrongAuth, crossed]) {
  if (result.text.includes('Alpha') || result.text.includes('Beta') || result.text.includes('yck_')) {
    fail('rejection leaked tenant data');
  }
}
if (backupAuth.status !== 200) fail('the remaining active key was rejected');

const model = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-provider-config': '{"apiKey":"sk-live"}' },
  body: JSON.stringify({ model: 'gpt-test', prompt: 'hi', provider: 'openai' }),
});
const modelText = await model.text();
note(`modelRoute=${model.status} ${modelText}`);
if (model.status !== 404) fail('a model route accepted a request');

note('restart app');
must(compose(['restart', 'app']), 'restart app');
const ready2 = await waitReady();
writeFileSync(join(scratch, 'ready-2.json'), ready2.endsWith('\n') ? ready2 : `${ready2}\n`);
note(`ready-2 ${ready2}`);
if (ready1 !== ready2) fail('successive boots did not report the same readiness');
const afterRestart = await auth(alpha.tenantId, second.secret);
const tenantCount = psql('SELECT count(*) FROM tenants');
note(`afterRestart=${afterRestart.status} tenantCount=${tenantCount}`);
if (afterRestart.status !== 200 || !afterRestart.text.includes('Alpha') || afterRestart.text.includes('Beta')) {
  fail('tenant rows did not survive the second boot');
}
if (tenantCount !== '2') fail(`tenant count changed to ${tenantCount}`);

note('stop postgres');
must(compose(['stop', 'postgres']), 'stop postgres');
let downStatus = 0;
let downBody = '';
const downStarted = Date.now();
while (Date.now() - downStarted < 20_000) {
  const response = await fetch('http://127.0.0.1:8080/health/ready');
  downStatus = response.status;
  downBody = await response.text();
  if (downStatus === 503) break;
  await sleep(500);
}
writeFileSync(join(scratch, 'ready-down.json'), downBody.endsWith('\n') ? downBody : `${downBody}\n`);
const live = await fetch('http://127.0.0.1:8080/health/live');
const liveBody = await live.text();
note(`ready-down ${downStatus} ${downBody}`);
note(`live ${live.status} ${liveBody}`);
if (downStatus === 200 || downBody.includes('"database":"ready"')) fail('readiness stayed ready without postgres');
if (live.status !== 200) fail('liveness failed while the process was up');

const logsBeforeStop = spawnSync('docker', ['logs', appId], { encoding: 'utf8' });
const shutdown = spawnSync('docker', ['stop', '-t', '20', appId], { encoding: 'utf8' });
const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', appId], { encoding: 'utf8' });
const logsAfter = spawnSync('docker', ['logs', appId], { encoding: 'utf8' });
const combinedLogs = `${logsBeforeStop.stdout || ''}${logsBeforeStop.stderr || ''}${logsAfter.stdout || ''}${logsAfter.stderr || ''}`;
const logLines = combinedLogs.split('\n').map((line) => line.trim()).filter(Boolean);
for (const line of logLines) {
  JSON.parse(line);
  if (secrets.some((secret) => line.includes(secret))) fail('server log contains a tenant secret');
}
const shutdownText = [
  `signal=SIGTERM`,
  `exit=${inspect.stdout.trim()}`,
  `dockerStop=${shutdown.status}`,
  ...logLines.filter((line) => line.includes('shutdown') || line.includes('pools')),
].join('\n');
writeFileSync(join(scratch, 'shutdown.txt'), `${redact(shutdownText)}\n`);
writeFileSync(join(scratch, 'logs.jsonl'), `${redact(logLines.join('\n'))}\n`);
note(`shutdown exit=${inspect.stdout.trim()} poolsClosed=${combinedLogs.includes('"pools":"closed"')}`);
if (inspect.stdout.trim() !== '0' || !combinedLogs.includes('"pools":"closed"')) {
  fail('SIGTERM did not close the pools and exit');
}

const configFail = compose([
  'run',
  '--rm',
  '--no-deps',
  '-e',
  'DATABASE_HOST=',
  'app',
  'node',
  'dist/index.js',
]);
const configText = redact(`${configFail.stdout || ''}${configFail.stderr || ''}`);
writeFileSync(
  join(scratch, 'config-fail.txt'),
  `exit=${configFail.status}\n${configText.endsWith('\n') ? configText : `${configText}\n`}`,
);
note(`configFail exit=${configFail.status}`);
if (configFail.status === 0 || configText.includes('listening') || !configText.includes('invalid configuration')) {
  fail('invalid configuration did not stop startup');
}
for (const secret of secrets) {
  if (configText.includes(secret)) fail('config failure output contains a secret');
}

writeFileSync(join(scratch, 'journey.txt'), `${notes.join('\n')}\n`);
note('journey complete');
