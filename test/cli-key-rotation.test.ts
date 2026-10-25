import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliEntry, loadTestDatabase, projectRoot, runCli, serviceEnv } from './helpers.js';
import { cliEnv, credentialKeyText, provisionTenant } from './inference-support.js';

const SECRET = 'sk-cli-retained-secret';
const KEY_B = Buffer.alloc(32, 4);

describe('cli credential rotation', () => {
  const db = loadTestDatabase();
  const certDir = mkdtempSync(join(tmpdir(), 'llm-proxy-cli-cert-'));
  const seen: string[] = [];
  let port = 0;
  let server: ReturnType<typeof createServer> | undefined;

  beforeAll(async () => {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        join(certDir, 'key.pem'),
        '-out',
        join(certDir, 'cert.pem'),
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    server = createServer(
      {
        key: readFileSync(join(certDir, 'key.pem')),
        cert: readFileSync(join(certDir, 'cert.pem')),
      },
      (request, response) => {
        const header = request.headers.authorization;
        if (typeof header === 'string') seen.push(header);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'retained-model' }] }));
      },
    );
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    rmSync(certDir, { recursive: true, force: true });
  });

  it('opens a credential sealed with the retained key through the operator CLI', async () => {
    const tenant = provisionTenant(db, 'Slice 06E CLI rotate');
    const endpoint = `https://127.0.0.1:${port}/v1`;
    runCli(
      db,
      ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', SECRET, '--endpoint', endpoint],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'dgx',
        '--name',
        'dgx-chat',
        '--upstream-model',
        'llama',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(
      db,
      [
        'approve-private-endpoint',
        '--tenant-id',
        tenant.tenantId,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--addresses',
        '127.0.0.1',
        '--tls-verify',
        'false',
      ],
      cliEnv(),
    );

    // spawnSync would block this process, so the local server could not accept.
    const opened = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliEntry, 'list-private-models', '--tenant-id', tenant.tenantId, '--deployment', 'dgx-chat'],
        {
          cwd: projectRoot,
          env: serviceEnv(db, {
            ...cliEnv(),
            PROVIDER_CREDENTIAL_KEY: KEY_B.toString('base64'),
            PROVIDER_CREDENTIAL_KEY_PREVIOUS: credentialKeyText,
          }),
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (status) => {
        resolve({
          status: status ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
    expect(opened.status, opened.stderr).toBe(0);
    expect(JSON.parse(opened.stdout)).toMatchObject({ models: ['retained-model'] });
    expect(seen).toEqual([`Bearer ${SECRET}`]);
  });
});
