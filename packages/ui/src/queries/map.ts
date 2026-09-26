/** The map's query: every active short-term rental we know of, as a point. */

import { airbnbListingObservations } from '@anchorage-str-db/db/schema';
import { qb } from '@anchorage-str-db/db/sql';
import {
  listingsActiveWithRegistration as activeListings,
  registrations,
  registrationsActive,
} from '@anchorage-str-db/db/viewSchema';
import { and, desc, eq, isNotNull, sql, type SQLWrapper } from 'drizzle-orm';

import { registrationStatusSql } from '../registrationStatus';

export const NOT_ON_AIRBNB = 'Registered, not on Airbnb';

/** Each listing's latest observation: the row of it with the newest scrape. */
const latest = qb
  .selectDistinctOn([airbnbListingObservations.listingId], {
    listingId: airbnbListingObservations.listingId,
    ratingValue: airbnbListingObservations.ratingValue,
    reviewCount: airbnbListingObservations.reviewCount,
    priceHintPerNight: airbnbListingObservations.priceHintPerNight,
  })
  .from(airbnbListingObservations)
  .orderBy(
    airbnbListingObservations.listingId,
    desc(airbnbListingObservations.scrapeDate),
  )
  .as('o');

/** A point for `@sqlrooms/deck`, which reads geometry as WKB. */
const wkbPoint = (lng: SQLWrapper, lat: SQLWrapper) =>
  sql<Uint8Array>`ST_AsWKB(ST_Point(${lng}, ${lat}))`;

/**
 * A listing's coordinate: the Muni's geocoding of the registration it cites when
 * there is one, otherwise Airbnb's pin.
 */
const listingLng = sql`coalesce(${registrations.geocodedLng}, ${activeListings.locationLng})`;
const listingLat = sql`coalesce(${registrations.geocodedLat}, ${activeListings.locationLat})`;

/**
 * Every active Airbnb listing. The keys are the column names the query
 * emits, which is what the map layers and the tooltip read it by.
 */
export const AIRBNB_RENTAL_FIELDS = {
  name: activeListings.name,
  bedrooms: activeListings.bedrooms,
  listing_type: activeListings.listingType,
  rating_value: latest.ratingValue,
  review_count: latest.reviewCount,
  price_hint_per_night: latest.priceHintPerNight,
  registration_status: registrationStatusSql(activeListings).as('registration_status'),
  registration_id: activeListings.registrationId,
  registration_address: activeListings.registrationAddress,
  location_source: sql<string>`CASE
      WHEN ${registrations.geocodedLat} IS NOT NULL THEN 'License address'
      WHEN ${activeListings.locationIsExact} THEN 'Exact Airbnb pin'
      ELSE 'Approximate Airbnb pin'
    END`.as('location_source'),
  // True for a geocoded license address or an exact Airbnb pin; false for an
  // Airbnb pin jittered by up to a few hundred meters, which is drawn as a ring.
  is_precise: sql<boolean>`${registrations.geocodedLat} IS NOT NULL
    OR coalesce(${activeListings.locationIsExact}, false)`.as('is_precise'),
  geometry: wkbPoint(listingLng, listingLat).as('geometry'),
};

const airbnbRentals = qb
  .select(AIRBNB_RENTAL_FIELDS)
  .from(activeListings)
  .leftJoin(
    registrations,
    and(
      eq(registrations.registrationId, activeListings.registrationId),
      isNotNull(registrations.geocodedLat),
      isNotNull(registrations.geocodedLng),
    ),
  )
  .leftJoin(latest, eq(latest.listingId, activeListings.listingId))
  .where(and(isNotNull(listingLng), isNotNull(listingLat)));

/** A column the Airbnb half has and a registration does not. */
const missing = <TValue,>(name: string) => sql<TValue | null>`NULL`.as(name);

/**
 * Every active Muni registration that no active Airbnb listing cites:
 * units listed elsewhere, such as VRBO, or not listed.
 *
 * `UNION ALL` takes its column names from the first half and lines the second
 * up with it by position, so this emits the same columns in the same order;
 * `satisfies` is what holds it to the same set of them.
 */
export const REGISTERED_ONLY_FIELDS = {
  name: registrationsActive.businessName,
  bedrooms: missing<string>('bedrooms'),
  listing_type: missing<string>('listing_type'),
  rating_value: missing<number>('rating_value'),
  review_count: missing<number>('review_count'),
  price_hint_per_night: missing<number>('price_hint_per_night'),
  registration_status: sql<string>`${NOT_ON_AIRBNB}`.as('registration_status'),
  registration_id: registrationsActive.registrationId,
  registration_address: registrationsActive.registeredAddress,
  location_source: sql<string>`'License address'`.as('location_source'),
  is_precise: sql<boolean>`true`.as('is_precise'),
  geometry: wkbPoint(
    registrationsActive.geocodedLng,
    registrationsActive.geocodedLat,
  ).as('geometry'),
} satisfies Record<keyof typeof AIRBNB_RENTAL_FIELDS, SQLWrapper>;

const registeredOnly = qb
  .select(REGISTERED_ONLY_FIELDS)
  .from(registrationsActive)
  .where(
    and(
      eq(registrationsActive.airbnbListingsActive, 0),
      isNotNull(registrationsActive.geocodedLat),
      isNotNull(registrationsActive.geocodedLng),
    ),
  );

/**
 * One coordinate per short-term rental we know of, as WKB geometry for
 * `@sqlrooms/deck` (needs the spatial extension loaded in `store.ts`).
 * Registrations the Muni's geocoder could not place are left out.
 *
 * The halves are joined here rather than with Drizzle's `unionAll`, which
 * takes only the selects of a connected database, not a `QueryBuilder`'s.
 */
export const RENTALS_QUERY = sql`${airbnbRentals} UNION ALL ${registeredOnly}`;
