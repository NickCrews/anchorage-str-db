/**
 * Airbnb's `PdpAvailabilityCalendarV2Query` endpoint: twelve months of
 * nightly availability for one listing.
 *
 * The response starts on the 1st of the current month and marks elapsed days
 * `available: false`. This module returns them unfiltered; `toNights` in
 * `../calendars.ts` drops them.
 *
 * Every day also has a `price.localPriceFormatted`, which is null for an
 * unauthenticated caller, so no price is read; `../priceQuotes.ts` prices a
 * stay instead. See `docs/research/airbnb-calendar-price.md`.
 */

import { requestJson } from './http.ts';

/** Persisted-query hash for `PdpAvailabilityCalendarV2Query`. Airbnb rotates it; 400s mean it changed. */
const OPERATION_ID = '4d4724885b57d91f65be3c50c8b792b92a0dc723a871affb6ee358a0caf6d694';

/** How many months forward to ask for. Airbnb's own picker asks for 12. */
const MONTHS = 12;

export interface CalendarDay {
  /** ISO `YYYY-MM-DD`. */
  calendarDate: string;
  available: boolean;
  /** Whether a stay may start or end on this day, which `available` alone doesn't say. */
  availableForCheckin: boolean;
  availableForCheckout: boolean;
  minNights: number | null;
  maxNights: number | null;
}

export interface FetchCalendarOptions {
  apiKey: string;
  listingId: string;
  currency: string;
  language: string;
  /** The month the window starts at. Defaults to the current UTC month. */
  from?: Date;
  timeoutMs?: number | undefined;
}

interface CalendarResponse {
  data?: {
    node?: {
      pdpAvailabilityCalendar?: {
        calendarMonths?: Array<{ days?: unknown[] }>;
      };
    };
  };
}

function toDay(raw: unknown): CalendarDay | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const day = raw as Record<string, unknown>;
  if (typeof day['calendarDate'] !== 'string') return null;
  return {
    calendarDate: day['calendarDate'],
    available: day['available'] === true,
    availableForCheckin: day['availableForCheckin'] === true,
    availableForCheckout: day['availableForCheckout'] === true,
    minNights: typeof day['minNights'] === 'number' ? day['minNights'] : null,
    maxNights: typeof day['maxNights'] === 'number' ? day['maxNights'] : null,
  };
}

/** Every day Airbnb returned, flattened across the twelve months. */
export async function fetchCalendar(options: FetchCalendarOptions): Promise<CalendarDay[]> {
  const from = options.from ?? new Date();
  const query = new URLSearchParams({
    operationName: 'PdpAvailabilityCalendarV2Query',
    locale: options.language,
    currency: options.currency,
    variables: JSON.stringify({
      // A GraphQL id: base64 of `DemandStayListing:<listing id>`.
      listingId: Buffer.from(`DemandStayListing:${options.listingId}`).toString('base64'),
      input: {
        count: MONTHS,
        month: from.getUTCMonth() + 1,
        year: from.getUTCFullYear(),
        // A hotel room listing would otherwise get its whole property's calendar.
        returnPropertyLevelCalendarIfApplicable: false,
      },
    }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: OPERATION_ID },
    }),
  });

  const data = await requestJson<CalendarResponse>(
    `https://www.airbnb.com/api/v3/PdpAvailabilityCalendarV2Query/${OPERATION_ID}?${query}`,
    {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': options.language,
        'X-Airbnb-Api-Key': options.apiKey,
      },
      timeoutMs: options.timeoutMs,
    },
  );

  const months = data.data?.node?.pdpAvailabilityCalendar?.calendarMonths ?? [];
  return months
    .flatMap((month) => month.days ?? [])
    .map(toDay)
    .filter((day): day is CalendarDay => day !== null);
}
