import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/docker-env.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    reporters: ['verbose'],
    include: ['test/**/*.test.ts'],
  },
});
