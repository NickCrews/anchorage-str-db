/** Request tuning for the registration layers. */

/**
 * A run is a handful of requests, so this only spaces out retries against
 * ArcGIS Online.
 */
export const REQUESTS_PER_SECOND = 2;

/** Features per query: the registration layers' `maxRecordCount`. */
export const PAGE_SIZE = 2000;
export const TIMEOUT_MS = 60_000;

/** A failed layer query fails the run, so it gets more attempts than a page read. */
export const MAX_RETRIES = 4;
export const RETRY_BACKOFF_MS = 1500;
