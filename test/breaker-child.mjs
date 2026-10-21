import { loadConfig } from '../dist/config.js';
import { createPool } from '../dist/db/pools.js';
import { latestMigrationVersion } from '../dist/db/migrate.js';
import { buildApp } from '../dist/http/app.js';
import { createLogger } from '../dist/logger.js';

const logger = createLogger('error', process.stderr);
let app;
let authPool;
let runtimePool;

try {
  const config = loadConfig(process.env);
  const now = Number(process.env.BREAKER_NOW_MS);
  if (!Number.isFinite(now)) throw new Error('BREAKER_NOW_MS is required');
  const baseUrl = process.env.UPSTREAM_BASE_URL ?? '';
  if (baseUrl.length === 0) throw new Error('UPSTREAM_BASE_URL is required');
  const keyText = process.env.PROVIDER_CREDENTIAL_KEY ?? '';
  authPool = createPool(config, 'auth', logger);
  runtimePool = createPool(config, 'runtime', logger);
  app = buildApp({
    logger,
    authPool,
    runtimePool,
    readyVersion: await latestMigrationVersion(),
    inferenceEnabled: true,
    upstreamBaseUrl: baseUrl,
    credentialKey: Buffer.from(keyText, 'base64'),
    maxActiveStreams: config.maxActiveStreams,
    maxStreamsPerTenant: config.maxStreamsPerTenant,
    now: () => now,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'x-tenant-id': process.env.TENANT_ID ?? '',
      authorization: `Bearer ${process.env.TENANT_SECRET ?? ''}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      model: process.env.CHAT_MODEL ?? '',
      messages: [{ role: 'user', content: process.env.CHAT_CONTENT ?? 'probe' }],
    }),
  });
  let code = null;
  try {
    const body = response.json();
    if (body !== null && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        code = error.code;
      }
    }
  } catch {
    code = null;
  }
  process.stdout.write(`${JSON.stringify({ status: response.statusCode, code })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await authPool?.end().catch(() => undefined);
  await runtimePool?.end().catch(() => undefined);
}
