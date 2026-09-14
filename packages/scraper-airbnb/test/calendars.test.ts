import { beforeEach, describe, expect, it } from 'vitest';

import type { CalendarDay } from '../src/api/calendar.ts';
import { fetchCalendars, toNights, type CalendarResult } from '../src/calendars.ts';
import { resetPace } from '../src/pace.ts';

beforeEach(() => {
  resetPace({ rate: 1e6 });
});

function day(calendarDate: string, available: boolean): CalendarDay {
  return {
    calendarDate,
    available,
    availableForCheckin: available,
    availableForCheckout: true,
    minNights: 2,
    maxNights: null,
  };
}

describe('toNights', () => {
  it('drops days before the scrape date', () => {
    // Airbnb returns the whole current month, with elapsed days unavailable.
    const days = [
      day('2026-08-01', false),
      day('2026-08-14', false),
      day('2026-08-15', true),
      day('2026-08-16', false),
    ];

    expect(toNights(days, '2026-08-15').map((night) => night.nightDate)).toEqual([
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('carries availability and min nights', () => {
    const nights = toNights([day('2026-08-15', true)], '2026-08-15');

    expect(nights).toEqual([
      {
        nightDate: '2026-08-15',
        available: true,
        availableForCheckin: true,
        availableForCheckout: true,
        minNights: 2,
        maxNights: null,
      },
    ]);
  });
});

describe('fetchCalendars', () => {
  it('returns one result per room, in order, and logs the failures', async () => {
    const results = await fetchCalendars(['1', '2', '3'], {
      minDate: '2026-08-15',
      concurrency: 2,
      fetchOne: async (roomId): Promise<CalendarResult> =>
        roomId === '2'
          ? { roomId, nights: [], error: 'HttpError: HTTP 503' }
          : { roomId, nights: toNights([day('2026-08-20', true)], '2026-08-15'), error: null },
    });

    expect(results.map((result) => result.roomId)).toEqual(['1', '2', '3']);
    expect(results.filter((result) => result.error)).toHaveLength(1);
  });

  it('never has more than `concurrency` fetches in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await fetchCalendars(
      [...Array(20).keys()].map(String),
      {
        minDate: '2026-08-15',
        concurrency: 3,
        fetchOne: async (roomId) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return { roomId, nights: [], error: null };
        },
      },
    );

    expect(peak).toBe(3);
  });
});
