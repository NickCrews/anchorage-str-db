import { defineConfig } from 'drizzle-kit';

// DuckDB speaks the Postgres dialect closely enough for drizzle-kit's DDL;
// review each generated migration for Postgres-only syntax before committing.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
});
