/**
 * Constants for the municipal STR registry scrape.
 *
 * The one value with no default is the service URL. Anchorage publishes the
 * registry through ArcGIS, but the Feature Service endpoint is not linked
 * from the program page, and the URL is not something to guess: a wrong
 * layer would scrape real, plausible-looking rows of the wrong thing. It is
 * read from `--service-url` or `ANCHORAGE_STR_REGISTRY_URL`. See
 * `docs/research/anchorage-str-registry.md` for how to find it, and run
 * `registry probe <url>` to confirm a candidate before wiring it in.
 */

/** The environment variable read when `--service-url` is not given. */
export const SERVICE_URL_ENV = 'ANCHORAGE_STR_REGISTRY_URL';

/** Raised when no service URL was configured. */
export class MissingServiceUrlError extends Error {
  constructor() {
    super(
      `no ArcGIS layer URL: pass --service-url or set ${SERVICE_URL_ENV}. It looks like ` +
        'https://services<N>.arcgis.com/<org>/arcgis/rest/services/<Service>/FeatureServer/0 ' +
        "— see docs/research/anchorage-str-registry.md, 'Finding the endpoint'.",
    );
    this.name = 'MissingServiceUrlError';
  }
}

/**
 * The configured layer URL, without a trailing slash.
 *
 * A URL ending in `/FeatureServer` or `/MapServer` names a service, not a
 * layer, and every query would fail with a confusing ArcGIS error; reject it
 * here instead.
 */
export function serviceUrl(override?: string): string {
  const raw = (override ?? process.env[SERVICE_URL_ENV] ?? '').trim();
  if (!raw) throw new MissingServiceUrlError();
  const url = raw.replace(/\/+$/, '');
  if (!/\/(?:Feature|Map)Server\/\d+$/.test(url)) {
    throw new Error(
      `${url} is not a layer URL: it must end with a layer index, e.g. ` +
        `${/\/(?:Feature|Map)Server$/.test(url) ? `${url}/0` : '.../FeatureServer/0'}`,
    );
  }
  return url;
}

export const DEFAULT_DB_PATH = 'data/anchorage_str.duckdb';

/** Coordinates are requested in WGS84, to match `listings.location_lat/lng`. */
export const OUT_SPATIAL_REFERENCE = 4326;

/**
 * Object ids per `queryByObjectIds` request, when the layer does not report
 * its own `maxRecordCount`. Servers commonly cap a page at 1000-2000 rows and
 * silently truncate above it, which `queryByObjectIds` would catch, but
 * starting inside the usual cap avoids the round trip.
 */
export const DEFAULT_BATCH_SIZE = 1000;

/** Object ids per request never exceeds this, however large `maxRecordCount` is. */
export const MAX_BATCH_SIZE = 2000;

/** Attempts per request, and the linear backoff between them. */
export const MAX_RETRIES = 4;
export const RETRY_BACKOFF_MS = 1000;

export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Identifies this client to the Municipality's GIS staff, who see it in
 * their server logs. A whole run is a handful of requests against a public,
 * unauthenticated endpoint, so there is no rate limiting here; be reachable
 * rather than anonymous.
 */
export const USER_AGENT =
  'anchorage-str-db/0.1 (+https://github.com/NickCrews/anchorage-str-db)';

/**
 * A run fails if the record count is outside this range, which suggests a
 * changed layer, a filtered view, or a partial extract. Anchorage's program
 * opened in May 2026 with an estimated 2,000-3,000 STRs in the Municipality;
 * widen the floor once a few runs have established the real count.
 */
export const PLAUSIBLE_RECORD_COUNT: readonly [number, number] = [100, 20_000];

/**
 * The largest share of the previous run's records that may disappear in one
 * run before the merge refuses to write.
 *
 * This is a guard, not a check: closing a version interval is how the merge
 * records a removal, so a partial extract that returned a tenth of the layer
 * would retire nine tenths of the registry, and the next full extract would
 * reopen all of them as new registrations. Registrations lapse in annual
 * cohorts, so a real drop of a few percent a day is possible and 0 would be
 * too tight.
 */
export const MAX_SHRINK_RATE = 0.1;

/**
 * The guard above is off below this many records. A share is meaningless on
 * a handful of rows — one registration of three lapsing is a 33% drop — and
 * a registry that small is caught by `PLAUSIBLE_RECORD_COUNT` anyway.
 */
export const SHRINK_GUARD_MIN_RECORDS = 50;

/**
 * The share of records that must carry a usable registration number below
 * which the run fails. That column is the join key to the Airbnb side; if it
 * stops parsing, the registry is still worth storing but nothing downstream
 * can use it, so fail loudly.
 */
export const MIN_REGISTRATION_ID_SHARE = 0.95;

/** How many sample records `registry probe` prints. */
export const PROBE_SAMPLE_SIZE = 5;

/**
 * The share of records that may open a new version in one run before the
 * `change_rate_plausible` check warns. Registrations move a few times a year
 * each, so a normal run changes a fraction of a percent; a quarter of the
 * layer changing at once is a republish that rewrote a hashed column, which
 * `records.ts` is meant to be immune to. Records new that run are exempt.
 */
export const MAX_CHANGE_RATE = 0.25;
