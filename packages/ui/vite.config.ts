import {createReadStream, existsSync, readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig, type Plugin} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

const DB_FILE = 'anchorage_str.duckdb';
const DB_PATH = fileURLToPath(new URL(`../../data/${DB_FILE}`, import.meta.url));
const MISSING_DB = `${DB_PATH} not found: run a scrape or download the latest-data release into data/`;

/**
 * Serves the repo's `data/anchorage_str.duckdb` at `<base>anchorage_str.duckdb`
 * in dev, read on every request so a reload shows the latest scrape, and
 * copies it into the build output. A build without it fails.
 */
function serveDatabase(): Plugin {
  return {
    name: 'serve-database',
    configureServer(server) {
      server.middlewares.use(`${server.config.base}${DB_FILE}`, (_req, res) => {
        if (!existsSync(DB_PATH)) {
          res.statusCode = 404;
          res.end(MISSING_DB);
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', statSync(DB_PATH).size);
        createReadStream(DB_PATH).pipe(res);
      });
    },
    generateBundle() {
      if (!existsSync(DB_PATH)) this.error(MISSING_DB);
      this.emitFile({type: 'asset', fileName: DB_FILE, source: readFileSync(DB_PATH)});
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveDatabase()],
  build: {
    rollupOptions: {
      input: {
        story: fileURLToPath(new URL('index.html', import.meta.url)),
        registrationProblems: fileURLToPath(new URL('registration-problems.html', import.meta.url)),
      },
    },
  },
});
