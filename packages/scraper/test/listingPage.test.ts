/**
 * Parser tests for the listing page.
 *
 * No network. These build pages shaped like Airbnb's and then deliberately
 * break them, because the point of `listingPage.ts`'s layered design is what
 * it does when Airbnb changes something — a test suite that only checks the
 * happy path would pass right up until the parse started silently returning
 * nulls. What no offline test can tell you is whether Airbnb has *already*
 * changed; only a live fetch does that, which is what the
 * `extraction_layer_*_alive` data-quality checks are for.
 */

import { describe, expect, it } from 'vitest';

import { parseListingPage } from '../src/listingPage.ts';

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
}

/**
 * A page shaped like Airbnb's: a schema.org block for search engines and a
 * big GraphQL blob for the app, nested a few layers deep.
 */
function makePage(options: PageOptions = {}): string {
  const {
    stateLocation = STATE_LOCATION,
    jsonLd = true,
    registration = 'STR20261897',
    description = 'A lovely cabin.',
    wrapper = 'niobeClientData',
    state = true,
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
              pdpPresentation: {
                location: stateLocation,
                descriptions: {
                  longDescriptionHtml: {
                    localizedStringWithTranslationPreference: description,
                  },
                },
              },
            },
            presentation: {
              stayProductDetailPage: { sections: { sections: [{ section: { items } }] } },
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
  // The flag, not the coordinate, separates the two cases — Airbnb returns a
  // plausible-looking Anchorage point either way.
  const fuzzed = { ...STATE_LOCATION, isExactLocation: false };

  expect(parseListingPage(makePage({ stateLocation: fuzzed }), '1').locationIsExact).toBe(false);
});

// --- resilience: the reason this parser is layered ------------------------

describe('resilience', () => {
  it('survives a renamed wrapper, because lookup is by shape', () => {
    // A path-walking parser hardcoding `niobeClientData[0][1].data.node…`
    // dies the day Airbnb renames any link in that chain.
    const page = parseListingPage(makePage({ wrapper: 'apolloState' }), '1');

    expect(page.locationIsExact).toBe(true);
    expect(page.locationSource).toBe('json-ld+state');
  });

  it('survives a renamed flag', () => {
    // `isExactLocation` -> `hasExactLocation`: matched on the key *pattern*.
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

    // The coordinate still comes from the intact schema.org block, and the
    // flag from a regex over the wreckage.
    expect([page.lat, page.locationIsExact]).toEqual([60.9568, true]);
    expect(page.locationSource).toBe('json-ld+raw-html');
  });

  it('degrades to coordinate-only when the state blob is gone', () => {
    // Losing the flag entirely has to be visible in the data, not just a log
    // line — `locationSource` is what the quality gate reads.
    const page = parseListingPage(makePage({ state: false }), '1');

    expect(page.lat).toBe(60.9568);
    expect(page.locationIsExact).toBeNull();
    expect(page.locationSource).toBe('json-ld');
  });

  it('throws rather than returning nulls when nothing is usable', () => {
    // A blocked or captcha'd fetch must surface as an error — a row of
    // plausible nulls would be merged as though we'd looked and found
    // nothing.
    expect(() => parseListingPage('<html><body>Page not available</body></html>', '1')).toThrow(
      /no location data/,
    );
  });

  it('finds the payload in an unnamed script tag', () => {
    // The script id and even the type attribute are Airbnb renderer details;
    // a blob that merely looks like JSON is still tried.
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
    // Registration only became mandatory 2026-07-31; a listing without one
    // is a finding, not a parse failure.
    const page = parseListingPage(makePage({ registration: null }), '1');

    expect(page.strRegistrationId).toBeNull();
    expect(page.locationIsExact).toBe(true);
  });

  it('refuses to guess between conflicting numbers', () => {
    // The raw-html layer only answers when the page agrees with itself.
    const html = makePage({
      registration: null,
      description: `Permit STR20260001 or maybe STR20260002. ${'Lovely cabin. '.repeat(20)}`,
    });

    expect(parseListingPage(html, '1').strRegistrationId).toBeNull();
  });
});
