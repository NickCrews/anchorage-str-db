import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    // The address tests read the live Muni sources, paced and retried.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
