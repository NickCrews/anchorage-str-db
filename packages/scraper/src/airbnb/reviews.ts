/**
 * Airbnb's `StaysPdpReviewsQuery` endpoint: one page of a listing's reviews,
 * newest first, plus the listing's total review count.
 *
 * The endpoint has no oldest-first sort: `sortingPreference` accepts
 * `MOST_RECENT` and the rating sorts, and rejects `OLDEST` and `LEAST_RECENT`
 * with a `ValidationError`. It does accept any `offset`, so the oldest review
 * is the last page of `MOST_RECENT` (see `../firstReviews.ts`).
 *
 * Reviews are guest-authored and carry guest names, profile links and text.
 * Only `createdAt` is read from them.
 */

import { requestJson } from './http.ts';

const OPERATION_ID = 'dec1c8061483e78373602047450322fd474e79ba9afa8d3dbbc27f504030f91d';

export interface ReviewPage {
  /** Airbnb's count of every review on the listing, not just this page. */
  totalCount: number;
  /** Each review's `createdAt`, an ISO UTC timestamp, in response order. */
  createdAt: string[];
}

export interface FetchReviewPageOptions {
  apiKey: string;
  roomId: string;
  offset: number;
  limit: number;
  language: string;
  currency: string;
}

interface ReviewsResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    presentation?: {
      stayProductDetailPage?: {
        reviews?: {
          metadata?: { reviewsCount?: unknown };
          reviews?: Array<{ createdAt?: unknown }>;
        };
      };
    };
  };
}

/**
 * One page of reviews. Throws if the response carries GraphQL errors or no
 * review count, which is what a rotated hash or a changed shape looks like.
 */
export async function fetchReviewPage(options: FetchReviewPageOptions): Promise<ReviewPage> {
  const query = new URLSearchParams({
    operationName: 'StaysPdpReviewsQuery',
    locale: options.language,
    currency: options.currency,
    variables: JSON.stringify({
      // A GraphQL id: base64 of `StayListing:<room id>`.
      id: Buffer.from(`StayListing:${options.roomId}`).toString('base64'),
      pdpReviewsRequest: {
        fieldSelector: 'for_p3_translation_only',
        forPreview: false,
        limit: options.limit,
        offset: String(options.offset),
        showingTranslationButton: false,
        first: options.limit,
        sortingPreference: 'MOST_RECENT',
        numberOfAdults: '1',
        numberOfChildren: '0',
        numberOfInfants: '0',
        numberOfPets: '0',
        after: null,
      },
    }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: OPERATION_ID },
    }),
  });

  const data = await requestJson<ReviewsResponse>(
    `https://www.airbnb.com/api/v3/StaysPdpReviewsQuery/${OPERATION_ID}/?${query}`,
    {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': options.language,
        'X-Airbnb-Api-Key': options.apiKey,
      },
    },
  );
  return toReviewPage(data, options.roomId);
}

export function toReviewPage(data: ReviewsResponse, roomId: string): ReviewPage {
  if (data.errors?.length) {
    const messages = data.errors.map((error) => error.message ?? '?').join('; ');
    throw new Error(`reviews query for room ${roomId} returned errors: ${messages}`);
  }
  const reviews = data.data?.presentation?.stayProductDetailPage?.reviews;
  const totalCount = reviews?.metadata?.reviewsCount;
  if (typeof totalCount !== 'number') {
    throw new Error(`reviews response for room ${roomId} has no reviewsCount`);
  }
  // Every review must have a date: the caller locates the oldest review by
  // counting positions, so a dropped entry would shift it.
  const createdAt = (reviews?.reviews ?? []).map((review) => {
    if (typeof review.createdAt !== 'string') {
      throw new Error(`a review for room ${roomId} has no createdAt`);
    }
    return review.createdAt;
  });
  return { totalCount, createdAt };
}
