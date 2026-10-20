import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { freePort, spawnServer, waitForExit } from './helpers.js';

const password = 'super-secret-db-pass';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    HOST: '127.0.0.1',
    PORT: '8080',
    LOG_LEVEL: 'info',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'llm_proxy',
    MIGRATOR_USER: 'llm_migrator',
    MIGRATOR_PASSWORD: password,
    AUTH_USER: 'llm_auth',
    AUTH_PASSWORD: 'auth-secret-value',
    RUNTIME_USER: 'llm_runtime',
    RUNTIME_PASSWORD: 'runtime-secret-value',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

describe('configuration failure', () => {
  it('rejects incomplete configuration without echoing secrets', () => {
    expect(() => loadConfig(env({ DATABASE_HOST: undefined }))).toThrow(ConfigError);
    try {
      loadConfig(env({ DATABASE_HOST: '' }));
      throw new Error('loadConfig accepted an empty database host');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      const text = JSON.stringify({ message: configError.message, errors: configError.errors });
      expect(text).toContain('DATABASE_HOST');
      expect(text).not.toContain(password);
      expect(text).not.toContain('auth-secret-value');
      expect(text).not.toContain('runtime-secret-value');
    }
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(env({ LOG_LEVEL: 'verbose' }))).toThrow(/LOG_LEVEL/);
  });

  it('exits before listening when a required setting is missing', async () => {
    const port = await freePort();
    const started = spawnServer(env({ PORT: String(port), DATABASE_HOST: undefined }));
    const code = await waitForExit(started.child, 10_000);
    const output = started.output();
    expect(code).toBe(1);
    expect(output).not.toContain(password);
    expect(output).not.toContain('auth-secret-value');
    expect(output).not.toContain('listening');
    const lines = output.trim().split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const event = JSON.parse(line) as { msg?: string; errors?: string[] };
      expect(event.msg).toBe('invalid configuration');
    }
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow();
  });
});
