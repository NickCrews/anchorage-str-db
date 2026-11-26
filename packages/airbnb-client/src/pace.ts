/**
 * One request rate shared by every pass, because Airbnb limits requests per
 * IP across all of `www.airbnb.com`.
 *
 * Airbnb's edge (Akamai) allows ~130 requests per IP in a rolling window of
 * roughly 60s, regardless of burst rate:
 *
 *     ~17 req/s  ->  refused after ~133 requests  (~8s in)
 *     ~17 req/s  ->  refused after ~130 requests  (~8s in)
 *       4 req/s  ->  stalled  after ~129 requests (~32.5s in)
 *
 * That gives a sustainable rate near 2.2/s. 1400 requests at 2.0/s ran with
 * no 429s. See docs/research/airbnb-rate-limits.md.
 *
 * Exceeding the limit has two effects:
 *
 * - **Mildly (4/s):** connections hang without a 429, so the pacer lowers
 *   the rate after a streak of timeouts.
 * - **Grossly (17/s):** every endpoint on the domain returns 429 for 1-2
 *   hours.
 *
 * GitHub's runners share IPs with other traffic, so a run at this rate can
 * still meet a block. A 429 pauses every request (the pacer's `pause`
 * policy): the block is IP-wide, so retrying each listing against it is
 * pointless. One probe goes out every `PAUSE_MS`; the first that succeeds
 * resumes the run at half the rate with everything fetched so far.
 *
 * Every pass calls `withRetries` from `utils/retry` with `pace()`. Each
 * pass's `*_CONCURRENCY` only caps open connections.
 */

import { classifyFailure, Pacer, type Failure, type PacerOptions } from '@anchorage-str-db/utils/pace';

import { isRateLimited } from './api/http.ts';

/**
 * The rate every pass runs at, below the ~2.2/s ceiling above. A full run
 * takes about 50 minutes; fetching fewer listing pages would shorten it more
 * than raising this.
 */
const REQUESTS_PER_SECOND = 1.8;

/** Backoff between retries of a failed fetch: `RETRY_BACKOFF_MS * attempt`. */
export const RETRY_BACKOFF_MS = 500;

/** `classifyFailure`, with impit's `HttpError` 429 as the rate limit. */
function classifyAirbnbFailure(err: unknown): Failure {
  return isRateLimited(err) ? { kind: 'rateLimited', retryAfterMs: null } : classifyFailure(err);
}

/** How long a 429 holds every request before the next probe. */
const PAUSE_MS = 10 * 60_000;

/**
 * The most a run spends paused before it stops: the longest block measured.
 * `airbnb.yml`'s timeout allows for it.
 */
export const MAX_PAUSED_MS = 120 * 60_000;

function airbnbPacer(options: Partial<PacerOptions>): Pacer {
  return new Pacer({
    rate: REQUESTS_PER_SECOND,
    service: 'Airbnb',
    classify: classifyAirbnbFailure,
    rateLimit: {
      action: 'pause',
      pauseMs: PAUSE_MS,
      maxPausedMs: MAX_PAUSED_MS,
      advice: 'The block is IP-wide; the next run gets a new runner and IP.',
    },
    ...options,
  });
}

let pacer: Pacer | undefined;

/** The process-wide Airbnb pacer, created on first use. */
export function pace(): Pacer {
  pacer ??= airbnbPacer({});
  return pacer;
}

/** Start a fresh budget. Called once at the top of a run, and by tests. */
export function resetPace(options: Partial<PacerOptions> = {}): Pacer {
  pacer = airbnbPacer(options);
  return pacer;
}
