/** The registration card's queries: how listings' registration ids match the registry. */

import { qb } from '@anchorage-str-db/db/sql';
import {
  latestRegistryDate,
  listingsActiveWithRegistration,
  registrationsActive,
} from '@anchorage-str-db/db/viewSchema';
import { asc, desc, eq, sql } from 'drizzle-orm';

import { registrationStatusSql, type RegistrationStatus } from '../registrationStatus';

export const COUNCILS_SHOWN = 15;

/** Every active listing with how its registration id matched. */
const listingsWithStatus = qb
  .select({
    listingType: listingsActiveWithRegistration.listingType,
    status: registrationStatusSql(listingsActiveWithRegistration).as('status'),
  })
  .from(listingsActiveWithRegistration)
  .as('listings');

/** `status` is the subquery's own column, so both queries below count it. */
const listingsWith = (status: RegistrationStatus) =>
  sql<number>`count(*) FILTER (WHERE ${listingsWithStatus.status} = ${status})::INT`;

const STATUS_COUNTS = {
  registered: listingsWith('Registered').as('registered'),
  lapsed: listingsWith('Registration lapsed').as('lapsed'),
  notInRegistry: listingsWith('Id not in registry').as('notInRegistry'),
  noId: listingsWith('No id shown').as('noId'),
};

const registrations = qb
  .select({ registrations: sql<number>`count(*)::INT`.as('registrations') })
  .from(registrationsActive);

const registrationsWithoutListing = qb
  .select({
    registrationsWithoutListing: sql<number>`count(*)::INT`.as(
      'registrationsWithoutListing',
    ),
  })
  .from(registrationsActive)
  .where(eq(registrationsActive.airbnbListingsActive, 0));

const registryDate = qb
  .select({ registryDate: sql<number | null>`${latestRegistryDate.scrapeDate}`.as('registryDate') })
  .from(latestRegistryDate);

export const SUMMARY_FIELDS = {
  listings: sql<number>`count(*)::INT`.as('listings'),
  ...STATUS_COUNTS,
  registrations: sql<number>`${registrations}`.as('registrations'),
  registrationsWithoutListing: sql<number>`${registrationsWithoutListing}`.as(
    'registrationsWithoutListing',
  ),
  registryDate: sql<number | null>`${registryDate}`.as('registryDate'),
};

export const SUMMARY_QUERY = qb.select(SUMMARY_FIELDS).from(listingsWithStatus);

export const BY_LISTING_TYPE_FIELDS = {
  listingType: sql<string>`coalesce(${listingsWithStatus.listingType}, 'Not listed')`.as(
    'listingType',
  ),
  ...STATUS_COUNTS,
};

export const BY_LISTING_TYPE_QUERY = qb
  .select(BY_LISTING_TYPE_FIELDS)
  .from(listingsWithStatus)
  .groupBy(listingsWithStatus.listingType)
  .orderBy(sql`count(*) DESC`);

export const COUNCIL_FIELDS = {
  council: sql<string>`coalesce(${registrationsActive.communityCouncil}, 'Address not geocoded')`.as(
    'council',
  ),
  registrations: sql<number>`count(*)::INT`.as('registrations'),
  listings: sql<number>`sum(${registrationsActive.airbnbListingsActive})::INT`.as(
    'listings',
  ),
};

export const COUNCIL_QUERY = qb
  .select(COUNCIL_FIELDS)
  .from(registrationsActive)
  .groupBy(registrationsActive.communityCouncil)
  .orderBy(desc(sql`count(*)`), asc(registrationsActive.communityCouncil))
  .limit(COUNCILS_SHOWN);
