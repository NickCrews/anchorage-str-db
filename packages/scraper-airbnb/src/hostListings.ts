/**
 * Read every listing on each host's profile: the host listing portfolio,
 * wherever the listings are, rather than the Anchorage subset search sees.
 *
 * A host holding two listings in Anchorage and forty in Maui is a large
 * operator, but search only ever shows us the two. The profile lists all of
 * them. It lists only what the host has listed now: a deactivated listing
 * leaves it, and a listing that changes hands moves to the new host's
 * profile. See `docs/research/airbnb-host-listings.md`.
 *
 * The pass returns each host's listings with every field Airbnb sent, for
 * storage as columns. When a response has something those columns can't
 * hold, or can't be parsed at all, it returns the response bodies verbatim
 * instead, so nothing Airbnb said is lost before the parser catches up.
 */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { fetchHostListingsPage, parseHostListingsPage, type ProfileListing } from './api/hostListings.ts';
import { RETRY_BACKOFF_MS, withRetries } from './retry.ts';

const HOST_LISTINGS_CONCURRENCY = 6;
const HOST_LISTINGS_MAX_RETRIES = 3;

/**
 * Listings requested per page. Airbnb's own profile page asks for 12. At 1000
 * the endpoint returned a full page of 1000 (a hotel chain's account), so it
 * has no cap below this and a shorter page is the end of the list. Every
 * host here but one costs one request.
 */
export const PAGE_SIZE = 1000;

/**
 * Pages before a host is given up on. Far beyond any Airbnb account, so
 * reaching it means the offset is being ignored.
 */
const MAX_PAGES = 50;

export interface HostListingsResult {
  hostId: string;
  /** Whether every request needed succeeded. Nothing is stored for the host otherwise. */
  fetchOk: boolean;
  /**
   * Every listing on the profile, de-duplicated by id, in Airbnb's order.
   * Null when a response couldn't be parsed, or had something
   * `ProfileListing` can't hold; `responses` has them then.
   */
  listings: ProfileListing[] | null;
  /** Every response body, in page order, verbatim. */
  responses: string[];
  /**
   * Why the read is not a clean one, or null. With `fetchOk` false: the
   * request that failed after retries (its HTTP status and the start of the
   * body, or the network error). With `fetchOk` true: why `listings` is null.
   */
  error: string | null;
}

/** One page of a host's profile listings: the response body, verbatim. */
export type FetchHostListingsPage = (hostId: string, offset: number, limit: number) => Promise<string>;

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
 * Every page of the host's profile listings. The endpoint has no total, so
 * this pages until a short page. A request that fails after retries ends the
 * read with `fetchOk` false; a `RateLimitedError` is rethrown.
 */
export async function readHostListings(
  hostId: string,
  fetchPage: FetchHostListingsPage,
): Promise<HostListingsResult> {
  const responses: string[] = [];
  const byId = new Map<string, ProfileListing>();
  const unrecognized = new Set<string>();

  let offset = 0;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    let body: string;
    try {
      body = await fetchPage(hostId, offset, PAGE_SIZE);
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      return { hostId, fetchOk: false, listings: null, responses, error: describeError(rootCause(err)) };
    }
    responses.push(body);

    let page: ProfileListing[];
    try {
      const parsed = parseHostListingsPage(body, hostId);
      page = parsed.listings;
      for (const field of parsed.unrecognized) unrecognized.add(field);
    } catch (err) {
      // Can't tell how many listings the page held, so can't page past it.
      return { hostId, fetchOk: true, listings: null, responses, error: describeError(err) };
    }
    // A listing added between requests shifts later pages by one.
    for (const listing of page) byId.set(listing.listingId, listing);
    if (page.length < PAGE_SIZE) {
      return unrecognized.size
        ? {
            hostId,
            fetchOk: true,
            listings: null,
            responses,
            error: `unrecognized in the response: ${[...unrecognized].sort().join('; ')}`,
          }
        : { hostId, fetchOk: true, listings: [...byId.values()], responses, error: null };
    }
    offset += page.length;
  }
  return {
    hostId,
    fetchOk: false,
    listings: null,
    responses,
    error: `profile listings still paging after ${MAX_PAGES} pages`,
  };
}

export interface FetchHostListingsOptions {
  fetchPage: FetchHostListingsPage;
  concurrency?: number;
}

/**
 * Read every host's profile listings. The request rate is set by `pace.ts`.
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
    (hostId) => readHostListings(hostId, options.fetchPage),
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`profile listings for host ${result.hostId}: ${result.error}`);
    }
  }
  return results;
}
