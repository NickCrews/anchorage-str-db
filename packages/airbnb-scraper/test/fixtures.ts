/** Builders for airbnb-dlp results, in the shapes `store.ts` takes. */

import type { Calendar, CalendarDay, Listing, ListingId, PriceQuote, RoomType, SearchListing } from 'airbnb-dlp';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

import type { HostCard, StayQuote } from '../src/airbnb.ts';

export interface MakeListingOptions {
  lat?: number;
  badges?: string[];
}

export function makeListing(
  id: number | bigint,
  name: string,
  options: MakeListingOptions = {},
): SearchListing {
  return {
    id: String(id),
    name,
    title: null,
    location: { lat: options.lat ?? 60.95, lng: -149.1 },
    rating: 4.9,
    reviewCount: 10,
    badges: options.badges ?? [],
    price: {
      total: { amount: 750, currency: 'USD' },
      nights: 5,
      nightly: { amount: 150, currency: 'USD' },
    },
  };
}

/** The listing-page fields the tests set. A page with `error` was not read. */
export interface TestPage {
  listingId: string;
  error?: string;
  locationIsExact?: boolean | null;
  locationSubtitle?: string | null;
  locationVerified?: boolean | null;
  locationExactAddress?: string | null;
  /** The "Registration Details" text. */
  registration?: string | null;
  hostId?: string | null;
  /** Null: the page names its host but shows no card. */
  hostCard?: HostCard | null;
  listingType?: RoomType | null;
  /** Airbnb's propertyType. */
  buildingType?: string | null;
  guestCapacity?: number | null;
  beds?: number | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  photoUrls?: string[];
}

export function page(listingId: string, fields: Omit<TestPage, 'listingId'> = {}): TestPage {
  return { listingId, ...fields };
}

function toListing(p: TestPage): Listing {
  const hostId = p.hostId ?? null;
  const card = p.hostCard ?? null;
  return {
    id: p.listingId,
    location:
      p.locationIsExact === undefined && p.locationSubtitle === undefined && p.locationVerified === undefined
        ? null
        : {
            lat: 61.2,
            lng: -149.9,
            exact: p.locationIsExact ?? null,
            subtitle: p.locationSubtitle ?? null,
            verified: p.locationVerified ?? null,
          },
    address: p.locationExactAddress ?? null,
    roomType: p.listingType ?? null,
    roomTypeText: null,
    propertyType: p.buildingType ?? null,
    guestCapacity: p.guestCapacity ?? null,
    beds: p.beds ?? null,
    bedrooms: p.bedrooms == null ? null : { count: null, text: p.bedrooms },
    bathrooms: p.bathrooms == null ? null : { count: null, access: null, text: p.bathrooms },
    registration: p.registration ?? null,
    host:
      hostId === null
        ? null
        : {
            id: hostId,
            name: card?.name ?? null,
            about: card?.about ?? null,
            timeAsHost:
              card && card.timeAsHostYears !== null && card.timeAsHostMonths !== null
                ? { years: card.timeAsHostYears, months: card.timeAsHostMonths }
                : null,
          },
    photoUrls: p.photoUrls ?? [],
  };
}

/** The pages that were read, as `fetchListingPages` returns them. */
export function pageMap(pages: readonly TestPage[]): Map<ListingId, Listing> {
  return new Map(pages.filter((p) => p.error === undefined).map((p) => [p.listingId, toListing(p)]));
}

export interface TestQuote {
  listingId: string;
  checkIn?: IsoDate;
  checkOut?: IsoDate;
  /** Null: Airbnb would not quote the stay. */
  quote?: PriceQuote | null;
}

export function quote(listingId: string, fields: Omit<TestQuote, 'listingId'> = {}): TestQuote {
  return { listingId, ...fields };
}

export function quoteMap(quotes: readonly TestQuote[]): Map<ListingId, StayQuote> {
  return new Map(
    quotes.map((q) => [
      q.listingId,
      {
        stay: { id: q.listingId, checkIn: q.checkIn ?? '2026-09-01', checkOut: q.checkOut ?? '2026-09-03' },
        quote:
          q.quote === undefined
            ? { total: { amount: 241, currency: 'USD' }, breakdown: ['2 nights x $120.50: $241.00'] }
            : q.quote,
      },
    ]),
  );
}

export function night(date: IsoDate, available: boolean, minNights: number | null): CalendarDay {
  return { date, available, checkInAllowed: available, checkOutAllowed: true, minNights, maxNights: null };
}

/** A calendar that was read. */
export function calendar(id: string, days: CalendarDay[]): Calendar {
  return { id, days };
}

export function calendarMap(calendars: readonly Calendar[]): Map<ListingId, Calendar> {
  return new Map(calendars.map((c) => [c.id, c]));
}
