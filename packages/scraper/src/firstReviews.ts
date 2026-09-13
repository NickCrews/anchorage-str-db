/**
 * Resolve each listing's earliest review date, once per listing.
 *
 * A room's first review is a public signal from before this project started
 * collecting, and an upper bound on when the room went live: it was booked,
 * so listed, on or before that date. The date never changes once a review
 * exists, so a listing is resolved once and never fetched again
 * (`pendingFirstReviews` in `store.ts` skips resolved listings).
 *
 * Airbnb's reviews endpoint sorts newest first and has no oldest-first sort,
 * so the oldest review is read from the end of the list:
 *
 * 1. Request the last `TAIL_WINDOW` reviews, positioned by the review count
 *    from search. Search omits the count for listings with very few reviews,
 *    so a missing count positions the request at the start, which covers
 *    listings with up to `TAIL_WINDOW` reviews.
 * 2. Every response carries Airbnb's own total. If the first request did not
 *    reach it (search's count was stale or missing), request the tail again
 *    at the true offset.
 *
 * A listing costs one request, or two when search's count is off.
 *
 * A listing with no reviews resolves to `firstReviewDate: null` and is not
 * fetched again. Its eventual first review would fall after its
 * `first_seen_date`, so it could not change `first_available_date_est`.
 */

import { fetchReviewPage, type ReviewPage } from './airbnb/reviews.ts';
import { mapWithConcurrency } from './concurrency.ts';
import * as config from './config.ts';
import type { IsoDate } from './dates.ts';
import { describeError, log, rootCause } from './log.ts';
import { RateLimitedError } from './pace.ts';
import { withRetries } from './retry.ts';

/**
 * Reviews requested per page. More than one so a listing whose search count
 * is slightly low, or missing with few reviews, still resolves in one request.
 */
export const TAIL_WINDOW = 5;

/** A listing to resolve, with search's review count to position the request. */
export interface FirstReviewCandidate {
  roomId: string;
  reviewCountHint: number | null;
}

export interface FirstReviewResult {
  roomId: string;
  /** The UTC date of the oldest review; null when the listing has none. */
  firstReviewDate: IsoDate | null;
  error: string | null;
}

/** One page of a listing's reviews, newest first. */
export type FetchReviewPage = (roomId: string, offset: number, limit: number) => Promise<ReviewPage>;

export function liveReviewPageFetcher(apiKey: string): FetchReviewPage {
  return (roomId, offset, limit) =>
    withRetries(
      () =>
        fetchReviewPage({
          apiKey,
          roomId,
          offset,
          limit,
          language: config.LANGUAGE,
          currency: config.CURRENCY,
        }),
      {
        label: `reviews for room ${roomId} at offset ${offset}`,
        attempts: config.FIRST_REVIEW_MAX_RETRIES,
        backoffMs: config.RETRY_BACKOFF_MS,
      },
    );
}

/** Whether `page`, fetched at `offset`, holds the listing's oldest review. */
function reachesEnd(page: ReviewPage, offset: number): boolean {
  return page.createdAt.length > 0 && offset + page.createdAt.length === page.totalCount;
}

/**
 * The listing's oldest review date, or null if it has no reviews. Throws if
 * two requests don't reach the end of the list.
 */
export async function findFirstReviewDate(
  candidate: FirstReviewCandidate,
  fetchPage: FetchReviewPage,
): Promise<IsoDate | null> {
  const { roomId } = candidate;
  let offset = Math.max(0, (candidate.reviewCountHint ?? 0) - TAIL_WINDOW);
  let page = await fetchPage(roomId, offset, TAIL_WINDOW);
  if (page.totalCount === 0) return null;

  if (!reachesEnd(page, offset)) {
    offset = Math.max(0, page.totalCount - TAIL_WINDOW);
    page = await fetchPage(roomId, offset, TAIL_WINDOW);
    if (page.totalCount === 0) return null;
    if (!reachesEnd(page, offset)) {
      throw new Error(
        `room ${roomId}: ${page.createdAt.length} reviews at offset ${offset} ` +
          `do not reach the reported total of ${page.totalCount}`,
      );
    }
  }
  // The minimum rather than the last entry, so the result doesn't depend on
  // Airbnb's sort being exact within the page.
  const dates = page.createdAt.map((timestamp) => timestamp.slice(0, 10));
  return dates.reduce((a, b) => (b < a ? b : a));
}

export interface FetchFirstReviewsOptions {
  fetchPage: FetchReviewPage;
  /** At most this many listings are attempted; the rest wait for a later run. */
  maxListings?: number;
  concurrency?: number;
}

/**
 * Resolve up to `maxListings` candidates, in the order given. A per-listing
 * failure is recorded in its result; a `RateLimitedError` aborts the pass.
 */
export async function fetchFirstReviews(
  candidates: readonly FirstReviewCandidate[],
  options: FetchFirstReviewsOptions,
): Promise<FirstReviewResult[]> {
  const batch = candidates.slice(0, options.maxListings ?? config.FIRST_REVIEW_MAX_PER_RUN);
  const results = await mapWithConcurrency(
    batch,
    options.concurrency ?? config.FIRST_REVIEW_CONCURRENCY,
    async (candidate): Promise<FirstReviewResult> => {
      try {
        const firstReviewDate = await findFirstReviewDate(candidate, options.fetchPage);
        return { roomId: candidate.roomId, firstReviewDate, error: null };
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        return {
          roomId: candidate.roomId,
          firstReviewDate: null,
          error: describeError(rootCause(err)),
        };
      }
    },
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`first-review fetch failed for room ${result.roomId}: ${result.error}`);
    }
  }
  return results;
}
