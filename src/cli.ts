import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pools.js';
import { addTenantKey, provisionTenant, revokeTenantKey } from './db/provision.js';
import { createLogger } from './logger.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const logger = createLogger('error', process.stderr);
    if (error instanceof ConfigError) {
      logger.error('invalid configuration', { errors: error.errors });
    } else {
      logger.error('invalid configuration');
    }
    process.exit(1);
  }

  const logger = createLogger(config.logLevel, process.stderr);
  let command = '';
  let values: {
    name?: string;
    'tenant-id'?: string;
    'key-id'?: string;
    label?: string;
  };
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        name: { type: 'string' },
        'tenant-id': { type: 'string' },
        'key-id': { type: 'string' },
        label: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    command = parsed.positionals[0] ?? '';
    values = parsed.values;
  } catch {
    logger.error('invalid command arguments');
    process.exit(1);
  }

  const pool = createPool(config, 'migrator', logger, 1);
  try {
    if (command === 'provision-tenant') {
      const name = values.name?.trim() ?? '';
      if (name.length === 0) {
        logger.error('name is required');
        process.exitCode = 1;
        return;
      }
      const created = await provisionTenant(pool, { name, label: values.label });
      process.stdout.write(`${JSON.stringify(created)}\n`);
      return;
    }

    if (command === 'add-key') {
      const tenantId = values['tenant-id'] ?? '';
      if (!UUID.test(tenantId)) {
        logger.error('tenant-id is required');
        process.exitCode = 1;
        return;
      }
      const created = await addTenantKey(pool, { tenantId, label: values.label });
      process.stdout.write(`${JSON.stringify(created)}\n`);
      return;
    }

    if (command === 'revoke-key') {
      const tenantId = values['tenant-id'] ?? '';
      const keyId = values['key-id'] ?? '';
      if (!UUID.test(tenantId) || !UUID.test(keyId)) {
        logger.error('tenant-id and key-id are required');
        process.exitCode = 1;
        return;
      }
      const revoked = await revokeTenantKey(pool, { tenantId, keyId });
      if (!revoked) {
        logger.error('key was not revoked');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify({ tenantId, keyId, revoked: true })}\n`);
      return;
    }

    logger.error('unknown command');
    process.exitCode = 1;
  } catch (error) {
    logger.error('command failed', { message: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
