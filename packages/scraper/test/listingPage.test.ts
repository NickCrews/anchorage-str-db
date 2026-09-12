/**
 * Listing-page parser tests. These build synthetic pages shaped like Airbnb's
 * and alter them to exercise each extraction layer's fallback. Changes on
 * Airbnb's side are caught by the `extraction_layer_*_alive` checks instead.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseListingPage } from '../src/listingPage.ts';
import { log } from '../src/log.ts';

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
  } = options;

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
                  },
                },
                location: stateLocation,
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
                  sections: [
                    { section: { items } },
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
  expect(page.strRegistrationId).toBe('STR20261897');
  expect(page.locationSource).toBe('json-ld+state');
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
    expect(page.locationSource).toBe('json-ld+state');
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

// --- registration number --------------------------------------------------

describe('the STR registration number', () => {
  it('prefers the structured item over the prose', () => {
    const page = parseListingPage(
      makePage({
        registration: 'STR20261897',
        description: `Permit STR20260000 ${'x'.repeat(300)}`,
      }),
      '1',
    );

    expect(page.strRegistrationId).toBe('STR20261897');
  });

  it.each(['STR20261897', 'str 20261897', 'STR-20261897', 'Str20261897'])(
    'normalizes the case and separators hosts type by hand: %s',
    (text) => {
      expect(parseListingPage(makePage({ registration: text }), '1').strRegistrationId).toBe(
        'STR20261897',
      );
    },
  );

  it('is null, not an error, when missing', () => {
    const page = parseListingPage(makePage({ registration: null }), '1');

    expect(page.strRegistrationId).toBeNull();
    expect(page.locationIsExact).toBe(true);
  });

  it('is null when the page has conflicting numbers', () => {
    const html = makePage({
      registration: null,
      description: `Permit STR20260001 or maybe STR20260002. ${'Lovely cabin. '.repeat(20)}`,
    });

    expect(parseListingPage(html, '1').strRegistrationId).toBeNull();
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
