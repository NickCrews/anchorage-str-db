/**
 * Listing-page parser tests. These build synthetic pages shaped like Airbnb's
 * and alter them to exercise each extraction layer's fallback. Changes on
 * Airbnb's side are caught by the `extraction_layer_*_alive` checks instead.
 */

import { describe, expect, it, vi } from 'vitest';

import { log } from '@anchorage-str-db/utils/log';

import { parseListingPage } from '../src/listingPage.ts';

/** A GraphQL id: base64 of `<TypeName>:<id>`. */
function graphqlId(typeName: string, id: string): string {
  return Buffer.from(`${typeName}:${id}`).toString('base64');
}

const HOST_ID = '1726975321647428715';

const STATE_LOCATION = {
  __typename: 'StaysPdpLocation',
  subtitle: 'Anchorage, Alaska, United States',
  latitude: 60.9568,
  longitude: -149.1294,
  isExactLocation: true,
  exactAddress: null,
  verificationDetails: { isVerified: true },
};

interface PageOptions {
  stateLocation?: Record<string, unknown>;
  jsonLd?: boolean;
  registration?: string | null;
  description?: string;
  wrapper?: string;
  state?: boolean;
  /** The host card's `DemandUser` id; null omits the card. */
  cardHostId?: string | null;
  /** The analytics context's decimal `hostId`; null omits it. */
  contextHostId?: string | null;
  cohostIds?: string[];
  /** The analytics context's `roomType`; null omits it. */
  listingType?: string | null;
  /** The share card's `personCapacity`; null omits it. */
  personCapacity?: number | null;
  /** The listing node's `bedCount`; null omits it. */
  bedCount?: number | null;
  /** The overview's `items`; null omits the overview. */
  overviewItems?: string[] | null;
  /** The photo tour's image URIs, in order; null omits the tour. */
  photoUrls?: string[] | null;
  /** A second, shorter tour elsewhere in the page; null omits it. */
  previewPhotoUrls?: string[] | null;
  /** Replaces the card's `about`; `undefined` removes the key. */
  about?: unknown;
  timeAsHost?: Record<string, unknown> | null;
}

const PHOTOS = [...Array(12).keys()].map(
  (i) => `https://a0.muscache.com/im/pictures/hosting/Hosting-1/original/photo-${i}.jpeg`,
);

const BIO = {
  __typename: 'UGCText',
  localizedStringWithTranslationPreference: 'Mark and Gwen have lived in Alaska for 20 years.',
  localizedString: 'Mark and Gwen have lived in Alaska for 20 years.',
  source: 'Mark and Gwen have lived in Alaska for 20 years.',
};

/** A `mediaTour` holding `urls` in order, split into stops of up to five images. */
function mediaTour(urls: readonly string[]): Record<string, unknown> {
  const stops = [];
  for (let i = 0; i < urls.length; i += 5) {
    stops.push({
      __typename: 'MediaTourStop',
      items: urls.slice(i, i + 5).map((uri) => ({
        __typename: 'ImageMediaTourItem',
        image: { __typename: 'Image', uri },
      })),
    });
  }
  return { __typename: 'MediaTour', stops };
}

/** A page shaped like Airbnb's: a schema.org block and a nested GraphQL blob. */
function makePage(options: PageOptions = {}): string {
  const {
    stateLocation = STATE_LOCATION,
    jsonLd = true,
    registration = 'STR20261897',
    description = 'A lovely cabin.',
    wrapper = 'niobeClientData',
    state = true,
    cardHostId = HOST_ID,
    contextHostId = HOST_ID,
    cohostIds = [],
    listingType = 'Entire home/apt',
    personCapacity = 5,
    bedCount = 3,
    overviewItems = ['5 guests', '2 bedrooms', '3 beds', '1.5 baths'],
    photoUrls = PHOTOS,
    previewPhotoUrls = null,
    timeAsHost = { __typename: 'TimeAsUser', years: 9, months: 7 },
  } = options;
  const about = 'about' in options ? options.about : BIO;

  const parts: string[] = [];
  if (jsonLd) {
    parts.push(
      '<script type="application/ld+json">' +
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'VacationRental',
          latitude: 60.9568,
          longitude: -149.1294,
          address: { addressLocality: 'Anchorage' },
          // Airbnb's JSON-LD lists at most 8 photos, and its occupancy is a bed count.
          image: PHOTOS.slice(0, 8),
          containsPlace: { '@type': 'Accommodation', occupancy: { value: 3 } },
        }) +
        '</script>',
    );
  }
  const items: Array<Record<string, unknown>> = [
    { title: 'Other things to note', html: { htmlText: 'no pets' } },
  ];
  if (registration) items.push({ title: 'Registration Details', html: { htmlText: registration } });

  const stateBlob = {
    [wrapper]: [
      [
        'query',
        {
          data: {
            node: {
              bedCount: bedCount ?? undefined,
              cohosts: cohostIds.map((id) => ({
                __typename: 'ContextualUser',
                id: graphqlId('ContextualUser', id),
              })),
              pdpPresentation: {
                hostInfo: cardHostId && {
                  passportData: {
                    name: 'Rachel',
                    userId: graphqlId('DemandUser', cardHostId),
                    contextualUserId: graphqlId('ContextualUser', '1462636974849197760'),
                    ...(timeAsHost && { timeAsHost }),
                  },
                  ...(about !== undefined && { about }),
                },
                location: stateLocation,
                overview: overviewItems && { __typename: 'StaysPdpOverview', items: overviewItems },
                mediaTour: photoUrls && mediaTour(photoUrls),
                descriptions: {
                  longDescriptionHtml: {
                    localizedStringWithTranslationPreference: description,
                  },
                },
              },
            },
            presentation: {
              stayProductDetailPage: {
                sections: {
                  metadata: {
                    loggingContext: { eventDataLogging: listingType && { roomType: listingType } },
                  },
                  sections: [
                    { section: { items } },
                    {
                      section: {
                        shareSave: { embedData: personCapacity && { personCapacity } },
                        pdpPresentation: previewPhotoUrls && { mediaTour: mediaTour(previewPhotoUrls) },
                      },
                    },
                    {
                      loggingData: {
                        eventData: {
                          pdpContext: contextHostId && { isSuperHost: 'true', hostId: contextHostId },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    ],
  };
  if (state) {
    parts.push(
      '<script id="data-deferred-state-0" type="application/json">' +
        JSON.stringify(stateBlob) +
        '</script>',
    );
  }
  return `<html><body>${parts.join('')}</body></html>`;
}

it('reads the location flag and coordinate', () => {
  const page = parseListingPage(makePage(), '1');

  expect(page.locationIsExact).toBe(true);
  expect([page.lat, page.lng]).toEqual([60.9568, -149.1294]);
  expect(page.locationSubtitle).toBe('Anchorage, Alaska, United States');
  expect(page.locationVerified).toBe(true);
  expect(page.registrationId).toBe('STR20261897');
  expect(page.locationSource).toBe('json-ld+state+raw-html');
});

it('distinguishes fuzzed listings from exact ones', () => {
  const fuzzed = { ...STATE_LOCATION, isExactLocation: false };

  expect(parseListingPage(makePage({ stateLocation: fuzzed }), '1').locationIsExact).toBe(false);
});

// --- fallbacks -------------------------------------------------------------

describe('resilience', () => {
  it('survives a renamed wrapper, because lookup is by shape', () => {
    const page = parseListingPage(makePage({ wrapper: 'apolloState' }), '1');

    expect(page.locationIsExact).toBe(true);
    expect(page.locationSource).toBe('json-ld+state+raw-html');
  });

  it('survives a renamed flag', () => {
    const renamed = Object.fromEntries(
      Object.entries(STATE_LOCATION).map(([key, value]) => [
        key.replace('isExactLocation', 'hasExactLocation'),
        value,
      ]),
    );

    expect(parseListingPage(makePage({ stateLocation: renamed }), '1').locationIsExact).toBe(true);
  });

  it('falls back to raw html when the json will not parse', () => {
    const html = makePage().replace('type="application/json">', 'type="application/json">{{{');

    const page = parseListingPage(html, '1');

    // Coordinate from JSON-LD, flag from the raw-html regex.
    expect([page.lat, page.locationIsExact]).toEqual([60.9568, true]);
    expect(page.locationSource).toBe('json-ld+raw-html');
  });

  it('degrades to coordinate-only when the state blob is gone', () => {
    const page = parseListingPage(makePage({ state: false }), '1');

    expect(page.lat).toBe(60.9568);
    expect(page.locationIsExact).toBeNull();
    expect(page.locationSource).toBe('json-ld');
  });

  it('throws when no layer finds anything', () => {
    expect(() => parseListingPage('<html><body>Page not available</body></html>', '1')).toThrow(
      /no location data/,
    );
  });

  it('finds the payload in an unnamed script tag', () => {
    const html = makePage().replace('id="data-deferred-state-0" type="application/json"', '');

    expect(parseListingPage(html, '1').locationIsExact).toBe(true);
  });
});

// --- coordinate -------------------------------------------------------------

describe('the coordinate', () => {
  it('prefers the state, which is not rounded, without warning about rounding', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const stateLocation = { ...STATE_LOCATION, latitude: 60.95681234, longitude: -149.12943456 };
      const page = parseListingPage(makePage({ stateLocation }), '1');

      expect([page.lat, page.lng]).toEqual([60.95681234, -149.12943456]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the layers are further apart than rounding explains', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const stateLocation = { ...STATE_LOCATION, latitude: 60.9668 };
      const page = parseListingPage(makePage({ stateLocation }), '1');

      expect(page.lat).toBe(60.9668);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/layers disagree on the coordinate by 111\d m/),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('comes from json-ld when the state has none', () => {
    const { latitude: _lat, longitude: _lng, ...stateLocation } = STATE_LOCATION;
    const page = parseListingPage(makePage({ stateLocation }), '1');

    expect([page.lat, page.lng]).toEqual([60.9568, -149.1294]);
    expect(page.locationIsExact).toBe(true);
  });
});

// --- registration id --------------------------------------------------

describe('the STR registration id', () => {
  it('prefers the structured item over the prose', () => {
    const page = parseListingPage(
      makePage({
        registration: 'STR20261897',
        description: `Permit STR20260000 ${'x'.repeat(300)}`,
      }),
      '1',
    );

    expect(page.registrationId).toBe('STR20261897');
  });

  it.each(['STR20261897', 'str 20261897', 'STR-20261897', 'Str20261897'])(
    'normalizes the case and separators hosts type by hand: %s',
    (text) => {
      expect(parseListingPage(makePage({ registration: text }), '1').registrationId).toBe(
        'STR20261897',
      );
    },
  );

  it('is null, not an error, when missing', () => {
    const page = parseListingPage(makePage({ registration: null }), '1');

    expect(page.registrationId).toBeNull();
    expect(page.locationIsExact).toBe(true);
  });

  it('is null when the page has conflicting numbers', () => {
    const html = makePage({
      registration: null,
      description: `Permit STR20260001 or maybe STR20260002. ${'Lovely cabin. '.repeat(20)}`,
    });

    expect(parseListingPage(html, '1').registrationId).toBeNull();
  });
});

// --- host id ----------------------------------------------------------------

describe('the host id', () => {
  it('is read from the host card and the analytics context', () => {
    const page = parseListingPage(makePage(), '1');

    expect(page.hostId).toBe(HOST_ID);
  });

  it('comes from the host card when the analytics context is gone', () => {
    const page = parseListingPage(makePage({ contextHostId: null }), '1');

    expect(page.hostId).toBe(HOST_ID);
  });

  it('comes from raw html when the json will not parse', () => {
    const html = makePage().replace('type="application/json">', 'type="application/json">{{{');

    expect(parseListingPage(html, '1').hostId).toBe(HOST_ID);
  });

  it('ignores co-hosts, which are ContextualUsers', () => {
    const page = parseListingPage(
      makePage({ cohostIds: ['1487913503972378124', '1670698168493833065'] }),
      '1',
    );

    expect(page.hostId).toBe(HOST_ID);
  });

  it('is null, not an error, when the page names no host', () => {
    const page = parseListingPage(makePage({ cardHostId: null, contextHostId: null }), '1');

    expect(page.hostId).toBeNull();
    expect(page.locationIsExact).toBe(true);
  });

  it('warns when the layers disagree', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const page = parseListingPage(makePage({ contextHostId: '42' }), '1');

      expect(page.hostId).toBe(HOST_ID);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('layers disagree on hostId'));
    } finally {
      warn.mockRestore();
    }
  });
});

// --- listing type and counts ------------------------------------------------

describe('listing type and counts', () => {
  it('are read from the state, the text fields verbatim', () => {
    const page = parseListingPage(makePage(), '1');

    expect(page.listingType).toBe('Entire home/apt');
    expect(page.guestCapacity).toBe(5);
    expect(page.beds).toBe(3);
    expect(page.bedrooms).toBe('2 bedrooms');
    expect(page.bathrooms).toBe('1.5 baths');
  });

  it.each(['Private room', 'Shared room', 'Hotel room', 'A listing type Airbnb adds later'])(
    'store any listing type as written: %s',
    (listingType) => {
      expect(parseListingPage(makePage({ listingType }), '1').listingType).toBe(listingType);
    },
  );

  it('store a room’s overview lines as written', () => {
    const page = parseListingPage(
      makePage({ overviewItems: ['1 queen bed', 'Shared half bathroom'] }),
      '1',
    );

    expect(page.bathrooms).toBe('Shared half bathroom');
    expect(page.bedrooms).toBeNull();
  });

  it('read a studio as its bedroom line', () => {
    const page = parseListingPage(makePage({ overviewItems: ['3 guests', 'Studio', '1 bed', '1 bath'] }), '1');

    expect(page.bedrooms).toBe('Studio');
  });

  it('take guest capacity from personCapacity, not the overview’s capped guest line', () => {
    const page = parseListingPage(
      makePage({ personCapacity: 18, overviewItems: ['16+ guests', '7 bedrooms', '3 baths'] }),
      '1',
    );

    expect(page.guestCapacity).toBe(18);
  });

  it('come from raw html when the json will not parse', () => {
    const html = makePage().replace('type="application/json">', 'type="application/json">{{{');

    const page = parseListingPage(html, '1');

    expect([page.listingType, page.guestCapacity, page.beds, page.bedrooms, page.bathrooms]).toEqual([
      'Entire home/apt',
      5,
      3,
      '2 bedrooms',
      '1.5 baths',
    ]);
  });

  it('are null, not an error, when the page has none', () => {
    const page = parseListingPage(
      makePage({ listingType: null, personCapacity: null, bedCount: null, overviewItems: null }),
      '1',
    );

    expect([page.listingType, page.guestCapacity, page.beds, page.bedrooms, page.bathrooms]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(page.locationIsExact).toBe(true);
  });
});

// --- photos -------------------------------------------------------------------

describe('photos', () => {
  it('are the whole gallery, in order, not the truncated JSON-LD list', () => {
    const page = parseListingPage(makePage(), '1');

    expect(page.photoUrls).toEqual(PHOTOS);
  });

  it('come from the longest tour when the page has a shorter preview', () => {
    const page = parseListingPage(makePage({ previewPhotoUrls: PHOTOS.slice(3, 8) }), '1');

    expect(page.photoUrls).toEqual(PHOTOS);
  });

  it('are de-duplicated', () => {
    const page = parseListingPage(makePage({ photoUrls: [PHOTOS[0]!, PHOTOS[1]!, PHOTOS[0]!] }), '1');

    expect(page.photoUrls).toEqual([PHOTOS[0], PHOTOS[1]]);
  });

  it('are null when the page has no gallery', () => {
    const page = parseListingPage(makePage({ photoUrls: null }), '1');

    expect(page.photoUrls).toBeNull();
    expect(page.locationIsExact).toBe(true);
  });
});

// --- host card --------------------------------------------------------------

describe('the host card', () => {
  it('reads name, bio and time as a host', () => {
    expect(parseListingPage(makePage(), '1').hostCard).toEqual({
      hostId: HOST_ID,
      name: 'Rachel',
      about: 'Mark and Gwen have lived in Alaska for 20 years.',
      timeAsHostYears: 9,
      timeAsHostMonths: 7,
    });
  });

  it('records no bio when about is null', () => {
    const card = parseListingPage(makePage({ about: null }), '1').hostCard;

    expect(card?.name).toBe('Rachel');
    expect(card?.about).toBeNull();
  });

  it('prefers the text as the host wrote it', () => {
    const about = { ...BIO, source: 'Original', localizedString: 'Translated' };

    expect(parseListingPage(makePage({ about }), '1').hostCard?.about).toBe('Original');
  });

  it('is null without an about key, rather than recording no bio', () => {
    expect(parseListingPage(makePage({ about: undefined }), '1').hostCard).toBeNull();
  });

  it('is null when about has no text member it recognizes', () => {
    const about = { __typename: 'UGCText', richText: 'reshaped' };

    expect(parseListingPage(makePage({ about }), '1').hostCard).toBeNull();
  });

  it('is null without timeAsHost, which is how the card is found', () => {
    expect(parseListingPage(makePage({ timeAsHost: null }), '1').hostCard).toBeNull();
  });

  it('is dropped when it names a different account than the listing’s host', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      // A second DemandUser elsewhere leaves the state layer without a host
      // id, so the analytics context supplies it, and the card is someone else's.
      const html = makePage({ cardHostId: '999999999' }).replace(
        '"cohosts":[]',
        `"cohosts":[],"reviewer":{"id":"${graphqlId('DemandUser', HOST_ID)}"}`,
      );
      const page = parseListingPage(html, '1');

      expect(page.hostId).toBe(HOST_ID);
      expect(page.hostCard).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not recording the card'));
    } finally {
      warn.mockRestore();
    }
  });
});
