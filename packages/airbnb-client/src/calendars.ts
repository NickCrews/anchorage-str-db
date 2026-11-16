/** Fetch every listing's forward calendar, paced by `pace.ts`. */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import type { IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { fetchCalendar, type CalendarDay } from './api/calendar.ts';
import { RETRY_BACKOFF_MS, withRetries } from './retry.ts';

/**
 * Maximum concurrent calendar requests. `pace.ts` sets the request rate; this
 * only needs to be high enough to reach it at ~0.9s per request.
 */
const CALENDAR_CONCURRENCY = 6;
const CALENDAR_MAX_RETRIES = 3;

export interface CalendarNight {
  nightDate: IsoDate;
  available: boolean;
  minNights: number | null;
  /** Used to choose a stay to price (`priceQuotes.ts`); not stored. */
  availableForCheckin: boolean;
  availableForCheckout: boolean;
  maxNights: number | null;
}

export interface CalendarResult {
  listingId: string;
  nights: CalendarNight[];
  error: string | null;
}

/**
 * Convert calendar days to nights, dropping days before `minDate`. Airbnb
 * returns the whole current month and marks elapsed days `available: false`,
 * which would otherwise read as booked.
 */
export function toNights(days: readonly CalendarDay[], minDate: IsoDate): CalendarNight[] {
  return days
    .filter((day) => day.calendarDate >= minDate)
    .map((day) => ({
      nightDate: day.calendarDate,
      available: day.available,
      minNights: day.minNights,
      availableForCheckin: day.availableForCheckin,
      availableForCheckout: day.availableForCheckout,
      maxNights: day.maxNights,
    }));
}

/** One listing's calendar. A per-listing failure is reported, not thrown. */
export type FetchOneCalendar = (listingId: string, minDate: IsoDate) => Promise<CalendarResult>;

export function liveCalendarFetcher(apiKey: string): FetchOneCalendar {
  return async (listingId, minDate) => {
    try {
      const days = await withRetries(
        () =>
          fetchCalendar({
            apiKey,
            listingId,
            currency: 'USD',
            language: 'en',
          }),
        {
          label: `calendar for listing ${listingId}`,
          attempts: CALENDAR_MAX_RETRIES,
          backoffMs: RETRY_BACKOFF_MS,
        },
      );
      return { listingId, nights: toNights(days, minDate), error: null };
    } catch (err) {
      // A rate limit aborts the pass; other errors are recorded per listing.
      if (err instanceof RateLimitedError) throw err;
      return { listingId, nights: [], error: describeError(rootCause(err)) };
    }
  };
}

export interface FetchCalendarsOptions {
  minDate: IsoDate;
  fetchOne: FetchOneCalendar;
  concurrency?: number;
}

/**
 * Every listing's calendar, with days before `minDate` dropped (see
 * `toNights`). A `RateLimitedError` from any listing aborts the pass.
 */
export async function fetchCalendars(
  listingIds: readonly string[],
  options: FetchCalendarsOptions,
): Promise<CalendarResult[]> {
  const results = await mapWithConcurrency(
    listingIds,
    options.concurrency ?? CALENDAR_CONCURRENCY,
    (listingId) => options.fetchOne(listingId, options.minDate),
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`calendar fetch failed for listing ${result.listingId}: ${result.error}`);
    }
  }
  return results;
}
