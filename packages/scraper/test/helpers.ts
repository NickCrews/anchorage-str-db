import type { CalendarResult } from '@anchorage-str-db/scraper-airbnb/calendars';
import type { IsoDate } from '@anchorage-str-db/utils/dates';

/** One listing, one night — the smallest thing `mergeCalendar` will take. */
export function calendarResultFor(
  roomId: string,
  nightDate: IsoDate,
  available: boolean,
  minNights: number | null,
): CalendarResult {
  return {
    roomId,
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
