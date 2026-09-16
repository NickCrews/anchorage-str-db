/**
 * Price one bookable stay per listing, paced by `pace.ts`.
 *
 * Airbnb publishes no nightly price to an unauthenticated caller, only the
 * price of a specific stay. Each run asks for the listing's earliest stay
 * that its calendar says can be booked: check-in from tomorrow on, for its
 * minimum number of nights. The stored quote is the total and the number of
 * nights, e.g. $241 for 2; a nightly rate is left to analysis.
 */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import { addDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';

import { fetchPriceQuote, standardizePriceQuote } from './api/priceQuote.ts';
import type { CalendarResult } from './calendars.ts';
import { RETRY_BACKOFF_MS, withRetries } from './retry.ts';

/** Concurrency, attempts and timeout for price quotes. */
const QUOTE_CONCURRENCY = 6;
const QUOTE_MAX_RETRIES = 3;
const QUOTE_TIMEOUT_MS = 15_000;

export interface StayWindow {
  roomId: string;
  checkIn: IsoDate;
  nights: number;
}

export interface PriceQuote extends StayWindow {
  /** See `PriceQuoteResponse`. */
  label: string | null;
  total: number | null;
  breakdown: string[];
  error: string | null;
}

/**
 * The earliest stay the calendar says is bookable: a check-in night on or
 * after `firstCheckIn` open for check-in, its minimum stay of available
 * nights, and a check-out day open for check-out. Null if there is none in
 * the calendar, e.g. a fully booked listing.
 */
export function chooseStayWindow(calendar: CalendarResult, firstCheckIn: IsoDate): StayWindow | null {
  const byDate = new Map(calendar.nights.map((night) => [night.nightDate, night]));
  for (const night of calendar.nights) {
    if (night.nightDate < firstCheckIn || !night.available || !night.availableForCheckin) continue;
    const nights = Math.max(night.minNights ?? 1, 1);
    if (night.maxNights !== null && nights > night.maxNights) continue;
    let bookable = true;
    for (let i = 1; i < nights && bookable; i++) {
      bookable = byDate.get(addDays(night.nightDate, i))?.available === true;
    }
    if (!bookable) continue;
    const checkOut = byDate.get(addDays(night.nightDate, nights));
    if (checkOut && !checkOut.availableForCheckout) continue;
    return { roomId: calendar.roomId, checkIn: night.nightDate, nights };
  }
  return null;
}

/** One listing's quote. A per-listing failure is reported, not thrown. */
export type FetchOneQuote = (window: StayWindow) => Promise<PriceQuote>;

export function liveQuoteFetcher(apiKey: string): FetchOneQuote {
  return async (window) => {
    try {
      const response = await withRetries(
        async () =>
          standardizePriceQuote(
            await fetchPriceQuote({
              apiKey,
              roomId: window.roomId,
              checkIn: window.checkIn,
              checkOut: addDays(window.checkIn, window.nights),
              currency: 'USD',
              language: 'en',
              timeoutMs: QUOTE_TIMEOUT_MS,
            }),
          ),
        {
          label: `price quote for room ${window.roomId}`,
          attempts: QUOTE_MAX_RETRIES,
          backoffMs: RETRY_BACKOFF_MS,
        },
      );
      return { ...window, ...response, error: null };
    } catch (err) {
      // A rate limit is IP-wide, so it aborts the pass.
      if (err instanceof RateLimitedError) throw err;
      return { ...window, label: null, total: null, breakdown: [], error: describeError(rootCause(err)) };
    }
  };
}

export interface FetchQuotesOptions {
  /** The first check-in date to quote; the day after the scrape. */
  firstCheckIn: IsoDate;
  fetchOne: FetchOneQuote;
  concurrency?: number;
}

/** Quote every listing whose calendar was read and has a bookable stay. */
export async function fetchPriceQuotes(
  calendars: readonly CalendarResult[],
  options: FetchQuotesOptions,
): Promise<PriceQuote[]> {
  const windows = calendars
    .filter((calendar) => !calendar.error)
    .map((calendar) => chooseStayWindow(calendar, options.firstCheckIn))
    .filter((window): window is StayWindow => window !== null);
  const quotes = await mapWithConcurrency(
    windows,
    options.concurrency ?? QUOTE_CONCURRENCY,
    (window) => options.fetchOne(window),
  );
  for (const quote of quotes) {
    if (quote.error) log.warn(`price quote failed for room ${quote.roomId}: ${quote.error}`);
  }
  return quotes;
}
