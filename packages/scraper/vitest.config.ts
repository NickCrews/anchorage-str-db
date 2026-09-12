import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DuckDB writes real files and the store tests open one each; a single
    // fork keeps them from fighting over the same temp directory and makes
    // a failure's stack readable.
    pool: 'forks',
  },
});
