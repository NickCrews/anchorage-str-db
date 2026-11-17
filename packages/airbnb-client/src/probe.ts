/**
 * Call each Airbnb endpoint the scrape uses once, for a few live listings,
 * and say which one broke and how.
 *
 * A full scrape fails an hour in with a failure-rate check; this fails in
 * under a minute with the endpoint and the kind of change:
 *
 * - `query-changed`: HTTP 400. Airbnb no longer recognizes the persisted-query
 *   id, so the query's text changed. `pnpm airbnb:capture` reads the current
 *   ids from a real browser.
 * - `variables-changed`: the response has GraphQL errors, so the query
 *   accepted the id but not the variables the client sends.
 * - `response-changed`: the request succeeded but a field the scrape reads is
 *   missing or empty on every listing tried. The id is unchanged, so only a
 *   check on the response catches this.
 * - `blocked`: HTTP 403 or 429. Akamai or the rate limiter refused the
 *   request; not an API change.
 * - `other`: anything else, e.g. a timeout or a 5xx.
 */

import { addDays, todayUtc } from '@anchorage-str-db/utils/dates';

import { fetchApiKey } from './api/apiKey.ts';
import { fetchCalendar, type CalendarDay } from './api/calendar.ts';
import { HttpError, request } from './api/http.ts';
import { fetchPriceQuote, standardizePriceQuote } from './api/priceQuote.ts';
import { fetchReviewPage } from './api/reviews.ts';
import { fetchSearchPage, standardizeSearchResponse, type BoundingBox } from './api/search.ts';
import { toNights } from './calendars.ts';
import { PAGE_HEADERS, parseListingPage, type ListingPage } from './listingPage.ts';
import { chooseStayWindow } from './priceQuotes.ts';

export const ENDPOINTS = ['apiKey', 'search', 'listingPage', 'calendar', 'priceQuote', 'reviews'] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

export type Problem = 'query-changed' | 'variables-changed' | 'response-changed' | 'blocked' | 'other';

export interface ProbeResult {
  endpoint: Endpoint;
  /** Null when the endpoint works. */
  problem: Problem | null;
  /** What was checked, or what went wrong. */
  detail: string;
}

/** Downtown Anchorage: dense enough to return a full page of listings. */
const PROBE_BOX: BoundingBox = { swLat: 61.19, swLng: -149.92, neLat: 61.23, neLng: -149.85 };

/** Listings tried per endpoint before a missing field counts as a change. */
const LISTINGS_TRIED = 3;

/**
 * Fields every listing page yields (see `MIN_PAGE_FIELD_SHARE` in the
 * scraper's checks). One missing on every listing tried means the page changed.
 */
const PAGE_FIELDS = ['lat', 'lng', 'locationIsExact', 'hostId', 'listingType', 'guestCapacity', 'photoUrls'] as const;

/** A calendar covers twelve months; fewer days than this means it was cut short. */
const MIN_CALENDAR_DAYS = 330;

/** A failure's kind, from the thrown error. */
export function classify(err: unknown): Problem {
  if (err instanceof HttpError) {
    if (err.status === 400) return 'query-changed';
    if (err.status === 403 || err.status === 429) return 'blocked';
    return 'other';
  }
  if (err instanceof ProbeError) return err.problem;
  // The messages `standardizePriceQuote` and `toReviewPage` throw.
  if (err instanceof Error && /returned errors|has errors/.test(err.message)) return 'variables-changed';
  if (err instanceof Error && /\bhas no\b/.test(err.message)) return 'response-changed';
  return 'other';
}

class ProbeError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem, message: string) {
    super(message);
    this.name = 'ProbeError';
    this.problem = problem;
  }
}

function failure(endpoint: Endpoint, err: unknown): ProbeResult {
  const message =
    err instanceof HttpError
      ? `HTTP ${err.status} from ${new URL(err.url).pathname}: ${err.body.startsWith('<') ? '(an HTML error page)' : err.body}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { endpoint, problem: classify(err), detail: message.slice(0, 500) };
}

/** The `PAGE_FIELDS` that are empty on every page. */
export function fieldsMissingOnAll(pages: readonly ListingPage[]): string[] {
  return PAGE_FIELDS.filter((field) =>
    pages.every((page) => {
      const value = page[field];
      return value === null || (Array.isArray(value) && value.length === 0);
    }),
  );
}

/** What is wrong with one listing's calendar, or null if nothing. */
export function calendarProblem(days: readonly CalendarDay[]): string | null {
  if (days.length < MIN_CALENDAR_DAYS) return `${days.length} days, expected at least ${MIN_CALENDAR_DAYS}`;
  if (days.every((day) => day.minNights === null)) return 'no day has minNights';
  if (!days.some((day) => day.available)) return 'no day is available';
  return null;
}

/**
 * Run `attempt` on up to `LISTINGS_TRIED` listings. Returns the first success.
 * If every listing fails with a `response-changed` kind of problem, that is
 * the result; any other failure is returned at once, since it is not specific
 * to the listing.
 */
async function firstListing<T>(
  listingIds: readonly string[],
  attempt: (listingId: string) => Promise<T>,
): Promise<{ listingId: string; value: T }> {
  let last: unknown;
  for (const listingId of listingIds.slice(0, LISTINGS_TRIED)) {
    try {
      return { listingId, value: await attempt(listingId) };
    } catch (err) {
      if (classify(err) !== 'response-changed') throw err;
      last = err;
    }
  }
  throw last ?? new ProbeError('other', 'no listing to try');
}

/** Probe every endpoint. Endpoints that need a listing are skipped if search fails. */
export async function probeAirbnb(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const opts = { currency: 'USD', language: 'en' };

  let apiKey: string;
  try {
    apiKey = await fetchApiKey();
    results.push({ endpoint: 'apiKey', problem: null, detail: 'read from the homepage' });
  } catch (err) {
    return [failure('apiKey', err)];
  }

  let listingIds: string[];
  let reviewedIds: string[];
  try {
    const { listings } = standardizeSearchResponse(
      await fetchSearchPage({ apiKey, box: PROBE_BOX, zoom: 11, ...opts }),
    );
    if (listings.length === 0) throw new ProbeError('response-changed', 'search returned no listings');
    const located = listings.filter((listing) => listing.latitude !== null && listing.longitude !== null);
    if (located.length === 0) throw new ProbeError('response-changed', 'no search result has a coordinate');
    if (listings.every((listing) => listing.priceAmount === null)) {
      throw new ProbeError('response-changed', 'no search result has a price');
    }
    listingIds = located.map((listing) => String(listing.listingId));
    reviewedIds = located.filter((listing) => (listing.reviewCount ?? 0) > 0).map((l) => String(l.listingId));
    results.push({ endpoint: 'search', problem: null, detail: `${listings.length} listings` });
  } catch (err) {
    results.push(failure('search', err));
    return results;
  }

  const pages: ListingPage[] = [];
  try {
    for (const listingId of listingIds.slice(0, LISTINGS_TRIED)) {
      const html = await request(`https://www.airbnb.com/rooms/${listingId}`, { headers: PAGE_HEADERS });
      pages.push(parseListingPage(html, listingId));
    }
    const missing = fieldsMissingOnAll(pages);
    if (missing.length > 0) {
      throw new ProbeError('response-changed', `no page yielded ${missing.join(', ')}`);
    }
    results.push({ endpoint: 'listingPage', problem: null, detail: `${pages.length} pages parsed` });
  } catch (err) {
    results.push(failure('listingPage', err));
  }

  const firstCheckIn = addDays(todayUtc(), 1);
  let window: { listingId: string; checkIn: string; nights: number } | null = null;
  try {
    const { listingId, value: days } = await firstListing(listingIds, async (id) => {
      const days = await fetchCalendar({ apiKey, listingId: id, ...opts });
      const problem = calendarProblem(days);
      if (problem !== null) throw new ProbeError('response-changed', `calendar for ${id}: ${problem}`);
      return days;
    });
    results.push({ endpoint: 'calendar', problem: null, detail: `${days.length} days for listing ${listingId}` });
    // A bookable stay on some listing tried, for the price quote.
    for (const id of listingIds.slice(0, LISTINGS_TRIED)) {
      const calendarDays = id === listingId ? days : await fetchCalendar({ apiKey, listingId: id, ...opts });
      window = chooseStayWindow({ listingId: id, nights: toNights(calendarDays, firstCheckIn), error: null }, firstCheckIn);
      if (window !== null) break;
    }
  } catch (err) {
    results.push(failure('calendar', err));
  }

  if (window !== null) {
    const stay = window;
    try {
      const quote = standardizePriceQuote(
        await fetchPriceQuote({
          apiKey,
          listingId: stay.listingId,
          checkIn: stay.checkIn,
          checkOut: addDays(stay.checkIn, stay.nights),
          ...opts,
        }),
      );
      if (quote.total === null) {
        throw new ProbeError('response-changed', `no total for listing ${stay.listingId}: ${quote.label ?? 'no label'}`);
      }
      results.push({ endpoint: 'priceQuote', problem: null, detail: `$${quote.total} for listing ${stay.listingId}` });
    } catch (err) {
      results.push(failure('priceQuote', err));
    }
  } else if (results.some((result) => result.endpoint === 'calendar' && result.problem === null)) {
    results.push({
      endpoint: 'priceQuote',
      problem: 'other',
      detail: `no bookable stay on the first ${LISTINGS_TRIED} listings' calendars to quote`,
    });
  }

  try {
    const { listingId, value: page } = await firstListing(reviewedIds, async (id) => {
      const page = await fetchReviewPage({ apiKey, listingId: id, offset: 0, limit: 5, ...opts });
      if (page.totalCount === 0 || page.createdAt.length === 0) {
        throw new ProbeError('response-changed', `listing ${id} has reviews in search but none from the reviews query`);
      }
      return page;
    });
    results.push({ endpoint: 'reviews', problem: null, detail: `${page.totalCount} reviews for listing ${listingId}` });
  } catch (err) {
    results.push(failure('reviews', err));
  }

  return results;
}
