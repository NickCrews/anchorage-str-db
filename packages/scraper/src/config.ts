/**
 * Database location, retirement rule, and the quality-check thresholds for
 * the daily Airbnb run and the registry run. Request tuning for each source
 * lives in its own package's `config.ts`.
 */

export const DEFAULT_DB_PATH = 'data/anchorage_str.duckdb';

/**
 * Days a listing may be absent from search before `listings.is_current` goes
 * false. Search occasionally omits a listing for a day.
 */
export const RETIREMENT_GRACE_DAYS = 5;

/**
 * A run fails if the current listing count is outside this range, which
 * suggests a broken bbox, a blocked scrape, or an API change. The floor is
 * well above the 280 a single unsplit query returns.
 */
export const PLAUSIBLE_LISTING_COUNT: readonly [number, number] = [1000, 8000];

/**
 * Fraction of audit-box listings the price bands may miss before the run
 * fails. The measured rate is 0% (68 listings in 4 usable boxes); a
 * paginating search misses ~8%. Non-zero to allow minor inconsistency between
 * the two query shapes.
 */
export const MAX_COVERAGE_MISS_RATE = 0.05;

/** A calendar-fetch failure rate above this fails the run. */
export const MAX_CALENDAR_FAILURE_RATE = 0.25;

/** A listing-page failure rate above this fails the run. */
export const MAX_PAGE_FAILURE_RATE = 0.25;

/**
 * The share of current, page-read listings with a value below which the run
 * fails, for each page field every listing has: `host_id`, `room_type`,
 * `guest_capacity`, `beds`, `bathrooms`, and photos. Every real page sampled
 * (41 for the host, 44 for the rest) yielded each one, so a shortfall means
 * the extraction broke.
 */
export const MIN_PAGE_FIELD_SHARE = 0.95;

/**
 * The same for `bedrooms`, which rooms and some campers omit: 33 of 44
 * sampled pages had a bedroom or studio line.
 */
export const MIN_BEDROOMS_SHARE = 0.6;

/** A price-quote failure rate above this fails the run. */
export const MAX_QUOTE_FAILURE_RATE = 0.25;

/**
 * The share of quotes read without error that carry a price, below which the
 * run fails. A quote can lack one when a stay was booked between the calendar
 * fetch and the quote, or Airbnb's advance-notice rules block it.
 */
export const MIN_QUOTE_PRICE_SHARE = 0.8;

/**
 * A first-review failure rate above this fails the `first_review_failure_rate`
 * check, at warn severity (see `checks.ts`).
 */
export const MAX_FIRST_REVIEW_FAILURE_RATE = 0.25;

/**
 * Warn-severity gates on the host dimension (see `checks.ts`). A failed page
 * is the ordinary cause of an unread card, so the failure rate mirrors
 * `MAX_PAGE_FAILURE_RATE`. The views carry each host's last read forward, so
 * only hosts never once read can lack a profile; 2616 of 2618 pages measured
 * yielded a card.
 */
export const MAX_HOST_PROFILE_FAILURE_RATE = 0.25;
export const MIN_HOST_PROFILE_SHARE = 0.95;

/**
 * How far the start dates implied by one host's `timeAsHost` readings may
 * spread before `host_start_date_stable` warns. Readings in whole months
 * taken on different days of the month disagree by up to about a month.
 */
export const HOST_START_MAX_SPREAD_DAYS = 45;

// --------------------------------------------------------------------------
// Municipal STR registry (`registry.ts`)

/**
 * License pages read per run (see `pendingLicensePages`). The ~2500 current
 * registrations need ~360 reads a day at `LICENSE_PAGE_REFRESH_DAYS`, so a
 * backfill from empty takes about 5 runs. Reading 1000 in a run took 9
 * minutes once and 24 minutes the next, when the portal began timing out and
 * the pacer backed off to 0.5/s; this cap keeps the run well inside the CI
 * timeout either way.
 */
export const LICENSE_PAGE_MAX_PER_RUN = 500;

/**
 * A current registration's license page is re-read once its latest read is
 * this old. The ArcGIS layer is republished about weekly, and a page's
 * description and parcel rarely change.
 */
export const LICENSE_PAGE_REFRESH_DAYS = 7;

/** A license-page failure rate above this fails the registry run. */
export const MAX_LICENSE_PAGE_FAILURE_RATE = 0.25;

/**
 * A registry run fails if the layer holds a registration count outside this
 * range. 2549 registrations were published on 2026-09-07.
 */
export const PLAUSIBLE_REGISTRATION_COUNT: readonly [number, number] = [1000, 10000];

/**
 * Warn when more than this share of the previous run's registrations are
 * missing from today's layer, which suggests a partial republish rather
 * than lapsed registrations.
 */
export const MAX_REGISTRATION_DEPARTURE_SHARE = 0.1;

/**
 * Warn when fewer than this share of the registration numbers on current
 * Airbnb listings appear in the registry. 1860 of 1879 matched on
 * 2026-09-13; the rest were issued after the layer's last publish.
 */
export const MIN_AIRBNB_REGISTRATION_MATCH_SHARE = 0.8;
