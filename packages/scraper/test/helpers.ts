import type { CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import type { ProfileListing } from '@anchorage-str-db/scraper-airbnb/api/hostListings';
import type { HostListingsResult } from '@anchorage-str-db/scraper-airbnb/hostListings';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

/** One listing, one night — the smallest thing `mergeCalendar` will take. */
export function calendarResultFor(
  listingId: string,
  nightDate: IsoDate,
  available: boolean,
  minNights: number | null,
): CalendarResult {
  return {
    listingId,
    nights: [
      {
        nightDate,
        available,
        minNights,
        availableForCheckin: available,
        availableForCheckout: true,
        maxNights: null,
      },
    ],
    error: null,
  };
}

/**
 * A profile-listings read as `fetchHostListings` returns it: `listings` ids,
 * each with the same fields, in one response shaped as Airbnb sends it.
 * `raw` makes the response unparseable, as a changed shape would.
 */
export function profileRead(
  hostId: string,
  listings: readonly string[],
  overrides: Partial<HostListingsResult> & { raw?: string; fields?: Partial<ProfileListing> } = {},
): HostListingsResult {
  const { raw, fields, ...rest } = overrides;
  const parsed = listings.map(
    (listingId): ProfileListing => ({
      listingId,
      name: `Cabin ${listingId}`,
      photoUrl: `https://a0.muscache.com/im/pictures/${listingId}.jpeg`,
      buildingType: 'Cabin',
      listingType: 'Entire home/apt',
      listingTypeKey: 'entire_home',
      ratingValue: 4.9,
      reviewCount: 12,
      isSuperhost: true,
      isNewListing: false,
      ...fields,
    }),
  );
  const body = raw ?? JSON.stringify({ data: { beehive: { getListOfListings: { listings: parsed } } } });
  return {
    hostId,
    fetchOk: true,
    listings: raw === undefined ? parsed : null,
    responses: [body],
    error: raw === undefined ? null : 'Error: profile listings response has no listings list',
    ...rest,
  };
}

/** `profileRead`s keyed by host id, as `recordHostObservations` takes them. */
export function profileReads(reads: readonly HostListingsResult[]): Map<string, HostListingsResult> {
  return new Map(reads.map((read) => [read.hostId, read]));
}
