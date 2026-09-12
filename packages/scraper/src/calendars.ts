/**
 * Fetch every listing's forward calendar, capped concurrency, paced against
 * the run-wide budget.
 *
 * Airbnb's calendar endpoint has no documented rate limit — the CALENDAR_*
 * settings in `config.ts` are a conservative default, not a measured limit.
 */

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
  priceAmount: number | null;
}

export interface CalendarResult {
  roomId: string;
  nights: CalendarNight[];
  error: string | null;
}

/** `localPriceFormatted` is a display string like `"$269"`. Best-effort parse. */
export function parseFormattedPrice(formatted: string | null): number | null {
  if (!formatted) return null;
  const digits = [...formatted].filter((c) => (c >= '0' && c <= '9') || c === '.').join('');
  if (digits === '') return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Drop already-elapsed days from Airbnb's response.
 *
 * Airbnb's calendar always returns the *whole* current month starting on
 * the 1st, regardless of what day it actually is — so a scrape on the 15th
 * still gets calendarDate 1–14 back, marked `available: false` simply
 * because the past can't be booked, not because anyone booked it. Left
 * unfiltered, that reads as "100% occupied" for every day before the scrape
 * ran, which is a UI artifact, not an occupancy signal.
 */
export function toNights(days: readonly CalendarDay[], minDate: IsoDate): CalendarNight[] {
  return days
    .filter((day) => day.calendarDate >= minDate)
    .map((day) => ({
      nightDate: day.calendarDate,
      available: day.available,
      minNights: day.minNights,
      priceAmount: parseFormattedPrice(day.localPriceFormatted),
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
      // A `RateLimitedError` is not this listing's problem and must not be
      // swallowed into its row — it aborts the pass. Anything else costs
      // one listing's calendar and is recorded as such.
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
 * Every listing's calendar.
 *
 * `minDate` (normally the run's scrape date) drops elapsed days from each
 * result — see `toNights`. A `RateLimitedError` from any listing aborts the
 * whole pass; see `concurrency.ts` for why there is nothing to salvage.
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
