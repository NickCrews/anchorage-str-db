/**
 * Airbnb's `PdpAvailabilityCalendar` endpoint: twelve months of nightly
 * availability for one listing, as the listing page's date picker sees it.
 *
 * The response always starts at the 1st of the *current* month regardless
 * of today's date, and marks every elapsed day `available: false` simply
 * because the past cannot be booked. Filtering those is the caller's job
 * (see `minDate` in the scraper's `calendars.ts`) — this module reports
 * what Airbnb said.
 */

import { requestJson } from './http.ts';

const OPERATION_ID = '8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade';

/** How many months forward to ask for. Airbnb's own picker asks for 12. */
const MONTHS = 12;

export interface CalendarDay {
  /** ISO `YYYY-MM-DD`. */
  calendarDate: string;
  available: boolean;
  minNights: number | null;
  /** A display string like `"$269"`, or null on days Airbnb prices nothing. */
  localPriceFormatted: string | null;
}

export interface FetchCalendarOptions {
  apiKey: string;
  roomId: string;
  currency: string;
  language: string;
  /** The month the window starts at. Defaults to the current UTC month. */
  from?: Date;
  timeoutMs?: number | undefined;
}

interface CalendarResponse {
  data?: {
    merlin?: {
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
  const price = day['price'];
  const formatted =
    typeof price === 'object' && price !== null
      ? (price as Record<string, unknown>)['localPriceFormatted']
      : null;
  return {
    calendarDate: day['calendarDate'],
    available: day['available'] === true,
    minNights: typeof day['minNights'] === 'number' ? day['minNights'] : null,
    localPriceFormatted: typeof formatted === 'string' ? formatted : null,
  };
}

/** Every day Airbnb returned, flattened across the twelve months. */
export async function fetchCalendar(options: FetchCalendarOptions): Promise<CalendarDay[]> {
  const from = options.from ?? new Date();
  const query = new URLSearchParams({
    operationName: 'PdpAvailabilityCalendar',
    locale: options.language,
    currency: options.currency,
    variables: JSON.stringify({
      request: {
        count: MONTHS,
        listingId: options.roomId,
        month: from.getUTCMonth() + 1,
        year: from.getUTCFullYear(),
      },
    }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: OPERATION_ID },
    }),
  });

  const data = await requestJson<CalendarResponse>(
    `https://www.airbnb.com/api/v3/PdpAvailabilityCalendar/${OPERATION_ID}/?${query}`,
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

  const months = data.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths ?? [];
  return months
    .flatMap((month) => month.days ?? [])
    .map(toDay)
    .filter((day): day is CalendarDay => day !== null);
}
