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
 * - **Mildly (4/s):** connections hang without a 429, so `noteTimeout` lowers
 *   the rate after a streak of timeouts.
 * - **Grossly (17/s):** every endpoint on the domain returns 429 for 1-2
 *   hours, so a 429 aborts the run: the block is IP-wide, so retrying every
 *   remaining listing against it is pointless.
 *
 * Each pass's `*_CONCURRENCY` only caps open connections.
 */

import { Pacer, type PacerOptions } from '@anchorage-str-db/utils/pace';

/**
 * The rate every pass runs at, below the ~2.2/s ceiling above. A full run
 * takes about 50 minutes; fetching fewer listing pages would shorten it more
 * than raising this.
 */
const REQUESTS_PER_SECOND = 1.8;

function airbnbPacer(options: Partial<PacerOptions>): Pacer {
  return new Pacer({
    rate: REQUESTS_PER_SECOND,
    service: 'Airbnb',
    rateLimitAdvice:
      'The block is IP-wide and lasts about an hour, so the run stops; lower ' +
      'REQUESTS_PER_SECOND.',
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
