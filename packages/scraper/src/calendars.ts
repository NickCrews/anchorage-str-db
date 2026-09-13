/** Fetch every listing's forward calendar, paced by `pace.ts`. */

import { fetchCalendar, type CalendarDay } from './airbnb/calendar.ts';
import { mapWithConcurrency } from './concurrency.ts';
import * as config from './config.ts';
import type { IsoDate } from './dates.ts';
import { describeError, log, rootCause } from './log.ts';
import { RateLimitedError } from './pace.ts';
import { withRetries } from './retry.ts';

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
  roomId: string;
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
export type FetchOneCalendar = (roomId: string, minDate: IsoDate) => Promise<CalendarResult>;

export function liveCalendarFetcher(apiKey: string): FetchOneCalendar {
  return async (roomId, minDate) => {
    try {
      const days = await withRetries(
        () =>
          fetchCalendar({
            apiKey,
            roomId,
            currency: config.CURRENCY,
            language: config.LANGUAGE,
          }),
        {
          label: `calendar for room ${roomId}`,
          attempts: config.CALENDAR_MAX_RETRIES,
          backoffMs: config.RETRY_BACKOFF_MS,
        },
      );
      return { roomId, nights: toNights(days, minDate), error: null };
    } catch (err) {
      // A rate limit aborts the pass; other errors are recorded per listing.
      if (err instanceof RateLimitedError) throw err;
      return { roomId, nights: [], error: describeError(rootCause(err)) };
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
  roomIds: readonly string[],
  options: FetchCalendarsOptions,
): Promise<CalendarResult[]> {
  const results = await mapWithConcurrency(
    roomIds,
    options.concurrency ?? config.CALENDAR_CONCURRENCY,
    (roomId) => options.fetchOne(roomId, options.minDate),
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`calendar fetch failed for room ${result.roomId}: ${result.error}`);
    }
  }
  return results;
}
