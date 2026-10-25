import { ConfigError, loadConfig } from './config.js';
import { createCredentialStore } from './credentials.js';
import { createPool } from './db/pools.js';
import { migrate } from './db/migrate.js';
import { pollEvaluationOnce, runEvaluationWorker } from './inference/evaluation-worker.js';
import { createSampleKeyManager } from './inference/sample-crypto.js';
import { createLogger } from './logger.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function readFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === '') return false;
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  throw new ConfigError([`${name} must be true or false`]);
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const logger = createLogger('error');
    if (error instanceof ConfigError) logger.error('invalid configuration', { errors: error.errors });
    else logger.error('invalid configuration');
    process.exit(1);
  }

  let dryRun = false;
  let drain = false;
  try {
    dryRun = readFlag(process.env.EVALUATION_DRY_RUN, 'EVALUATION_DRY_RUN');
    drain = readFlag(process.env.EVALUATION_WORKER_DRAIN, 'EVALUATION_WORKER_DRAIN');
  } catch (error) {
    const logger = createLogger('error');
    if (error instanceof ConfigError) logger.error('invalid configuration', { errors: error.errors });
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const migrator = createPool(config, 'migrator', logger, 1);
  try {
    const applied = await migrate(migrator);
    logger.info('migrations complete', { applied });
  } catch (error) {
    logger.error('migration failed', { message: errorMessage(error) });
    await migrator.end().catch(() => undefined);
    process.exit(1);
  }
  await migrator.end();

  const runtimePool = createPool(config, 'runtime', logger);
  const controller = new AbortController();
  const stop = (signal: string): void => {
    logger.info('evaluation worker shutdown started', { signal });
    controller.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const credentialStore =
    config.providerCredentialKey === null
      ? null
      : createCredentialStore(config.providerCredentialKey, config.previousCredentialKeys);
  const sampleKeyManager =
    config.providerCredentialKey === null
      ? null
      : createSampleKeyManager(config.providerCredentialKey, config.previousCredentialKeys);
  const callCounter = { count: 0 };
  const workerOptions = {
    workerId: 'evaluation-worker',
    dryRun,
    executionEnabled: config.evaluationExecutionEnabled,
    replayTenantIds: config.evaluationReplayTenantIds,
    upstreamBaseUrl: config.openAiBaseUrl,
    credentialStore,
    sampleKeyManager,
    signal: controller.signal,
    logger,
    callCounter,
  };

  try {
    if (drain) {
      while (!controller.signal.aborted) {
        const result = await pollEvaluationOnce(runtimePool, workerOptions);
        if (result.outcome === 'idle' || result.outcome === 'skipped') break;
      }
      logger.info('evaluation worker drain complete', { modelCalls: callCounter.count });
    } else {
      await runEvaluationWorker(runtimePool, logger, workerOptions);
    }
  } catch (error) {
    logger.error('evaluation worker failed', { message: errorMessage(error) });
    await runtimePool.end().catch(() => undefined);
    process.exit(1);
  }
  await runtimePool.end();
  process.exit(0);
}

void main();
