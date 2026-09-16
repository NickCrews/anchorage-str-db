/**
 * The modules the browser viewer imports must stay importable in a browser.
 *
 * `database.ts` and `connect.ts` load `@duckdb/node-api`, a native addon, and
 * the root of `@duckdbfan/drizzle-duckdb` loads it too. Reaching any of them
 * from `schema.ts` or a module beside it would break the viewer's build, and
 * an import added two files away is easy to miss, so the import graph is
 * walked from each entry point rather than eyeballed.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The entry points the viewer imports; see the README. */
const BROWSER_SAFE_MODULES = ['catalog', 'columns', 'rows', 'schema', 'sql', 'viewSchema'] as const;

/** Packages a browser-safe module may import. Add to this deliberately. */
const ALLOWED_PACKAGES = new Set([
  'drizzle-orm',
  'drizzle-orm/pg-core',
  '@duckdbfan/drizzle-duckdb/helpers',
  // A module of two constants and no imports, so the `registrations` view can
  // name the value the Muni's layer publishes for an unmatched address.
  '@anchorage-str-db/scraper-muni-str/noMatch',
]);

const IMPORT = /\bfrom\s*['"]([^'"]+)['"]/g;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

/** Every module reachable from `entry`, and the packages they import. */
async function reachable(entry: URL): Promise<{ files: string[]; packages: Set<string> }> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const path = fileURLToPath(next);
    if (seen.has(path)) continue;
    seen.add(path);
    // Comments first: the prose in `schema.ts` says "from" often enough.
    const source = (await readFile(path, 'utf8')).replace(COMMENT, '');
    for (const [, specifier] of source.matchAll(IMPORT)) {
      if (specifier!.startsWith('.')) queue.push(new URL(specifier!, next));
      else packages.add(specifier!);
    }
  }
  return { files: [...seen], packages };
}

describe('browser-safe modules', () => {
  it.for(BROWSER_SAFE_MODULES)('%s imports no Node-only package', async (module) => {
    const { packages } = await reachable(new URL(`../src/${module}.ts`, import.meta.url));

    expect([...packages].filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
  });

  it('reaches neither the connection nor the migrations', async () => {
    const files = (
      await Promise.all(
        BROWSER_SAFE_MODULES.map(async (module) =>
          (await reachable(new URL(`../src/${module}.ts`, import.meta.url))).files,
        ),
      )
    ).flat();

    expect(files.filter((path) => /database\.ts|connect\.ts|views\.ts/.test(path))).toEqual([]);
  });
});
