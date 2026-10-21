import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliEntry, loadTestDatabase, projectRoot, serviceEnv } from './helpers.js';
import { cliEnv, provisionTenant } from './inference-support.js';
import {
  UPSTREAM,
  autoDeployment,
  chat,
  cliJson,
  connectionRows,
  defaultNames,
  deploymentRows,
  doneCount,
  grewOnly,
  listenProxy,
  openDb,
  registerSix,
  sceneContent,
  snapshot,
  startDoubles,
  vertexKey,
  type Doubles,
  type ProviderName,
  type SixKeys,
} from './hardening-support.js';

const PROVIDERS = Object.keys(UPSTREAM) as ProviderName[];

function keysFor(label: string, project: string): SixKeys {
  const email = `${label}-bot@${project}.iam.gserviceaccount.com`;
  return {
    openai: `sk-iso-openai-${label}-key`,
    anthropic: `sk-ant-iso-${label}-key`,
    vertexEmail: email,
    vertexKey: vertexKey(email),
    vertexProject: project,
    xai: `xai-iso-${label}-key-1234`,
    openrouter: `or-iso-${label}-key-12345`,
    dgx: `dgx-iso-${label}-key-1234`,
  };
}

describe('provider tenant isolation', () => {
  const db = loadTestDatabase();
  const namesA = defaultNames('a');
  const namesB = defaultNames('b');
  const keysA = keysFor('alpha', 'iso-alpha-proj');
  const keysB = keysFor('beta', 'iso-beta-proj');
  const alpha = { tenantId: '', secret: '' };
  const beta = { tenantId: '', secret: '' };
  let doubles: Doubles;
  let port = 0;
  let closeApp: () => Promise<void> = async () => undefined;
  let admin: ReturnType<typeof openDb>;

  beforeAll(async () => {
    doubles = await startDoubles();
    const createdA = provisionTenant(db, 'Isolation Alpha');
    const createdB = provisionTenant(db, 'Isolation Beta');
    alpha.tenantId = createdA.tenantId;
    alpha.secret = createdA.secret;
    beta.tenantId = createdB.tenantId;
    beta.secret = createdB.secret;
    registerSix(db, alpha.tenantId, namesA, keysA, doubles.anthropicOrigin);
    registerSix(db, beta.tenantId, namesB, keysB, doubles.anthropicOrigin);
    const listened = await listenProxy(db, doubles);
    port = listened.port;
    closeApp = listened.close;
    admin = openDb(db);
  }, 180_000);

  afterAll(async () => {
    await closeApp();
    await admin.end();
    await doubles.close();
  });

  async function summary(tenantId: string, secret: string): Promise<Record<string, unknown>> {
    const from = new Date(Date.now() - 180_000).toISOString();
    const to = new Date(Date.now() + 180_000).toISOString();
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { 'x-tenant-id': tenantId, authorization: `Bearer ${secret}` } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('keeps credentials, cache, metrics, health, and aliases on one tenant', async () => {
    for (const provider of PROVIDERS) {
      const json = await chat(port, alpha.tenantId, alpha.secret, {
        model: namesA[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'ok') }],
      });
      expect(json.status).toBe(200);
      const streamed = await chat(port, alpha.tenantId, alpha.secret, {
        model: namesA[provider],
        stream: true,
        messages: [{ role: 'user', content: sceneContent(provider, 'stream') }],
      });
      expect(streamed.status).toBe(200);
      expect(doneCount(await streamed.text())).toBe(1);
    }
    expect(doubles.mints).toHaveLength(1);
    expect(doubles.mints[0]?.tenantId).toBe(alpha.tenantId);
    expect(doubles.mints[0]?.projectId).toBe(keysA.vertexProject);

    const alphaSummary = await summary(alpha.tenantId, alpha.secret);
    const alphaText = JSON.stringify(alphaSummary);
    for (const name of Object.values(namesB)) expect(alphaText).not.toContain(name);
    expect(alphaSummary.requests).toMatchObject({ total: 12, succeeded: 12, failed: 0 });
    expect(alphaSummary.usage).toMatchObject({ promptTokens: 92, completionTokens: 49, totalTokens: 185 });
    expect(alphaSummary.streaming).toMatchObject({
      requests: 6,
      completed: 6,
      cancelled: 0,
      errors: 0,
      usage: { promptTokens: 47, completionTokens: 30, totalTokens: 99 },
    });
    const byProvider = alphaSummary.byProvider as Array<Record<string, unknown>>;
    expect(byProvider).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', requests: 2, completed: 2, promptTokens: 6, completionTokens: 4, totalTokens: 10 }),
        expect.objectContaining({ provider: 'anthropic', requests: 2, completed: 2, promptTokens: 28, completionTokens: 19, totalTokens: 47 }),
        expect.objectContaining({ provider: 'vertex', requests: 2, completed: 2, promptTokens: 12, completionTokens: 4, totalTokens: 16 }),
        expect.objectContaining({ provider: 'xai', requests: 2, completed: 2, promptTokens: 8, completionTokens: 6, totalTokens: 14 }),
        expect.objectContaining({ provider: 'openrouter', requests: 2, completed: 2, promptTokens: 16, completionTokens: 2, totalTokens: 18 }),
        expect.objectContaining({ provider: 'dgx', requests: 2, completed: 2, promptTokens: 22, completionTokens: 14, totalTokens: 80 }),
      ]),
    );

    for (const provider of PROVIDERS) {
      const response = await chat(port, beta.tenantId, beta.secret, {
        model: namesB[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'ok') }],
      });
      expect(response.status).toBe(200);
    }
    expect(doubles.openaiHits.at(-1)?.authorization).toBe(`Bearer ${keysB.openai}`);
    expect(doubles.anthropicHits.at(-1)?.apiKey).toBe(keysB.anthropic);
    expect(doubles.xaiHits.at(-1)?.authorization).toBe(`Bearer ${keysB.xai}`);
    expect(doubles.openrouterHits.at(-1)?.authorization).toBe(`Bearer ${keysB.openrouter}`);
    expect(doubles.dgxHits.at(-1)?.authorization).toBe(`Bearer ${keysB.dgx}`);
    expect(doubles.vertexCalls.at(-1)?.spec.tenantId).toBe(beta.tenantId);
    expect(doubles.vertexCalls.at(-1)?.spec.projectId).toBe(keysB.vertexProject);
    expect(doubles.mints).toHaveLength(2);
    expect(doubles.mints[1]?.tenantId).toBe(beta.tenantId);

    const betaSummary = await summary(beta.tenantId, beta.secret);
    const betaText = JSON.stringify(betaSummary);
    for (const name of Object.values(namesA)) expect(betaText).not.toContain(name);
    expect(betaSummary.requests).toMatchObject({ total: 6, succeeded: 6 });
    expect((betaSummary.byProvider as unknown[]).length).toBe(6);
    const alphaAfterBeta = await summary(alpha.tenantId, alpha.secret);
    expect(JSON.stringify(alphaAfterBeta)).not.toContain(namesB.openai);
    expect(alphaAfterBeta.requests).toMatchObject({ total: 12, succeeded: 12 });

    const alphaConnections = await connectionRows(admin, alpha.tenantId);
    const betaConnections = await connectionRows(admin, beta.tenantId);
    cliJson(db, ['set-openai-credential', '--tenant-id', alpha.tenantId, '--api-key', 'sk-iso-openai-alpha-rotated']);
    const rotated = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.openai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(rotated.status).toBe(200);
    expect(doubles.openaiHits.at(-1)?.authorization).toBe('Bearer sk-iso-openai-alpha-rotated');
    const betaStill = await chat(port, beta.tenantId, beta.secret, {
      model: namesB.openai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(betaStill.status).toBe(200);
    expect(doubles.openaiHits.at(-1)?.authorization).toBe(`Bearer ${keysB.openai}`);
    const alphaAfterKey = await connectionRows(admin, alpha.tenantId);
    for (const row of alphaAfterKey) {
      const prior = alphaConnections.find((item) => item.provider === row.provider);
      if (row.provider === 'openai') {
        expect(row.credential_version).toBe((prior?.credential_version ?? 0) + 1);
        expect(row.config_version).toBe((prior?.config_version ?? 0) + 1);
      } else {
        expect(row).toEqual(prior);
      }
    }
    expect(await connectionRows(admin, beta.tenantId)).toEqual(betaConnections);

    cliJson(db, ['set-anthropic-credential', '--tenant-id', alpha.tenantId, '--api-key', 'sk-ant-iso-alpha-rotated']);
    const rotatedAnthropic = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.anthropic,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(rotatedAnthropic.status).toBe(200);
    expect(doubles.anthropicHits.at(-1)?.apiKey).toBe('sk-ant-iso-alpha-rotated');
    const betaAnthropic = await chat(port, beta.tenantId, beta.secret, {
      model: namesB.anthropic,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(betaAnthropic.status).toBe(200);
    expect(doubles.anthropicHits.at(-1)?.apiKey).toBe(keysB.anthropic);

    const mintsBeforeToggle = doubles.mints.length;
    const callsBeforeDisable = doubles.vertexCalls.length;
    cliJson(db, ['set-connection-enabled', '--tenant-id', alpha.tenantId, '--provider', 'vertex', '--enabled', 'false']);
    const vertexOff = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.vertex,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(vertexOff.status).toBe(404);
    expect(doubles.vertexCalls).toHaveLength(callsBeforeDisable);
    expect(doubles.mints).toHaveLength(mintsBeforeToggle);
    cliJson(db, ['set-connection-enabled', '--tenant-id', alpha.tenantId, '--provider', 'vertex', '--enabled', 'true']);
    const vertexOn = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.vertex,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(vertexOn.status).toBe(200);
    expect(doubles.mints).toHaveLength(mintsBeforeToggle + 1);
    expect(doubles.mints.at(-1)?.tenantId).toBe(alpha.tenantId);
    expect(doubles.mints.at(-1)?.credentialVersion).toBeGreaterThan(doubles.mints[0]?.credentialVersion ?? 0);
    const betaVertex = await chat(port, beta.tenantId, beta.secret, {
      model: namesB.vertex,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(betaVertex.status).toBe(200);
    expect(doubles.mints).toHaveLength(mintsBeforeToggle + 1);
    expect(doubles.vertexCalls.at(-1)?.spec.projectId).toBe(keysB.vertexProject);

    const beforeXai = snapshot(doubles);
    cliJson(db, ['set-connection-enabled', '--tenant-id', alpha.tenantId, '--provider', 'xai', '--enabled', 'false']);
    const xaiOff = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.xai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(xaiOff.status).toBe(404);
    expect((await xaiOff.json() as { error?: { code?: string } }).error?.code).toBe('model_not_found');
    expect(snapshot(doubles).xai).toBe(beforeXai.xai);
    const betaXai = await chat(port, beta.tenantId, beta.secret, {
      model: namesB.xai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(betaXai.status).toBe(200);
    expect(doubles.xaiHits.at(-1)?.authorization).toBe(`Bearer ${keysB.xai}`);
    const beforeAuto = snapshot(doubles);
    const auto = await chat(port, alpha.tenantId, alpha.secret, {
      model: 'auto',
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(auto.status).toBe(200);
    expect(grewOnly(beforeAuto, snapshot(doubles), 'openai')).toBe(true);
    expect(await autoDeployment(admin, alpha.tenantId)).toBe(namesA.openai);
    expect(await autoDeployment(admin, beta.tenantId)).toBe(namesB.openai);
    const openAiStill = await chat(port, alpha.tenantId, alpha.secret, {
      model: namesA.anthropic,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(openAiStill.status).toBe(200);

    const alphaDeployments = await deploymentRows(admin, alpha.tenantId);
    const betaDeployments = await deploymentRows(admin, beta.tenantId);
    const healthConnections = await connectionRows(admin, alpha.tenantId);
    const health = cliJson(db, [
      'set-deployment-health',
      '--tenant-id',
      alpha.tenantId,
      '--deployment',
      namesA.openai,
      '--status',
      'healthy',
    ]);
    expect(health.healthStatus).toBe('healthy');
    const afterHealth = await deploymentRows(admin, alpha.tenantId);
    for (const row of afterHealth) {
      const prior = alphaDeployments.find((item) => item.name === row.name);
      if (row.name === namesA.openai) {
        expect(row.health_status).toBe('healthy');
        expect(row.config_version).toBe(prior?.config_version);
        expect(row.validation_status).toBe(prior?.validation_status);
      } else {
        expect(row).toEqual(prior);
      }
    }
    expect(await deploymentRows(admin, beta.tenantId)).toEqual(betaDeployments);
    expect(await connectionRows(admin, alpha.tenantId)).toEqual(healthConnections);

    const beforeValidation = await deploymentRows(admin, alpha.tenantId);
    const dgxPrior = beforeValidation.find((item) => item.name === namesA.dgx);
    const marked = cliJson(db, [
      'validate-deployment',
      '--tenant-id',
      alpha.tenantId,
      '--deployment',
      namesA.dgx,
      '--status',
      'validated_mock',
    ]);
    expect(marked.validationStatus).toBe('validated_mock');
    expect(marked.configVersion).toBe((dgxPrior?.config_version ?? 0) + 1);
    const afterValidation = await deploymentRows(admin, alpha.tenantId);
    for (const row of afterValidation) {
      const prior = beforeValidation.find((item) => item.name === row.name);
      if (row.name === namesA.dgx) {
        expect(row.validation_status).toBe('validated_mock');
        expect(row.config_version).toBe((prior?.config_version ?? 0) + 1);
        expect(row.health_status).toBe(prior?.health_status);
      } else {
        expect(row).toEqual(prior);
      }
    }
    expect(await deploymentRows(admin, beta.tenantId)).toEqual(betaDeployments);
    const live = spawnSync(
      process.execPath,
      [cliEntry, 'validate-deployment', '--tenant-id', alpha.tenantId, '--deployment', namesA.dgx, '--status', 'validated_live'],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(live.status).not.toBe(0);
    expect(`${live.stderr}`).toContain('validation status is not available');
    const stored = await deploymentRows(admin, alpha.tenantId);
    expect(stored.find((item) => item.name === namesA.dgx)?.validation_status).toBe('validated_mock');

    console.log(JSON.stringify({
      isolation: {
        alphaRequests: (alphaSummary.requests as { total: number }).total,
        betaRequests: (betaSummary.requests as { total: number }).total,
        providers: byProvider.map((row) => ({ provider: row.provider, requests: row.requests, completed: row.completed })),
        mints: doubles.mints.length,
        autoAlpha: namesA.openai,
        validatedLive: 'rejected',
        dgxValidation: 'validated_mock',
      },
    }));
  });
});
