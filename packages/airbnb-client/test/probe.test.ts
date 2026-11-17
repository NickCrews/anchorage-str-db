import { describe, expect, it } from 'vitest';

import type { CalendarDay } from '../src/api/calendar.ts';
import { HttpError } from '../src/api/http.ts';
import { toReviewPage } from '../src/api/reviews.ts';
import { standardizePriceQuote } from '../src/api/priceQuote.ts';
import { emptyListingPage } from '../src/listingPage.ts';
import { calendarProblem, classify, fieldsMissingOnAll } from '../src/probe.ts';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('did not throw');
}

describe('classify', () => {
  it('reads a 400 as a changed query', () => {
    expect(classify(new HttpError(400, 'https://www.airbnb.com/api/v3/X/abc'))).toBe('query-changed');
  });

  it('reads 403 and 429 as blocked', () => {
    expect(classify(new HttpError(403, 'u'))).toBe('blocked');
    expect(classify(new HttpError(429, 'u'))).toBe('blocked');
  });

  it('reads GraphQL errors as changed variables', () => {
    expect(classify(thrown(() => toReviewPage({ errors: [{ message: 'bad' }] }, '1')))).toBe('variables-changed');
    expect(classify(thrown(() => standardizePriceQuote({ errors: [{ message: 'bad' }] })))).toBe(
      'variables-changed',
    );
  });

  it('reads a missing field as a changed response', () => {
    expect(classify(thrown(() => toReviewPage({ data: {} }, '1')))).toBe('response-changed');
    expect(classify(thrown(() => standardizePriceQuote({ data: {} })))).toBe('response-changed');
  });

  it('reads anything else as other', () => {
    expect(classify(new HttpError(503, 'u'))).toBe('other');
    expect(classify(new Error('timeout'))).toBe('other');
  });
});

describe('fieldsMissingOnAll', () => {
  it('lists fields no page yielded', () => {
    const full = { ...emptyListingPage('1'), lat: 61.2, lng: -149.9, locationIsExact: false, hostId: '9' };
    const pages = [
      { ...full, listingType: 'Entire home/apt', guestCapacity: 4, photoUrls: [] },
      { ...full, listingType: null, guestCapacity: 2, photoUrls: [] },
    ];
    expect(fieldsMissingOnAll(pages)).toEqual(['photoUrls']);
  });
});

describe('calendarProblem', () => {
  function days(count: number, overrides: Partial<CalendarDay> = {}): CalendarDay[] {
    return Array.from({ length: count }, (_, i) => ({
      calendarDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      available: i % 2 === 0,
      availableForCheckin: true,
      availableForCheckout: true,
      minNights: 2,
      maxNights: 30,
      ...overrides,
    }));
  }

  it('accepts a full calendar', () => {
    expect(calendarProblem(days(365))).toBeNull();
  });

  it('flags a short calendar, missing minimum stays, and no open nights', () => {
    expect(calendarProblem(days(30))).toMatch(/30 days/);
    expect(calendarProblem(days(365, { minNights: null }))).toMatch(/minNights/);
    expect(calendarProblem(days(365, { available: false }))).toMatch(/available/);
  });
});
