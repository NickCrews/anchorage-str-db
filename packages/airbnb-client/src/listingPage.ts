/**
 * Read a listing's own page for fields search results lack or report
 * unreliably: whether its coordinate is exact, its municipal STR registration
 * number, its host's Airbnb user id and public profile card (`HostCard`), its
 * listing type, guest, bed, bedroom and bathroom counts, and its photo gallery.
 *
 * Airbnb jitters the map pin unless the host shows the exact location. Search
 * returns a coordinate either way; the listing page's `isExactLocation` says
 * which. See `docs/research/airbnb-pdp-location-payload.md`. The registration
 * number is required in listings from 2026-07-31 under AO 2025-115(S-2). The
 * host id is the account id in `airbnb.com/users/show/<id>`, stable for the
 * life of the account; see `docs/research/airbnb-pdp-host-id.md`. Listing type,
 * the counts and photos are described in
 * `docs/research/airbnb-pdp-listing-attributes.md`.
 *
 * Airbnb publishes guest capacity and bed count as integers. Listing type,
 * bedrooms and bathrooms exist only as display text ("Entire home/apt",
 * "Studio", "Shared bathroom"), so they are stored verbatim rather than
 * parsed into categories or numbers.
 *
 * The page is not a documented API, so fields are extracted by three
 * independent layers. Each field takes the first layer, in the order below,
 * that produces it, except the coordinate, which prefers `state` because
 * JSON-LD rounds it to 4 decimal places. `locationSource` records every layer
 * that produced a value so the quality checks can detect a layer that stops
 * working:
 *
 * 1. **`json-ld`**: the schema.org `VacationRental` block Airbnb publishes for
 *    search engines. The most stable source, but has only the coordinate,
 *    rounded to 4 decimal places. Its `image` list stops at 8 photos and its
 *    `occupancy` is a bed count, so neither is read.
 * 2. **`state`**: the embedded GraphQL response, the only source of
 *    `isExactLocation`, photos and the host card. Found by searching every JSON
 *    script for an object with a boolean key matching `exact…location`, not by
 *    a fixed path, so renamed wrappers or script ids don't break it. The other
 *    fields are likewise found by key or value: the one GraphQL id that decodes
 *    to `DemandUser:<id>`, the `roomType`, `personCapacity` and `bedCount`
 *    keys, the overview `items` list, the `mediaTour` gallery, and the host
 *    card's `timeAsHost` key.
 * 3. **`raw-html`**: regexes over the raw document, for when the JSON does not
 *    parse. Returns nothing if a pattern matches more than one distinct value.
 */

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { RateLimitedError } from '@anchorage-str-db/utils/pace';
import { withRetries } from '@anchorage-str-db/utils/retry';

import { request } from './api/http.ts';
import { scriptTags } from './html.ts';
import { pace, RETRY_BACKOFF_MS } from './pace.ts';

/** Concurrency and attempts for listing-page fetches. */
const PAGE_CONCURRENCY = 6;
const PAGE_MAX_RETRIES = 3;

/**
 * A request this slow is usually the rate limiter stalling connections, so a
 * short timeout lets the pacer lower the rate sooner.
 */
const PAGE_TIMEOUT_MS = 15_000;

// Matched against key names anywhere in the embedded JSON, so variants like
// hasExactLocation also match.
const EXACT_LOCATION_KEY_RE = /exact.*location/i;
const LAT_KEY_RE = /^lat(itude)?$/i;
const LNG_KEY_RE = /^(lng|long|longitude|longitud)$/i;
const ADDRESS_KEY_RE = /^exact.*address$/i;

// Anchorage-issued STR numbers look like "STR20261897". Hosts type them by
// hand into a free-text field, so accept lowercase and a stray separator.
const STR_NUMBER_RE = /\bSTR[\s-]?(\d{6,})\b/i;
const STR_NUMBER_RE_G = /\bSTR[\s-]?(\d{6,})\b/gi;
const REGISTRATION_TITLE_RE = /registration/i;

const RAW_FLAG_RE_G = /"\w*[eE]xact[lL]ocation\w*"\s*:\s*(true|false)/g;

// GraphQL ids are base64 of `<TypeName>:<id>`. The primary host's account is
// the page's only `DemandUser`; co-hosts are `ContextualUser`s, whose ids are
// a different number space.
const GRAPHQL_ID_RE = /^[A-Za-z0-9+/]{12,}={0,2}$/;
const HOST_USER_RE = /^DemandUser:(\d+)$/;
// The decimal host id in the page's analytics context, e.g. `"hostId":"3682901"`.
const RAW_HOST_ID_RE_G = /"host_?id"\s*:\s*"?(\d+)/gi;

// Airbnb's key is `roomType`; we store it as `listingType`.
// e.g. `"roomType":"Entire home/apt"` in the page's analytics context.
const RAW_LISTING_TYPE_RE_G = /"roomType"\s*:\s*"([^"]+)"/g;
const RAW_PERSON_CAPACITY_RE_G = /"personCapacity"\s*:\s*(\d+)/g;
const RAW_BED_COUNT_RE_G = /"bedCount"\s*:\s*(\d+)/g;
// The overview's `"items":["5 guests","2 bedrooms","3 beds","1 bath"]`.
const RAW_STRING_LIST_RE_G = /"items"\s*:\s*(\["(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\])/g;

// Which overview line is which. Only the line is picked out; its text is
// stored as is.
const BATHROOM_LINE_RE = /\bbath/i;
const BEDROOM_LINE_RE = /\bbedroom|\bstudio\b/i;

/** The first string in `items` matching `pattern`. */
function overviewLine(items: readonly unknown[], pattern: RegExp): string | null {
  for (const item of items) {
    if (typeof item === 'string' && pattern.test(item)) return item.trim();
  }
  return null;
}

// The host card is the only object on the page with a `timeAsHost` key. There
// is no raw-html fallback: the bio cannot be read reliably from undecoded
// HTML, and a card without it would record "no bio" as a fact.
const TIME_AS_HOST_KEY_RE = /^time_?as_?host$/i;
const USER_ID_KEY_RE = /^user_?id$/i;
// `UGCText` members, most preferred first: the text as the host wrote it,
// then Airbnb's rendering of it.
const BIO_TEXT_KEYS = ['source', 'localizedString', 'localizedStringWithTranslationPreference'];

const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en',
};

/** The fields the three layers compete to fill. */
export interface PageFields {
  lat: number | null;
  lng: number | null;
  /** Airbnb's `isExactLocation`: whether `lat`/`lng` is exact or jittered. */
  locationIsExact: boolean | null;
  /** Set only when the host publishes a street address; null for most. */
  locationExactAddress: string | null;
  locationSubtitle: string | null;
  locationVerified: boolean | null;
  registrationId: string | null;
  /**
   * The primary host's Airbnb user id, as a decimal string: newer ids are 19
   * digits, which a JS number would round.
   */
  hostId: string | null;
  /** Airbnb's `roomType`, verbatim: `"Entire home/apt"`, `"Private room"`, … */
  listingType: string | null;
  /** Airbnb's `personCapacity`: the most guests the listing allows. */
  guestCapacity: number | null;
  /** Airbnb's `bedCount`. A bunk bed counts as 2. */
  beds: number | null;
  /** The overview's bedroom line, verbatim: `"2 bedrooms"`, `"Studio"`. */
  bedrooms: string | null;
  /** The overview's bathroom line, verbatim: `"1.5 baths"`, `"Shared bathroom"`. */
  bathrooms: string | null;
  /** The gallery's image URLs in the host's order; the first is the cover photo. */
  photoUrls: string[] | null;
}

/**
 * The public profile card of the listing's primary host, at
 * `pdpPresentation.hostInfo` in the embedded state:
 *
 *     hostInfo.passportData.{name, userId, timeAsHost{years, months}}
 *     hostInfo.about -> UGCText{source, localizedString, ...} | null
 *
 * See `docs/research/airbnb-pdp-host-id.md`.
 */
export interface HostCard {
  /** The account the card names, decoded from `userId`. Checked against `ListingPage.hostId`. */
  hostId: string | null;
  /** The display name: a first name or a business name. Airbnb shows no surnames. */
  name: string;
  /** The bio as the host wrote it. Null when the card's `about` is null. */
  about: string | null;
  /**
   * Airbnb's `timeAsHost` as of the day the page was read. The "Years
   * hosting" badge beside it is rounded (9 years 7 months shows as 10), so
   * it is not used.
   */
  timeAsHostYears: number | null;
  timeAsHostMonths: number | null;
}

/** What one listing's page yielded. Fields no layer found are null. */
export interface ListingPage extends PageFields {
  listingId: string;
  /** Only the `state` layer yields a card. Null if absent, ambiguous, or for another account. */
  hostCard: HostCard | null;
  /**
   * Which extraction layers produced a value, e.g. `"json-ld+state"`, whether
   * or not that value was the one kept. Used for logs
   * and `PageFetchStats`; not stored in the database.
   */
  locationSource: string | null;
  error: string | null;
}

export function emptyListingPage(listingId: string, error: string | null = null): ListingPage {
  return {
    listingId,
    lat: null,
    lng: null,
    locationIsExact: null,
    locationExactAddress: null,
    locationSubtitle: null,
    locationVerified: null,
    registrationId: null,
    hostId: null,
    listingType: null,
    guestCapacity: null,
    beds: null,
    bedrooms: null,
    bathrooms: null,
    photoUrls: null,
    hostCard: null,
    locationSource: null,
    error,
  };
}

type JsonObject = Record<string, unknown>;

// --------------------------------------------------------------------------
// tree walking

/** Every object anywhere in a decoded JSON document, depth-first. */
function* iterObjects(node: unknown): Generator<JsonObject> {
  if (Array.isArray(node)) {
    for (const value of node) yield* iterObjects(value);
  } else if (typeof node === 'object' && node !== null) {
    yield node as JsonObject;
    for (const value of Object.values(node)) yield* iterObjects(value);
  }
}

/**
 * The value of the first key matching `pattern` whose value has type `kind`.
 * Checking the type keeps, say, a boolean from answering a numeric lookup.
 */
function firstKey(obj: JsonObject, pattern: RegExp, kind: 'number'): number | null;
function firstKey(obj: JsonObject, pattern: RegExp, kind: 'boolean'): boolean | null;
function firstKey(obj: JsonObject, pattern: RegExp, kind: 'string'): string | null;
function firstKey(
  obj: JsonObject,
  pattern: RegExp,
  kind: 'number' | 'boolean' | 'string',
): number | boolean | string | null {
  for (const [key, value] of Object.entries(obj)) {
    if (!pattern.test(key)) continue;
    if (typeof value === kind) return value as number | boolean | string;
  }
  return null;
}

/**
 * Every parseable JSON `<script>`, largest first. The wanted payload is the
 * largest, so this finds it without depending on its script id.
 */
function* jsonScripts(html: string): Generator<unknown> {
  const candidates = scriptTags(html).filter(
    // By declared type, or by content that starts like a JSON object.
    (tag) => tag.type.includes('json') || tag.text.trimStart().startsWith('{'),
  );
  candidates.sort((a, b) => b.text.length - a.text.length);
  for (const tag of candidates) {
    try {
      yield JSON.parse(tag.text);
    } catch {
      continue;
    }
  }
}

// --------------------------------------------------------------------------
// layer 1: schema.org JSON-LD

/** The `VacationRental` block Airbnb publishes for search engines. */
function fromJsonLd(html: string): Partial<PageFields> {
  for (const tag of scriptTags(html)) {
    if (tag.type !== 'application/ld+json') continue;
    let doc: unknown;
    try {
      doc = JSON.parse(tag.text);
    } catch {
      continue;
    }
    for (const obj of iterObjects(doc)) {
      if (typeof obj['latitude'] !== 'number' || typeof obj['longitude'] !== 'number') continue;
      // Only the coordinate: JSON-LD's `addressLocality` is a bare town name,
      // not the "Anchorage, Alaska, United States" form `locationSubtitle`
      // holds.
      return { lat: obj['latitude'], lng: obj['longitude'] };
    }
  }
  return {};
}

// --------------------------------------------------------------------------
// layer 2: the embedded GraphQL state, located by shape

/**
 * The number appears as a list item titled "Registration…" and in the long
 * description. Prefer the titled item; fall back to long text.
 */
function findRegistration(doc: unknown): string | null {
  const prose = new Set<string>();
  for (const obj of iterObjects(doc)) {
    const title = obj['title'];
    if (typeof title === 'string' && REGISTRATION_TITLE_RE.test(title)) {
      for (const nested of iterObjects(obj)) {
        for (const text of Object.values(nested)) {
          if (typeof text !== 'string') continue;
          const match = STR_NUMBER_RE.exec(text);
          if (match) return `STR${match[1]}`;
        }
      }
    }
    for (const value of Object.values(obj)) {
      if (typeof value !== 'string' || value.length <= 200) continue;
      for (const match of value.matchAll(STR_NUMBER_RE_G)) prose.add(match[1]!);
    }
  }
  // Prose naming more than one distinct number is ambiguous, so it yields
  // nothing (the same rule as `soleMatch`).
  return prose.size === 1 ? `STR${[...prose][0]}` : null;
}

function locationFrom(doc: unknown): Partial<PageFields> {
  for (const obj of iterObjects(doc)) {
    const flag = firstKey(obj, EXACT_LOCATION_KEY_RE, 'boolean');
    if (flag === null) continue;
    const verification = obj['verificationDetails'];
    const verified =
      typeof verification === 'object' && verification !== null
        ? (verification as JsonObject)['isVerified']
        : undefined;
    const subtitle = obj['subtitle'];
    const found: Partial<PageFields> = {
      locationIsExact: flag,
      lat: firstKey(obj, LAT_KEY_RE, 'number'),
      lng: firstKey(obj, LNG_KEY_RE, 'number'),
      locationExactAddress: firstKey(obj, ADDRESS_KEY_RE, 'string'),
      locationSubtitle: typeof subtitle === 'string' ? subtitle : null,
      locationVerified: typeof verified === 'boolean' ? verified : null,
    };
    return dropNulls(found);
  }
  return {};
}

/**
 * The id of the page's one `DemandUser`, or null if there is none or more
 * than one distinct id.
 */
function findHostId(doc: unknown): string | null {
  const ids = new Set<string>();
  for (const obj of iterObjects(doc)) {
    for (const value of Object.values(obj)) {
      const id = decodeHostUserId(value);
      if (id) ids.add(id);
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** The one distinct value of `key` of type `kind` anywhere in `doc`, else null. */
function soleValue(doc: unknown, key: string, kind: 'string'): string | null;
function soleValue(doc: unknown, key: string, kind: 'number'): number | null;
function soleValue(doc: unknown, key: string, kind: 'string' | 'number'): string | number | null {
  const values = new Set<string | number>();
  for (const obj of iterObjects(doc)) {
    const value = obj[key];
    if (typeof value === kind) values.add(value as string | number);
  }
  return values.size === 1 ? [...values][0]! : null;
}

/** The one distinct overview line matching `pattern` across every `items` string list. */
function findOverviewLine(doc: unknown, pattern: RegExp): string | null {
  const lines = new Set<string>();
  for (const obj of iterObjects(doc)) {
    const items = obj['items'];
    if (!Array.isArray(items)) continue;
    const line = overviewLine(items, pattern);
    if (line !== null) lines.add(line);
  }
  return lines.size === 1 ? [...lines][0]! : null;
}

/**
 * The gallery: the longest `mediaTour`'s image URIs, across its `stops` (one
 * per room) in order, de-duplicated. Null when there is none.
 */
function findPhotoUrls(doc: unknown): string[] | null {
  let best: string[] = [];
  for (const obj of iterObjects(doc)) {
    const tour = obj['mediaTour'];
    if (!isObject(tour) || !Array.isArray(tour['stops'])) continue;
    const urls = new Set<string>();
    for (const stop of tour['stops']) {
      const items = isObject(stop) ? stop['items'] : null;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const image = isObject(item) ? item['image'] : null;
        const uri = isObject(image) ? image['uri'] : null;
        if (typeof uri === 'string' && uri.startsWith('https://')) urls.add(uri);
      }
    }
    if (urls.size > best.length) best = [...urls];
  }
  return best.length > 0 ? best : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-negative integer, or null. */
function asCount(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/** The `DemandUser` id a GraphQL id decodes to, or null. */
function decodeHostUserId(value: unknown): string | null {
  if (typeof value !== 'string' || !GRAPHQL_ID_RE.test(value)) return null;
  return HOST_USER_RE.exec(Buffer.from(value, 'base64').toString('latin1'))?.[1] ?? null;
}

/** The value of the first key matching `pattern` that holds an object. */
function objectKey(obj: JsonObject, pattern: RegExp): JsonObject | null {
  for (const [key, value] of Object.entries(obj)) {
    if (pattern.test(key) && isObject(value)) return value;
  }
  return null;
}

/**
 * A card from the passport object and the `about` beside it, or null if
 * either has an unrecognized shape. An `about` object with no known text
 * member is a reshaped bio, not a missing one, so it yields no card rather
 * than recording "no bio".
 */
function hostCardFrom(passport: JsonObject, about: unknown): HostCard | null {
  const name = passport['name'];
  if (typeof name !== 'string' || !name.trim()) return null;
  let bio: string | null;
  if (about === null) {
    bio = null;
  } else if (isObject(about)) {
    const text = BIO_TEXT_KEYS.map((key) => about[key]).find((value) => typeof value === 'string');
    if (typeof text !== 'string') return null;
    bio = text.trim() ? text : null;
  } else {
    return null;
  }
  const tenure = objectKey(passport, TIME_AS_HOST_KEY_RE) ?? {};
  const userIdKey = Object.keys(passport).find((key) => USER_ID_KEY_RE.test(key));
  return {
    hostId: userIdKey === undefined ? null : decodeHostUserId(passport[userIdKey]),
    name: name.trim(),
    about: bio,
    timeAsHostYears: asCount(tenure['years']),
    timeAsHostMonths: asCount(tenure['months']),
  };
}

/**
 * The host card, found by shape: an object holding a `timeAsHost` object (the
 * passport) whose parent has an `about` key. Requiring the `about` key, even
 * when its value is null, is what makes "no bio" trustworthy. Two distinct
 * cards yield null.
 */
function findHostCard(doc: unknown): HostCard | null {
  const cards = new Map<string, HostCard>();
  for (const obj of iterObjects(doc)) {
    if (!('about' in obj)) continue;
    for (const value of Object.values(obj)) {
      if (!isObject(value) || objectKey(value, TIME_AS_HOST_KEY_RE) === null) continue;
      const card = hostCardFrom(value, obj['about']);
      if (card) cards.set(JSON.stringify(card), card);
    }
  }
  return cards.size === 1 ? [...cards.values()][0]! : null;
}

function dropNulls(fields: Partial<PageFields>): Partial<PageFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<PageFields>;
}

/** The host card from whichever JSON script has one. */
function hostCardFromState(html: string): HostCard | null {
  for (const doc of jsonScripts(html)) {
    const card = findHostCard(doc);
    if (card) return card;
  }
  return null;
}

/** Takes each field from whichever JSON script has it. */
function fromEmbeddedState(html: string): Partial<PageFields> {
  const found: Partial<PageFields> = {};
  for (const doc of jsonScripts(html)) {
    if (found.locationIsExact === undefined) Object.assign(found, locationFrom(doc));
    if (found.registrationId === undefined) {
      const registration = findRegistration(doc);
      if (registration) found.registrationId = registration;
    }
    if (found.hostId === undefined) {
      const hostId = findHostId(doc);
      if (hostId) found.hostId = hostId;
    }
    Object.assign(
      found,
      dropNulls({
        listingType: found.listingType ?? soleValue(doc, 'roomType', 'string'),
        guestCapacity: found.guestCapacity ?? soleValue(doc, 'personCapacity', 'number'),
        beds: found.beds ?? soleValue(doc, 'bedCount', 'number'),
        bedrooms: found.bedrooms ?? findOverviewLine(doc, BEDROOM_LINE_RE),
        bathrooms: found.bathrooms ?? findOverviewLine(doc, BATHROOM_LINE_RE),
        photoUrls: found.photoUrls ?? findPhotoUrls(doc),
      }),
    );
  }
  return found;
}

// --------------------------------------------------------------------------
// layer 3: regex over the undecoded document

/**
 * The captured value if the whole document yields exactly one distinct
 * value, else null, since these patterns can match unrelated text.
 */
function soleMatch(pattern: RegExp, html: string): string | null {
  const values = new Set<string>();
  for (const match of html.matchAll(pattern)) values.add(match[1]!);
  return values.size === 1 ? [...values][0]! : null;
}

function fromRawHtml(html: string): Partial<PageFields> {
  const found: Partial<PageFields> = {};
  const flag = soleMatch(RAW_FLAG_RE_G, html);
  if (flag !== null) found.locationIsExact = flag === 'true';
  const number = soleMatch(STR_NUMBER_RE_G, html);
  if (number !== null) found.registrationId = `STR${number}`;
  const hostId = soleMatch(RAW_HOST_ID_RE_G, html);
  if (hostId !== null) found.hostId = hostId;
  const listingType = soleMatch(RAW_LISTING_TYPE_RE_G, html);
  if (listingType !== null) found.listingType = listingType;
  const capacity = soleMatch(RAW_PERSON_CAPACITY_RE_G, html);
  if (capacity !== null) found.guestCapacity = Number(capacity);
  const beds = soleMatch(RAW_BED_COUNT_RE_G, html);
  if (beds !== null) found.beds = Number(beds);
  const lists: unknown[][] = [];
  for (const match of html.matchAll(RAW_STRING_LIST_RE_G)) {
    try {
      const items: unknown = JSON.parse(match[1]!);
      if (Array.isArray(items)) lists.push(items);
    } catch {
      continue;
    }
  }
  const soleLine = (pattern: RegExp): string | null => {
    const lines = new Set(lists.map((items) => overviewLine(items, pattern)).filter((l) => l !== null));
    return lines.size === 1 ? [...lines][0]! : null;
  };
  const bedrooms = soleLine(BEDROOM_LINE_RE);
  if (bedrooms !== null) found.bedrooms = bedrooms;
  const bathrooms = soleLine(BATHROOM_LINE_RE);
  if (bathrooms !== null) found.bathrooms = bathrooms;
  return found;
}

// --------------------------------------------------------------------------

export const LAYERS = ['json-ld', 'state', 'raw-html'] as const;
export type Layer = (typeof LAYERS)[number];

/** Layer order for `lat`/`lng`, which are taken as a pair from one layer. */
const COORDINATE_LAYERS = ['state', 'json-ld', 'raw-html'] as const satisfies readonly Layer[];

/**
 * Layers' coordinates further apart than this are reported as a disagreement.
 * JSON-LD's rounding to 4 decimal places moves a point at most about 6 m at
 * Anchorage's latitude.
 */
const COORDINATE_TOLERANCE_M = 25;

const PAGE_FIELD_NAMES = [
  'lat',
  'lng',
  'locationIsExact',
  'locationExactAddress',
  'locationSubtitle',
  'locationVerified',
  'registrationId',
  'hostId',
  'listingType',
  'guestCapacity',
  'beds',
  'bedrooms',
  'bathrooms',
  'photoUrls',
] as const satisfies ReadonlyArray<keyof PageFields>;

/**
 * Extract every field available, recording which layers contributed.
 *
 * Throws if no layer produced anything, which indicates a blocked or
 * redirected fetch rather than a listing with no data.
 */
export function parseListingPage(html: string, listingId: string): ListingPage {
  const byLayer: Record<Layer, Partial<PageFields>> = {
    'json-ld': fromJsonLd(html),
    state: fromEmbeddedState(html),
    'raw-html': fromRawHtml(html),
  };

  const page = emptyListingPage(listingId);
  for (const name of PAGE_FIELD_NAMES) {
    if (name === 'lat' || name === 'lng') continue;
    for (const layer of LAYERS) {
      const value = byLayer[layer][name];
      if (value !== undefined && value !== null) {
        Object.assign(page, { [name]: value });
        break;
      }
    }
  }
  const coordinate = coordinatesByLayer(byLayer).sort(
    (a, b) => COORDINATE_LAYERS.indexOf(a.layer) - COORDINATE_LAYERS.indexOf(b.layer),
  )[0];
  if (coordinate) {
    page.lat = coordinate.lat;
    page.lng = coordinate.lng;
  }

  const contributors = LAYERS.filter((layer) =>
    PAGE_FIELD_NAMES.some((name) => byLayer[layer][name] !== undefined && byLayer[layer][name] !== null),
  );

  if (contributors.length === 0) {
    throw new Error(`no location data in the page for listing ${listingId}`);
  }

  warnOnDisagreement(byLayer, listingId);
  page.locationSource = contributors.join('+');
  page.hostCard = checkedHostCard(hostCardFromState(html), page.hostId, listingId);
  return page;
}

const COMPARED_FIELDS = [
  'locationIsExact',
  'registrationId',
  'hostId',
  'listingType',
  'guestCapacity',
  'beds',
  'bedrooms',
  'bathrooms',
] as const satisfies ReadonlyArray<keyof PageFields>;

/**
 * The card, unless it names an account other than the listing's host, in
 * which case filing it under the host would record a stranger's profile.
 */
function checkedHostCard(
  card: HostCard | null,
  hostId: string | null,
  listingId: string,
): HostCard | null {
  if (card !== null && card.hostId !== null && hostId !== null && card.hostId !== hostId) {
    log.warn(
      `listing ${listingId}: host card is for account ${card.hostId} but the listing's host is ` +
        `${hostId}; not recording the card`,
    );
    return null;
  }
  return card;
}

/**
 * One card per distinct host, from a run's listing pages. A host with twelve
 * listings was read twelve times; readings should match, since they are the
 * same account read minutes apart. If they differ (a profile edited mid-run,
 * or `timeAsHost` crossing a month), the lowest listing id's reading wins so a
 * re-run records the same thing.
 */
export function collectHostCards(pages: readonly ListingPage[]): Map<string, HostCard> {
  const readings = new Map<string, Array<{ listingId: bigint; card: HostCard }>>();
  for (const page of pages) {
    if (page.error || page.hostId === null || page.hostCard === null) continue;
    const list = readings.get(page.hostId) ?? [];
    list.push({ listingId: BigInt(page.listingId), card: page.hostCard });
    readings.set(page.hostId, list);
  }
  const cards = new Map<string, HostCard>();
  for (const [hostId, seen] of readings) {
    seen.sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0));
    if (new Set(seen.map(({ card }) => JSON.stringify(card))).size > 1) {
      log.warn(
        `host ${hostId}: ${seen.length} listing pages disagree about the host card; ` +
          `keeping listing ${seen[0]!.listingId}'s`,
      );
    }
    cards.set(hostId, seen[0]!.card);
  }
  return cards;
}

interface LayerCoordinate {
  layer: Layer;
  lat: number;
  lng: number;
}

/** Each layer's coordinate, for layers that produced both `lat` and `lng`. */
function coordinatesByLayer(byLayer: Record<Layer, Partial<PageFields>>): LayerCoordinate[] {
  return LAYERS.flatMap((layer) => {
    const { lat, lng } = byLayer[layer];
    return typeof lat === 'number' && typeof lng === 'number' ? [{ layer, lat, lng }] : [];
  });
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters (haversine). */
function distanceMeters(a: LayerCoordinate, b: LayerCoordinate): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Warn when layers disagree, which means one is matching the wrong thing. */
function warnOnDisagreement(byLayer: Record<Layer, Partial<PageFields>>, listingId: string): void {
  for (const name of COMPARED_FIELDS) {
    const reported = new Map<Layer, unknown>();
    for (const layer of LAYERS) {
      const value = byLayer[layer][name];
      if (value !== undefined && value !== null) reported.set(layer, value);
    }
    if (new Set([...reported.values()].map(String)).size > 1) {
      const detail = [...reported].map(([layer, value]) => `${layer}=${String(value)}`).join(', ');
      log.warn(`listing ${listingId}: layers disagree on ${name}: ${detail}`);
    }
  }

  const coordinates = coordinatesByLayer(byLayer);
  const spread = Math.max(
    0,
    ...coordinates.flatMap((a, i) => coordinates.slice(i + 1).map((b) => distanceMeters(a, b))),
  );
  if (spread > COORDINATE_TOLERANCE_M) {
    const detail = coordinates.map(({ layer, lat, lng }) => `${layer}=(${lat}, ${lng})`).join(', ');
    log.warn(
      `listing ${listingId}: layers disagree on the coordinate by ${Math.round(spread)} m: ${detail}`,
    );
  }
}

// --------------------------------------------------------------------------
// fetching

/** One listing's page. A per-listing failure is reported, not thrown. */
export type FetchOnePage = (listingId: string) => Promise<ListingPage>;

export function livePageFetcher(): FetchOnePage {
  return async (listingId) => {
    try {
      // Parsing inside the retry means a truncated or blocked page is
      // fetched again.
      return await withRetries(
        async () => {
          const html = await request(`https://www.airbnb.com/rooms/${listingId}`, {
            headers: PAGE_HEADERS,
            timeoutMs: PAGE_TIMEOUT_MS,
          });
          return parseListingPage(html, listingId);
        },
        {
          label: `listing page for listing ${listingId}`,
          attempts: PAGE_MAX_RETRIES,
          backoffMs: RETRY_BACKOFF_MS,
          pacer: pace(),
        },
      );
    } catch (err) {
      // A rate limit is IP-wide, so it aborts the pass.
      if (err instanceof RateLimitedError) throw err;
      return emptyListingPage(listingId, describeError(rootCause(err)));
    }
  };
}

export interface FetchListingPagesOptions {
  fetchOne: FetchOnePage;
  concurrency?: number;
}

/**
 * Fetch every listing's page. The request rate is set by `pace.ts`;
 * `concurrency` only caps open connections.
 */
export async function fetchListingPages(
  listingIds: readonly string[],
  options: FetchListingPagesOptions,
): Promise<ListingPage[]> {
  const results = await mapWithConcurrency(
    listingIds,
    options.concurrency ?? PAGE_CONCURRENCY,
    (listingId) => options.fetchOne(listingId),
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`listing page fetch failed for listing ${result.listingId}: ${result.error}`);
    }
  }
  return results;
}
