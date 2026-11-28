/**
 * The network phase of the Airbnb scrape, over airbnb-dlp: which listings to
 * ask for, which stay to price, and how a pass's results become what
 * `store.ts` writes.
 *
 * A pass that airbnb-dlp ends early (Airbnb blocked the client) throws, which
 * aborts the run. Any other failure is per listing and is counted, not thrown.
 */

import {
  bookableStays,
  type AirbnbError,
  type BBox,
  type Calendar,
  type Client,
  type Listing,
  type ListingId,
  type RoomType,
  type Outcome,
  type PriceQuote,
  type Result,
  type SearchListing,
  type Stay,
} from 'airbnb-dlp';
import { isBuildingType, type BuildingType, type ListingType } from '@anchorage-str-db/utils/airbnbValues';
import { epochDays, type IsoDate } from '@anchorage-str-db/utils/dates';
import { inMunicipality, MUNICIPALITY_BOUNDING_BOX } from '@anchorage-str-db/utils/muni_geography';
import { log } from '@anchorage-str-db/utils/log';

/**
 * Milliseconds in a run during which listings' earliest reviews are read.
 * Keeps the pass within the Airbnb workflow's timeout; listings not reached
 * wait for a later run.
 */
export const FIRST_REVIEW_BUDGET_MS = 15 * 60_000;

const MUNICIPALITY_BBOX: BBox = {
  south: MUNICIPALITY_BOUNDING_BOX.swLat,
  west: MUNICIPALITY_BOUNDING_BOX.swLng,
  north: MUNICIPALITY_BOUNDING_BOX.neLat,
  east: MUNICIPALITY_BOUNDING_BOX.neLng,
};

/** Throws the error that ended the call early, if any. */
function throwIfEnded<I>(product: string, outcome: Outcome<I>): void {
  if (outcome.error) {
    throw new Error(`Airbnb ${product} ended early: ${outcome.error.category}: ${outcome.error.message}`, {
      cause: outcome.error,
    });
  }
}

function warnFailures<I>(product: string, failures: ReadonlyArray<{ input: I; error: AirbnbError }>): void {
  for (const { input, error } of failures) {
    log.warn(`${product} failed for ${JSON.stringify(input)}: ${error.category}: ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// search

export interface SearchPass {
  /** One per listing id, inside the Municipality or without coordinates. */
  listings: SearchListing[];
  /** Distinct listings search returned, inside the Municipality or not. */
  found: number;
  /** Parts of the area search could not cover completely. */
  incomplete: number;
  requests: number;
}

/**
 * Every listing in `box`, by default the bounding box of the Municipality's
 * boundary, which is padded by 1 km. The box also takes in Hope, Palmer and
 * Wasilla, so only listings inside the boundary itself are kept. A listing
 * with no coordinates is kept, and `coords_within_municipality` reports it.
 */
export async function searchMunicipality(client: Client, box: BBox = MUNICIPALITY_BBOX): Promise<SearchPass> {
  const { items, outcome } = await client.search([{ area: { bbox: box } }]).all();
  throwIfEnded('search', outcome);
  const byId = new Map<ListingId, SearchListing>();
  for (const hit of items) byId.set(hit.listing.id, hit.listing);
  const listings = [...byId.values()].filter(
    ({ location }) => location === null || inMunicipality(location.lat, location.lng),
  );
  return { listings, found: byId.size, incomplete: outcome.incomplete.length, requests: outcome.requests };
}

// --------------------------------------------------------------------------
// listing pages

export interface PagePass {
  attempted: number;
  pages: Map<ListingId, Listing>;
}

export async function fetchListingPages(client: Client, ids: readonly ListingId[]): Promise<PagePass> {
  const { items, outcome } = await client.listings(ids).all();
  throwIfEnded('listings', outcome);
  return { attempted: ids.length, pages: okValues(items, 'listing page') };
}

/**
 * airbnb-dlp's room types are stored as `listing_type` unchanged, so the two
 * sets must be the same: this fails to compile when either gains a value.
 */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ROOM_TYPES_ARE_LISTING_TYPES: SameSet<RoomType, ListingType> = true;
void ROOM_TYPES_ARE_LISTING_TYPES;

/** The page's building type, or null, with a warning, for one outside `BUILDING_TYPES`. */
export function buildingType(page: Listing): BuildingType | null {
  const value = page.propertyType;
  if (value === null || isBuildingType(value)) return value;
  log.warn(`listing ${page.id}: building type ${value} is not in BUILDING_TYPES; storing NULL`);
  return null;
}

const STR_NUMBER_RE = /\bSTR[\s-]?(\d{6,})\b/i;

/**
 * The Municipality's STR registration number in the host's "Registration
 * Details" text, as `STR` and its digits: hosts write `STR 123456`,
 * `str-123456` and so on. Null when the text names none.
 */
export function registrationId(text: string | null): string | null {
  const match = text === null ? null : STR_NUMBER_RE.exec(text);
  return match ? `STR${match[1]}` : null;
}

function okValues<I, T>(items: ReadonlyArray<Result<I, T>>, product: string): Map<I, T> {
  const values = new Map<I, T>();
  const failures: Array<{ input: I; error: AirbnbError }> = [];
  for (const item of items) {
    if (item.ok) values.set(item.input, item.value);
    else failures.push(item);
  }
  warnFailures(product, failures);
  return values;
}

// --------------------------------------------------------------------------
// hosts

/** The host's profile card, as one listing page showed it. */
export interface HostCard {
  /** A first name or a business name. Airbnb shows no surnames. */
  name: string | null;
  about: string | null;
  /**
   * Airbnb's `timeAsHost` as of the day the page was read. The "Years
   * hosting" badge beside it is rounded (9 years 7 months shows as 10), so
   * it is not used.
   */
  timeAsHostYears: number | null;
  timeAsHostMonths: number | null;
}

/**
 * One card per distinct host, from a run's listing pages. A page with a host
 * id but no card counts as no reading. A host with twelve listings was read
 * twelve times; if the readings differ (a profile edited mid-run, or
 * `timeAsHost` crossing a month), the lowest listing id's reading wins, so a
 * re-run records the same thing.
 */
export function collectHostCards(pages: ReadonlyMap<ListingId, Listing>): Map<string, HostCard> {
  const readings = new Map<string, Array<{ listingId: bigint; card: HostCard }>>();
  for (const [listingId, page] of pages) {
    const host = page.host;
    if (host === null || (host.name === null && host.timeAsHost === null)) continue;
    const card: HostCard = {
      name: host.name,
      about: host.about,
      timeAsHostYears: host.timeAsHost?.years ?? null,
      timeAsHostMonths: host.timeAsHost?.months ?? null,
    };
    const list = readings.get(host.id) ?? [];
    list.push({ listingId: BigInt(listingId), card });
    readings.set(host.id, list);
  }
  const cards = new Map<string, HostCard>();
  for (const [hostId, seen] of readings) {
    seen.sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0));
    if (new Set(seen.map(({ card }) => JSON.stringify(card))).size > 1) {
      log.warn(
        `host ${hostId}: ${seen.length} listing pages disagree about the host card; ` +
          `keeping listing ${seen[0]!.listingId}'s`,
      );
    }
    cards.set(hostId, seen[0]!.card);
  }
  return cards;
}

// --------------------------------------------------------------------------
// calendars

/** One night as stored. */
export interface CalendarNight {
  nightDate: IsoDate;
  available: boolean;
  minNights: number | null;
}

export interface CalendarPass {
  attempted: number;
  calendars: Map<ListingId, Calendar>;
}

export async function fetchCalendars(client: Client, ids: readonly ListingId[]): Promise<CalendarPass> {
  const { items, outcome } = await client.calendars(ids).all();
  throwIfEnded('calendars', outcome);
  return { attempted: ids.length, calendars: okValues(items, 'calendar') };
}

/**
 * The calendar's nights from `minDate` on. Airbnb returns the whole current
 * month and marks elapsed days unavailable, which would otherwise read as
 * booked.
 */
export function nightsFrom(calendar: Calendar, minDate: IsoDate): CalendarNight[] {
  return calendar.days
    .filter((day) => day.date >= minDate)
    .map((day) => ({ nightDate: day.date, available: day.available, minNights: day.minNights }));
}

// --------------------------------------------------------------------------
// price quotes

/** The quote for a listing's earliest bookable stay. */
export interface StayQuote {
  stay: Stay;
  /** Null when Airbnb would not quote the stay. */
  quote: PriceQuote | null;
}

export interface QuotePass {
  /** Listings with a bookable stay to quote. */
  attempted: number;
  /** Listings whose quote was read, priced or not. */
  quotes: Map<ListingId, StayQuote>;
}

/**
 * Quote each listing's earliest stay the calendar shows as bookable with
 * check-in on or after `firstCheckIn`. A listing with no such stay, e.g. one
 * fully booked, is not quoted.
 */
export async function fetchPriceQuotes(
  client: Client,
  calendars: ReadonlyMap<ListingId, Calendar>,
  firstCheckIn: IsoDate,
): Promise<QuotePass> {
  const stays: Stay[] = [];
  for (const calendar of calendars.values()) {
    for (const stay of bookableStays(calendar, firstCheckIn)) {
      stays.push(stay);
      break;
    }
  }
  const { items, outcome } = await client.priceQuotes(stays).all();
  throwIfEnded('priceQuotes', outcome);
  const quotes = new Map<ListingId, StayQuote>();
  const failures: Array<{ input: Stay; error: AirbnbError }> = [];
  for (const item of items) {
    if (item.ok) quotes.set(item.input.id, { stay: item.input, quote: item.value });
    else if (item.error.category === 'StayUnavailable') quotes.set(item.input.id, { stay: item.input, quote: null });
    else failures.push(item);
  }
  warnFailures('price quote', failures);
  return { attempted: stays.length, quotes };
}

export function stayNights(stay: Stay): number {
  return epochDays(stay.checkOut) - epochDays(stay.checkIn);
}

// --------------------------------------------------------------------------
// first reviews

/** A listing's oldest review date; null when it has no reviews. */
export interface FirstReview {
  listingId: ListingId;
  firstReviewDate: IsoDate | null;
}

export interface FirstReviewPass {
  /** Listings whose reviews were requested within the budget. */
  attempted: number;
  /** Of those, how many failed. */
  failed: number;
  resolved: FirstReview[];
}

/**
 * Read every review of each listing in `ids`, in order, until
 * `FIRST_REVIEW_BUDGET_MS` is spent. A listing's first review never changes
 * once it exists, so `pendingFirstReviews` in `store.ts` gives only listings
 * not resolved before, and each listing is read once.
 */
export async function fetchFirstReviews(
  client: Client,
  ids: readonly ListingId[],
  budgetMs: number = FIRST_REVIEW_BUDGET_MS,
): Promise<FirstReviewPass> {
  const { items, outcome } = await client.reviews(ids, { maxDurationMs: budgetMs }).all();
  throwIfEnded('reviews', outcome);
  const resolved: FirstReview[] = [];
  const failures: Array<{ input: ListingId; error: AirbnbError }> = [];
  let notAttempted = 0;
  for (const item of items) {
    if (item.ok) {
      const dates = item.value.reviews.map((review) => review.createdAt.slice(0, 10));
      const firstReviewDate = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
      resolved.push({ listingId: item.input, firstReviewDate });
    } else if (item.error.category === 'BudgetExhausted') {
      notAttempted++;
    } else {
      failures.push(item);
    }
  }
  warnFailures('reviews', failures);
  return { attempted: ids.length - notAttempted, failed: failures.length, resolved };
}
