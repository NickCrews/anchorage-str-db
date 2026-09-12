import type { CalendarResult } from '../src/calendars.ts';
import type { IsoDate } from '../src/dates.ts';

/** One listing, one night — the smallest thing `mergeCalendar` will take. */
export function calendarResultFor(
  roomId: string,
  nightDate: IsoDate,
  available: boolean,
  minNights: number | null,
  priceAmount: number | null,
): CalendarResult {
  return {
    roomId,
    nights: [{ nightDate, available, minNights, priceAmount }],
    error: null,
  };
}
