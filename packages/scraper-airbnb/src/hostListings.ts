/**
 * Count every listing each host holds on Airbnb, wherever it is: one host
 * per distinct `host_id`, not one per listing.
 *
 * The daily run sees only listings inside the Municipality, so a host with
 * forty listings in Palmer and two here reads as two there. The host's public
 * profile lists all of them. Its endpoint returns no total, so the count is
 * the length of the list, paged in `PAGE_SIZE` steps until a page comes back
 * short. Nearly every host fits on one page, so a host costs one request.
 * See `docs/research/airbnb-host-listings.md`.
 */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { fetchHostListingPage } from './api/hostListings.ts';
import { RETRY_BACKOFF_MS, withRetries } from './retry.ts';

const HOST_LISTINGS_CONCURRENCY = 6;
const HOST_LISTINGS_MAX_RETRIES = 3;

/**
 * Listings requested per page. Airbnb honoured every limit tried up to 100,
 * and returned a 206-listing host whole at 500, so 100 puts the ~1200
 * Anchorage hosts in one request each except the few with over 100.
 */
export const PAGE_SIZE = 100;

/**
 * Pages read before a host is abandoned as an error. 100,000 listings; a
 * list that long means the endpoint is repeating itself.
 */
const MAX_PAGES = 1000;

export interface HostListingsResult {
  hostId: string;
  /** Every listing on the host's profile; null when the read failed. */
  listingsAnywhere: number | null;
  /** Requests a successful read took, retries excluded; 0 when it failed. */
  requests: number;
  error: string | null;
}

/** One page of a host's listing ids, in Airbnb's order. */
export type FetchHostListingPage = (hostId: string, offset: number, limit: number) => Promise<string[]>;

export function liveHostListingPageFetcher(apiKey: string): FetchHostListingPage {
  return (hostId, offset, limit) =>
    withRetries(
      () =>
        fetchHostListingPage({
          apiKey,
          hostId,
          offset,
          limit,
          language: 'en',
          currency: 'USD',
        }),
      {
        label: `listings of host ${hostId} at offset ${offset}`,
        attempts: HOST_LISTINGS_MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
      },
    );
}

/**
 * The number of listings on a host's profile and the requests it took.
 * Throws if pages overlap, since the count would then be wrong.
 */
export async function countHostListings(
  hostId: string,
  fetchPage: FetchHostListingPage,
): Promise<{ listingsAnywhere: number; requests: number }> {
  const seen = new Set<string>();
  for (let requests = 1; requests <= MAX_PAGES; requests++) {
    const ids = await fetchPage(hostId, seen.size, PAGE_SIZE);
    for (const id of ids) {
      if (seen.has(id)) {
        throw new Error(`host ${hostId}: listing ${id} repeats at offset ${seen.size}`);
      }
      seen.add(id);
    }
    if (ids.length < PAGE_SIZE) return { listingsAnywhere: seen.size, requests };
  }
  throw new Error(`host ${hostId}: more than ${MAX_PAGES} pages of listings`);
}

export interface FetchHostListingsOptions {
  fetchPage: FetchHostListingPage;
  concurrency?: number;
}

/**
 * Count each host's listings. A per-host failure is recorded in its result;
 * a `RateLimitedError` aborts the pass.
 */
export async function fetchHostListings(
  hostIds: readonly string[],
  options: FetchHostListingsOptions,
): Promise<HostListingsResult[]> {
  const results = await mapWithConcurrency(
    hostIds,
    options.concurrency ?? HOST_LISTINGS_CONCURRENCY,
    async (hostId): Promise<HostListingsResult> => {
      try {
        return { hostId, ...(await countHostListings(hostId, options.fetchPage)), error: null };
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        return { hostId, listingsAnywhere: null, requests: 0, error: describeError(rootCause(err)) };
      }
    },
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`host listings fetch failed for host ${result.hostId}: ${result.error}`);
    }
  }
  return results;
}
