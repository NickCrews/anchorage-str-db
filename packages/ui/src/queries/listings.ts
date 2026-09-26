/** The listings table's query: every active listing with its host, registration and latest price. */

import { airbnbListingObservations } from '@anchorage-str-db/db/schema';
import { qb } from '@anchorage-str-db/db/sql';
import {
  listingPhotosCurrent,
  listingsActiveWithHost as withHost,
  listingsActiveWithRegistration as withRegistration,
} from '@anchorage-str-db/db/viewSchema';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import { registrationStatusSql, type RegistrationStatus } from '../registrationStatus';

/** Each listing's latest observation: the row of it with the newest scrape. */
const latest = qb
  .selectDistinctOn([airbnbListingObservations.listingId], {
    listingId: airbnbListingObservations.listingId,
    ratingValue: airbnbListingObservations.ratingValue,
    reviewCount: airbnbListingObservations.reviewCount,
    quoteTotal: airbnbListingObservations.quoteTotal,
    quoteNights: airbnbListingObservations.quoteNights,
    quoteCheckIn: airbnbListingObservations.quoteCheckIn,
    priceHintPerNight: airbnbListingObservations.priceHintPerNight,
  })
  .from(airbnbListingObservations)
  .orderBy(
    airbnbListingObservations.listingId,
    desc(airbnbListingObservations.scrapeDate),
  )
  .as('o');

/**
 * Photos come from `listing_photos_current`, not `listings`: they are stored
 * outside the listing versions, so the current set is the latest one written.
 * `photo_urls[1]` is the cover photo (DuckDB lists are 1-based).
 *
 * The registration columns come from the Muni registration matching the
 * number the listing page shows; see `listings_active_with_registration`.
 */
export const LISTING_FIELDS = {
  photo: sql<string>`${listingPhotosCurrent.photoUrls}[1]`.as('photo'),
  listing_id: withHost.listingId,
  name: withHost.name,
  property_title: withHost.propertyTitle,
  listing_type: withHost.listingType,
  bedrooms: withHost.bedrooms,
  beds: withHost.beds,
  bathrooms: withHost.bathrooms,
  guest_capacity: withHost.guestCapacity,
  rating_value: latest.ratingValue,
  review_count: latest.reviewCount,
  quote_total: latest.quoteTotal,
  quote_nights: latest.quoteNights,
  quote_check_in: latest.quoteCheckIn,
  price_hint_per_night: latest.priceHintPerNight,
  host_name: withHost.hostName,
  host_years_hosting: withHost.hostYearsHosting,
  host_listings_active: withHost.hostListingsActive,
  host_listings_ever_seen: withHost.hostListingsEverSeen,
  registration_status: registrationStatusSql(withRegistration).as('registration_status'),
  registration_id: withHost.registrationId,
  registration_address: withRegistration.registrationAddress,
  registration_parcel_id: withRegistration.registrationParcelId,
  registration_parcel_type: withRegistration.registrationParcelType,
  registration_community_council: withRegistration.registrationCommunityCouncil,
  registration_business_name: withRegistration.registrationBusinessName,
  registration_expires_date: withRegistration.registrationExpiresDate,
  first_available_date_est: withHost.firstAvailableDateEst,
  first_review_date: withHost.firstReviewDate,
  first_seen_date: withHost.firstSeenDate,
  last_seen_date: withHost.lastSeenDate,
  url: withHost.url,
};

/** The table, before the search box's and the status toggle's filters. */
const listingsQuery = (where: SQL | undefined) =>
  qb
    .select(LISTING_FIELDS)
    .from(withHost)
    .innerJoin(withRegistration, eq(withRegistration.listingId, withHost.listingId))
    .leftJoin(
      listingPhotosCurrent,
      eq(listingPhotosCurrent.listingId, withHost.listingId),
    )
    .leftJoin(latest, eq(latest.listingId, withHost.listingId))
    .where(where)
    .orderBy(desc(withHost.lastSeenDate));

export const ALL_STATUSES = 'All';

/** The table as shown: the search box's `search` and the status toggle's `status`. */
export const listingsTableQuery = (
  search: string,
  status: RegistrationStatus | typeof ALL_STATUSES,
) => {
  const term = search.trim();
  const pattern = `%${term}%`;
  return listingsQuery(
    and(
      term
        ? or(
            ilike(withHost.name, pattern),
            ilike(withHost.propertyTitle, pattern),
            ilike(withHost.hostName, pattern),
            ilike(withHost.registrationId, pattern),
            ilike(withRegistration.registrationAddress, pattern),
          )
        : undefined,
      status === ALL_STATUSES ? undefined : eq(registrationStatusSql(withRegistration), status),
    ),
  );
};
