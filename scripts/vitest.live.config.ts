import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  test: {
    environment: 'node',
    globals: false,
    fileParallelism: false,
    globalSetup: [join(root, 'test/global-setup.ts')],
    setupFiles: [join(root, 'test/docker-env.ts')],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: [join(root, 'scripts/live-env-cost.test.ts')],
  },
});
