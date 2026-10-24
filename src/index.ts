import { ConfigError, loadConfig, type Config } from './config.js';
import { createPool } from './db/pools.js';
import { latestMigrationVersion, migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { createLogger, type Logger } from './logger.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

async function shutdownProcess(
  signal: string,
  logger: Logger,
  drainMs: number,
  drain: () => Promise<{ aborted: number; activeAfter: number }>,
  closeServer: () => Promise<void>,
  closePools: () => Promise<void>,
): Promise<void> {
  const timer = setTimeout(() => {
    logger.error('shutdown timed out');
    process.exit(1);
  }, drainMs + 15_000);
  timer.unref();
  logger.info('shutdown started', { signal });
  try {
    const drained = await drain();
    logger.info('stream drain complete', { aborted: drained.aborted, active: drained.activeAfter });
  } catch (error) {
    logger.error('stream drain failed', { message: errorMessage(error) });
  }
  try {
    await closeServer();
  } catch (error) {
    logger.error('server close failed', { message: errorMessage(error) });
  }
  try {
    await closePools();
  } catch (error) {
    logger.error('pool close failed', { message: errorMessage(error) });
    process.exit(1);
  }
  logger.info('shutdown complete', { pools: 'closed' });
  process.exit(0);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const logger = createLogger('error');
    if (error instanceof ConfigError) {
      logger.error('invalid configuration', { errors: error.errors });
    } else {
      logger.error('invalid configuration');
    }
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

  const authPool = createPool(config, 'auth', logger);
  const runtimePool = createPool(config, 'runtime', logger);
  const readyVersion = await latestMigrationVersion();
  const app = buildApp({
    logger,
    authPool,
    runtimePool,
    readyVersion,
    inferenceEnabled: config.inferenceEnabled,
    upstreamBaseUrl: config.openAiBaseUrl,
    credentialKey: config.providerCredentialKey,
    previousCredentialKeys: config.previousCredentialKeys,
    maxActiveStreams: config.maxActiveStreams,
    maxStreamsPerTenant: config.maxStreamsPerTenant,
  });

  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownProcess(
      signal,
      logger,
      config.streamShutdownDrainMs,
      () => app.drainStreams(config.streamShutdownDrainMs),
      () => app.close(),
      async () => {
        await authPool.end();
        await runtimePool.end();
      },
    );
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info('listening', { host: config.host, port: config.port });
  } catch (error) {
    logger.error('listen failed', { message: errorMessage(error) });
    await authPool.end().catch(() => undefined);
    await runtimePool.end().catch(() => undefined);
    process.exit(1);
  }
}

void main();
