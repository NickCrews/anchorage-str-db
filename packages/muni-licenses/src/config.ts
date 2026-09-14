/** Request tuning for CityView license pages. */

/**
 * A license page takes ~0.5s to serve; 2/s keeps the load on the CityView
 * portal to about one request at a time.
 */
export const REQUESTS_PER_SECOND = 2;
export const CONCURRENCY = 2;
export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 30_000;

/** Backoff between retries of a failed read: `RETRY_BACKOFF_MS * attempt`. */
export const RETRY_BACKOFF_MS = 500;
