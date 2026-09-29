/** The registrations table's query: one row per registration the Muni has published. */

import { qb } from '@anchorage-str-db/db/sql';
import { registrations } from '@anchorage-str-db/db/viewSchema';
import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

/**
 * `license_*` columns come from the latest CityView license page read, which
 * is re-read about weekly, so they can be NULL for a new registration.
 * `airbnb_listings_active` counts active Airbnb listings showing the id.
 */
export const REGISTRATION_FIELDS = {
  registration_id: registrations.registrationId,
  business_name: registrations.businessName,
  registered_address: registrations.registeredAddress,
  community_council: registrations.communityCouncil,
  parcel_type: registrations.parcelType,
  parcel_id: registrations.parcelId,
  airbnb_listings_active: registrations.airbnbListingsActive,
  issued_date: registrations.issuedDate,
  expires_date: registrations.expiresDate,
  status: registrations.status,
  license_status: registrations.licenseStatus,
  license_description: registrations.licenseDescription,
  license_read_date: registrations.licenseReadDate,
  first_seen_date: registrations.firstSeenDate,
  last_seen_date: registrations.lastSeenDate,
  is_active: registrations.isActive,
  status_url: registrations.statusUrl,
};

/** The table, before the search box's and the scope toggle's filters. */
const registrationsQuery = (where: SQL | undefined) =>
  qb
    .select(REGISTRATION_FIELDS)
    .from(registrations)
    .where(where)
    .orderBy(
      sql`${registrations.issuedDate} DESC NULLS LAST`,
      asc(registrations.registrationId),
    );

export const SCOPES = {
  active: 'Active',
  unlisted: 'Active, no Airbnb listing',
  lapsed: 'Lapsed',
  all: 'All',
} as const;
export type Scope = keyof typeof SCOPES;

const SCOPE_FILTER: Record<Scope, SQL | undefined> = {
  active: eq(registrations.isActive, true),
  unlisted: and(
    eq(registrations.isActive, true),
    eq(registrations.airbnbListingsActive, 0),
  ),
  lapsed: eq(registrations.isActive, false),
  all: undefined,
};

/** The table as shown: `scope`'s filter and the search box's `search`. */
export const registrationsTableQuery = (scope: Scope, search: string) => {
  const term = search.trim();
  const pattern = `%${term}%`;
  return registrationsQuery(
    and(
      SCOPE_FILTER[scope],
      term
        ? or(
            ilike(registrations.registrationId, pattern),
            ilike(registrations.businessName, pattern),
            ilike(registrations.registeredAddress, pattern),
            ilike(registrations.communityCouncil, pattern),
            ilike(registrations.parcelId, pattern),
            ilike(registrations.licenseDescription, pattern),
          )
        : undefined,
    ),
  );
};
