import { describe, expect, it } from 'vitest';

import { toReviewPage, type ReviewPage } from '../src/airbnb/reviews.ts';
import {
  fetchFirstReviews,
  findFirstReviewDate,
  TAIL_WINDOW,
  type FetchReviewPage,
} from '../src/firstReviews.ts';
import { RateLimitedError } from '../src/pace.ts';

/** `count` review timestamps, newest first, one per day back from 2026-08-31. */
function reviewTimestamps(count: number): string[] {
  return [...Array(count).keys()].map((i) => {
    const day = new Date(Date.UTC(2026, 7, 31 - i, 18, 30));
    return day.toISOString().replace('.000', '');
  });
}

interface FakeListing {
  /** Newest first, as Airbnb returns them. */
  reviews?: string[];
  error?: Error;
}

/** A reviews endpoint over fixed listings, recording each request. */
function fakeEndpoint(listings: Record<string, FakeListing>): {
  fetchPage: FetchReviewPage;
  calls: Array<{ roomId: string; offset: number; limit: number }>;
} {
  const calls: Array<{ roomId: string; offset: number; limit: number }> = [];
  const fetchPage: FetchReviewPage = async (roomId, offset, limit) => {
    calls.push({ roomId, offset, limit });
    const listing = listings[roomId];
    if (!listing) throw new Error(`unknown room ${roomId}`);
    if (listing.error) throw listing.error;
    const reviews = listing.reviews ?? [];
    return { totalCount: reviews.length, createdAt: reviews.slice(offset, offset + limit) };
  };
  return { fetchPage, calls };
}

describe('findFirstReviewDate', () => {
  it('reads the oldest review of a listing with reviews in one request', async () => {
    const reviews = reviewTimestamps(138);
    const { fetchPage, calls } = fakeEndpoint({ '1': { reviews } });

    const date = await findFirstReviewDate({ roomId: '1', reviewCountHint: 138 }, fetchPage);

    expect(date).toBe(reviews.at(-1)!.slice(0, 10));
    expect(calls).toEqual([{ roomId: '1', offset: 138 - TAIL_WINDOW, limit: TAIL_WINDOW }]);
  });

  it('resolves a listing with no reviews to null in one request', async () => {
    const { fetchPage, calls } = fakeEndpoint({ '1': { reviews: [] } });

    expect(await findFirstReviewDate({ roomId: '1', reviewCountHint: null }, fetchPage)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('covers a listing search gave no count for, when it has only a few reviews', async () => {
    const reviews = reviewTimestamps(2);
    const { fetchPage, calls } = fakeEndpoint({ '1': { reviews } });

    const date = await findFirstReviewDate({ roomId: '1', reviewCountHint: null }, fetchPage);

    expect(date).toBe(reviews[1]!.slice(0, 10));
    expect(calls).toHaveLength(1);
  });

  it('re-requests at the true offset when search undercounted', async () => {
    const reviews = reviewTimestamps(40);
    const { fetchPage, calls } = fakeEndpoint({ '1': { reviews } });

    const date = await findFirstReviewDate({ roomId: '1', reviewCountHint: 12 }, fetchPage);

    expect(date).toBe(reviews[39]!.slice(0, 10));
    expect(calls.map((call) => call.offset)).toEqual([12 - TAIL_WINDOW, 40 - TAIL_WINDOW]);
  });

  it('re-requests at the true offset when search overcounted', async () => {
    const reviews = reviewTimestamps(20);
    const { fetchPage, calls } = fakeEndpoint({ '1': { reviews } });

    const date = await findFirstReviewDate({ roomId: '1', reviewCountHint: 50 }, fetchPage);

    expect(date).toBe(reviews[19]!.slice(0, 10));
    expect(calls.map((call) => call.offset)).toEqual([50 - TAIL_WINDOW, 20 - TAIL_WINDOW]);
  });

  it('takes the earliest date in the page, not the last entry', async () => {
    const fetchPage: FetchReviewPage = async () => ({
      totalCount: 3,
      createdAt: ['2025-06-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-03-01T00:00:00Z'],
    });

    expect(await findFirstReviewDate({ roomId: '1', reviewCountHint: 3 }, fetchPage)).toBe(
      '2024-01-02',
    );
  });

  it('throws when the reported total is never reached', async () => {
    const fetchPage: FetchReviewPage = async () => ({ totalCount: 30, createdAt: [] });

    await expect(
      findFirstReviewDate({ roomId: '1', reviewCountHint: 30 }, fetchPage),
    ).rejects.toThrow(/do not reach the reported total of 30/);
  });
});

describe('fetchFirstReviews', () => {
  it('reports a listing with reviews, one with none, and a fetch failure', async () => {
    const reviews = reviewTimestamps(8);
    const { fetchPage } = fakeEndpoint({
      '1': { reviews },
      '2': { reviews: [] },
      '3': { error: new Error('HTTP 500') },
    });

    const results = await fetchFirstReviews(
      [
        { roomId: '1', reviewCountHint: 8 },
        { roomId: '2', reviewCountHint: null },
        { roomId: '3', reviewCountHint: 4 },
      ],
      { fetchPage, concurrency: 1 },
    );

    expect(results).toEqual([
      { roomId: '1', firstReviewDate: reviews[7]!.slice(0, 10), error: null },
      { roomId: '2', firstReviewDate: null, error: null },
      { roomId: '3', firstReviewDate: null, error: expect.stringContaining('HTTP 500') },
    ]);
  });

  it('attempts no more than maxListings, in the order given', async () => {
    const listings = Object.fromEntries(
      [...Array(7).keys()].map((i) => [String(i), { reviews: reviewTimestamps(1) }]),
    );
    const { fetchPage, calls } = fakeEndpoint(listings);
    const candidates = Object.keys(listings).map((roomId) => ({ roomId, reviewCountHint: 1 }));

    const results = await fetchFirstReviews(candidates, { fetchPage, maxListings: 3 });

    expect(results.map((result) => result.roomId)).toEqual(['0', '1', '2']);
    expect(new Set(calls.map((call) => call.roomId))).toEqual(new Set(['0', '1', '2']));
  });

  it('aborts the pass on a rate limit', async () => {
    const { fetchPage } = fakeEndpoint({ '1': { error: new RateLimitedError('429') } });

    await expect(
      fetchFirstReviews([{ roomId: '1', reviewCountHint: 3 }], { fetchPage }),
    ).rejects.toThrow(RateLimitedError);
  });
});

describe('toReviewPage', () => {
  /** A response shaped like Airbnb's, with the guest fields this module ignores. */
  function response(reviewsCount: unknown, reviews: unknown[]): Parameters<typeof toReviewPage>[0] {
    return {
      data: {
        presentation: {
          stayProductDetailPage: {
            reviews: { metadata: { reviewsCount }, reviews: reviews as Array<{ createdAt?: unknown }> },
          },
        },
      },
    };
  }

  it('keeps only the total and each review timestamp', () => {
    const page: ReviewPage = toReviewPage(
      response(19, [
        {
          createdAt: '2023-08-06T00:21:58Z',
          comments: 'Great stay!',
          reviewer: { firstName: 'Sam', pictureUrl: 'https://example.com/p.jpg' },
        },
      ]),
      '1',
    );
    expect(page).toEqual({ totalCount: 19, createdAt: ['2023-08-06T00:21:58Z'] });
  });

  it('throws on GraphQL errors, which a rotated hash returns', () => {
    expect(() =>
      toReviewPage({ errors: [{ message: 'Sorry, something went wrong.' }] }, '1'),
    ).toThrow(/Sorry, something went wrong/);
  });

  it('throws when the total is missing', () => {
    expect(() => toReviewPage(response(undefined, []), '1')).toThrow(/no reviewsCount/);
  });

  it('throws on a review without a date, which would shift the offset', () => {
    expect(() => toReviewPage(response(1, [{ comments: 'hi' }]), '1')).toThrow(/no createdAt/);
  });
});
