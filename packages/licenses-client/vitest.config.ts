import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    // The live tests read real pages from the Muni's portal, paced at 1/s,
    // and a 429 waits up to a minute before its retry.
    testTimeout: 60_000,
  },
});
