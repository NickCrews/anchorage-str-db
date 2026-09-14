import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    // The tests read real pages from the Muni's portal, paced at 2/s with
    // retries.
    testTimeout: 60_000,
  },
});
