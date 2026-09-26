/**
 * Count every listing on each host's profile: the host listing portfolio,
 * wherever the listings are, rather than the Anchorage subset search sees.
 *
 * A host holding two listings in Anchorage and forty in Maui is a large
 * operator, but search only ever shows us the two. The profile lists all of
 * them. It lists only what the host has listed now: a deactivated listing
 * leaves it, and a listing that changes hands moves to the new host's
 * profile. See `docs/research/airbnb-host-listings.md`.
 *
 * One request per host covers any portfolio under `PAGE_SIZE`. Of 48 hosts
 * sampled, one held more (207 listings, three requests), so the pass costs
 * about one request per distinct host.
 */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { fetchHostListingsPage } from './api/hostListings.ts';
import { RETRY_BACKOFF_MS, withRetries } from './retry.ts';

const HOST_LISTINGS_CONCURRENCY = 6;
const HOST_LISTINGS_MAX_RETRIES = 3;

/**
 * Listings requested per page. Airbnb's own profile page asks for 12, but the
 * endpoint returned full pages of 1000; 100 keeps a response small while
 * covering all but the largest property managers in one request.
 */
export const PAGE_SIZE = 100;

/**
 * Pages before a host is given up on. 50,000 listings is beyond any Airbnb
 * account, so reaching it means the offset is being ignored.
 */
const MAX_PAGES = 500;

export interface HostListingsResult {
  hostId: string;
  /** The distinct listing ids on the profile, in Airbnb's order. Null on failure. */
  listingIds: string[] | null;
  error: string | null;
}

/** One page of a host's profile listing ids. */
export type FetchHostListingsPage = (hostId: string, offset: number, limit: number) => Promise<string[]>;

export function liveHostListingsPageFetcher(apiKey: string): FetchHostListingsPage {
  return (hostId, offset, limit) =>
    withRetries(
      () =>
        fetchHostListingsPage({
          apiKey,
          hostId,
          offset,
          limit,
          language: 'en',
          currency: 'USD',
        }),
      {
        label: `profile listings for host ${hostId} at offset ${offset}`,
        attempts: HOST_LISTINGS_MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
      },
    );
}

/**
 * Every listing id on the host's profile. The endpoint has no total, so this
 * pages until a page comes back short. Ids are de-duplicated, since a listing
 * added mid-way shifts later pages by one.
 */
export async function listHostListings(
  hostId: string,
  fetchPage: FetchHostListingsPage,
): Promise<string[]> {
  const ids = new Set<string>();
  let offset = 0;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await fetchPage(hostId, offset, PAGE_SIZE);
    for (const id of page) ids.add(id);
    if (page.length < PAGE_SIZE) return [...ids];
    offset += page.length;
  }
  throw new Error(`host ${hostId}: profile listings still paging after ${MAX_PAGES} pages`);
}

export interface FetchHostListingsOptions {
  fetchPage: FetchHostListingsPage;
  concurrency?: number;
}

/**
 * List every host's profile listings. The request rate is set by `pace.ts`.
 * A per-host failure is recorded in its result; a `RateLimitedError` aborts
 * the pass.
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
        const listingIds = await listHostListings(hostId, options.fetchPage);
        return { hostId, listingIds, error: null };
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        return { hostId, listingIds: null, error: describeError(rootCause(err)) };
      }
    },
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`profile listings fetch failed for host ${result.hostId}: ${result.error}`);
    }
  }
  return results;
}
