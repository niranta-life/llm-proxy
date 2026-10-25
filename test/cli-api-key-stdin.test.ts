import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiKeyInputError, MAX_API_KEY_STDIN_BYTES, resolveApiKeyFlag } from '../src/cli-api-key.js';
import { createCredentialStore } from '../src/credentials.js';
import { cliEntry, loadTestDatabase, projectRoot, serviceEnv } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant } from './inference-support.js';

const db = loadTestDatabase();
const pool = adminPool(db);
afterAll(async () => {
  await pool.end();
});

function cli(args: string[], input: string | undefined) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: projectRoot,
    env: serviceEnv(db, cliEnv()),
    encoding: 'utf8',
    input,
  });
}

async function storedKey(tenantId: string, provider: string): Promise<string> {
  const result = await pool.query<{ protected_credential: string }>(
    'SELECT protected_credential FROM provider_connections WHERE tenant_id = $1 AND provider = $2',
    [tenantId, provider],
  );
  const protectedCredential = result.rows[0]?.protected_credential;
  if (protectedCredential === undefined) throw new Error('no connection');
  return createCredentialStore(credentialKey).open(protectedCredential);
}

describe('--api-key-stdin', () => {
  it('registers an openai connection from stdin and trims the trailing newline', async () => {
    const tenant = provisionTenant(db, 'Stdin OpenAI');
    const key = 'sk-stdin-openai-key';
    const result = cli(['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key-stdin'], `${key}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(await storedKey(tenant.tenantId, 'openai')).toBe(key);
  });

  it('rotates an openai credential from stdin with a CRLF ending', async () => {
    const tenant = provisionTenant(db, 'Stdin Rotate');
    const first = cli(['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key-stdin'], 'sk-first');
    expect(first.status).toBe(0);
    const rotated = cli(['set-openai-credential', '--tenant-id', tenant.tenantId, '--api-key-stdin'], 'sk-second\r\n');
    expect(rotated.status).toBe(0);
    expect(await storedKey(tenant.tenantId, 'openai')).toBe('sk-second');
  });

  it('registers an anthropic connection from stdin', async () => {
    const tenant = provisionTenant(db, 'Stdin Anthropic');
    const result = cli(
      [
        'register-anthropic-connection',
        '--tenant-id',
        tenant.tenantId,
        '--endpoint',
        'https://api.anthropic.com',
        '--api-key-stdin',
      ],
      'sk-ant-stdin\n',
    );
    expect(result.status).toBe(0);
    expect(await storedKey(tenant.tenantId, 'anthropic')).toBe('sk-ant-stdin');
  });

  it('keeps interior newlines of multi-line key material and strips only trailing ones', async () => {
    const material = '{"private_key":"a\\nb"}\n{"x":1}';
    const values = await resolveApiKeyFlag(
      'register-vertex-connection',
      { 'api-key-stdin': true },
      Readable.from([`${material}\n\n`]),
    );
    expect(values['api-key']).toBe(material);
  });

  it('rejects empty input', () => {
    const tenant = provisionTenant(db, 'Stdin Empty');
    for (const input of ['', '\n', '\r\n']) {
      const result = cli(['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key-stdin'], input);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('api key from stdin is empty');
    }
  });

  it('rejects --api-key together with --api-key-stdin without reading the key', () => {
    const tenant = provisionTenant(db, 'Stdin Both');
    const result = cli(
      ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-argv', '--api-key-stdin'],
      'sk-stdin\n',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--api-key and --api-key-stdin cannot be combined');
    expect(result.stderr).not.toContain('sk-argv');
  });

  it('rejects the flag on a command that takes no api key', () => {
    const result = cli(['provision-tenant', '--name', 'x', '--api-key-stdin'], 'sk-x\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'invalid command arguments: --api-key-stdin only works with commands that take an API key',
    );
  });

  it('accepts input exactly at the size limit', async () => {
    const material = 'k'.repeat(MAX_API_KEY_STDIN_BYTES);
    const values = await resolveApiKeyFlag('register-vertex-connection', { 'api-key-stdin': true }, Readable.from([material]));
    expect(values['api-key']).toBe(material);
  });

  it('stops reading and rejects multi-chunk input over 64 KiB', async () => {
    const chunk = 'a'.repeat(20 * 1024);
    let pulled = 0;
    const stdin = Readable.from(
      (function* () {
        for (let i = 0; i < 50; i += 1) {
          pulled += 1;
          yield chunk;
        }
      })(),
    );
    await expect(
      resolveApiKeyFlag('register-vertex-connection', { 'api-key-stdin': true }, stdin),
    ).rejects.toThrow('api key from stdin is larger than 64 KiB');
    expect(pulled).toBeLessThan(10);
  });

  it('rejects oversize input from the command line', () => {
    const tenant = provisionTenant(db, 'Stdin Big');
    const result = cli(
      ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key-stdin'],
      'x'.repeat(MAX_API_KEY_STDIN_BYTES + 1),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('api key from stdin is larger than 64 KiB');
  });

  it('turns a stdin read failure into a sanitized input error', async () => {
    const stdin = new Readable({
      read() {
        this.destroy(new Error('boom sk-leaky-secret-value'));
      },
    });
    const failure = await resolveApiKeyFlag('register-vertex-connection', { 'api-key-stdin': true }, stdin).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiKeyInputError);
    expect((failure as Error).message).toBe('could not read the api key from stdin');
    expect((failure as Error).message).not.toContain('leaky');
  });
});
