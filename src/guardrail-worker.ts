import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pools.js';
import { migrate } from './db/migrate.js';
import { runGuardrailPass } from './inference/guardrail-worker.js';
import { createLogger } from './logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function readFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === '') return false;
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  throw new ConfigError([`${name} must be true or false`]);
}

function readTenants(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const tenants = value.split(',').map((item) => item.trim().toLowerCase()).filter((item) => item !== '');
  if (tenants.some((item) => !UUID.test(item))) {
    throw new ConfigError(['GUARDRAIL_TENANTS must be a comma-separated list of tenant ids']);
  }
  return tenants;
}

function readInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 5_000;
  if (!/^\d+$/.test(value.trim())) throw new ConfigError(['GUARDRAIL_INTERVAL_MS must be an integer']);
  const parsed = Number(value);
  if (parsed < 100 || parsed > 60_000) throw new ConfigError(['GUARDRAIL_INTERVAL_MS must be from 100 to 60000']);
  return parsed;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  let tenants: string[] = [];
  let once = false;
  let intervalMs = 5_000;
  try {
    config = loadConfig(process.env);
    tenants = readTenants(process.env.GUARDRAIL_TENANTS);
    once = readFlag(process.env.GUARDRAIL_ONCE, 'GUARDRAIL_ONCE');
    intervalMs = readInterval(process.env.GUARDRAIL_INTERVAL_MS);
  } catch (error) {
    const logger = createLogger('error');
    if (error instanceof ConfigError) logger.error('invalid configuration', { errors: error.errors });
    else logger.error('invalid configuration');
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  if (tenants.length === 0) {
    logger.info('guardrail worker has no tenants');
    process.exit(0);
  }

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
    logger.info('guardrail worker shutdown started', { signal });
    controller.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  try {
    do {
      const report = await runGuardrailPass(runtimePool, tenants);
      logger.info('guardrail pass complete', {
        stops: report.stops,
        readFailures: report.readFailures,
        monitorRows: report.monitorRows,
        detectionMs: report.detectionMs,
        rollbackMs: report.rollbackMs,
        heapUsed: report.heapUsed,
      });
      if (once || controller.signal.aborted) break;
      await sleep(intervalMs, controller.signal);
    } while (!controller.signal.aborted);
  } catch (error) {
    logger.error('guardrail worker failed', { message: errorMessage(error) });
    await runtimePool.end().catch(() => undefined);
    process.exit(1);
  }
  await runtimePool.end();
  process.exit(0);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
