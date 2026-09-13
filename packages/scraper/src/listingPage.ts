/**
 * Read a listing's own page for fields search results lack or report
 * unreliably: whether its coordinate is exact, its municipal STR registration
 * number, its host's Airbnb user id, its room type, guest, bed, bedroom and
 * bathroom counts, and its photo gallery.
 *
 * Airbnb jitters the map pin unless the host shows the exact location. Search
 * returns a coordinate either way; the listing page's `isExactLocation` says
 * which. See `docs/research/airbnb-pdp-location-payload.md`. The registration
 * number is required in listings from 2026-07-31 under AO 2025-115(S-2). The
 * host id is the account id in `airbnb.com/users/show/<id>`, stable for the
 * life of the account; see `docs/research/airbnb-pdp-host-id.md`. Room type,
 * the counts and photos are described in
 * `docs/research/airbnb-pdp-listing-attributes.md`.
 *
 * Airbnb publishes guest capacity and bed count as integers. Room type,
 * bedrooms and bathrooms exist only as display text ("Entire home/apt",
 * "Studio", "Shared bathroom"), so they are stored verbatim rather than
 * parsed into categories or numbers.
 *
 * The page is not a documented API, so fields are extracted by three
 * independent layers. Each field takes the first layer that produces it, and
 * `locationSource` records every layer that contributed so the quality checks
 * can detect a layer that stops working:
 *
 * 1. **`json-ld`**: the schema.org `VacationRental` block Airbnb publishes for
 *    search engines. The most stable source, but has only the coordinate. Its
 *    `image` list stops at 8 photos and its `occupancy` is a bed count, so
 *    neither is read.
 * 2. **`state`**: the embedded GraphQL response, the only source of
 *    `isExactLocation` and photos. Found by searching every JSON script for an
 *    object with a boolean key matching `exact…location`, not by a fixed path,
 *    so renamed wrappers or script ids don't break it. The other fields are
 *    likewise found by key or value: the one GraphQL id that decodes to
 *    `DemandUser:<id>`, the `roomType`, `personCapacity` and `bedCount` keys,
 *    the overview `items` list, and the `mediaItems` gallery.
 * 3. **`raw-html`**: regexes over the raw document, for when the JSON does not
 *    parse. Returns nothing if a pattern matches more than one distinct value.
 */

import { request } from './airbnb/http.ts';
import { mapWithConcurrency } from './concurrency.ts';
import * as config from './config.ts';
import { scriptTags } from './html.ts';
import { describeError, log, rootCause } from './log.ts';
import { RateLimitedError } from './pace.ts';
import { withRetries } from './retry.ts';

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

// e.g. `"roomType":"Entire home/apt"` in the page's analytics context.
const RAW_ROOM_TYPE_RE_G = /"roomType"\s*:\s*"([^"]+)"/g;
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

const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': config.LANGUAGE,
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
  strRegistrationId: string | null;
  /**
   * The primary host's Airbnb user id, as a decimal string: newer ids are 19
   * digits, which a JS number would round.
   */
  hostId: string | null;
  /** Airbnb's room type, verbatim: `"Entire home/apt"`, `"Private room"`, … */
  roomType: string | null;
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

/** What one listing's page yielded. Fields no layer found are null. */
export interface ListingPage extends PageFields {
  roomId: string;
  /**
   * Which extraction layers contributed, e.g. `"json-ld+state"`. Used for logs
   * and `PageFetchStats`; not stored in the database.
   */
  locationSource: string | null;
  error: string | null;
}

export function emptyListingPage(roomId: string, error: string | null = null): ListingPage {
  return {
    roomId,
    lat: null,
    lng: null,
    locationIsExact: null,
    locationExactAddress: null,
    locationSubtitle: null,
    locationVerified: null,
    strRegistrationId: null,
    hostId: null,
    roomType: null,
    guestCapacity: null,
    beds: null,
    bedrooms: null,
    bathrooms: null,
    photoUrls: null,
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
      if (typeof value !== 'string' || !GRAPHQL_ID_RE.test(value)) continue;
      const match = HOST_USER_RE.exec(Buffer.from(value, 'base64').toString('latin1'));
      if (match) ids.add(match[1]!);
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
 * The gallery: the longest `mediaItems` list's `baseUrl`s, de-duplicated in
 * order. Null when there is none.
 */
function findPhotoUrls(doc: unknown): string[] | null {
  let best: string[] = [];
  for (const obj of iterObjects(doc)) {
    const media = obj['mediaItems'];
    if (!Array.isArray(media)) continue;
    const urls = new Set<string>();
    for (const item of media) {
      const url = typeof item === 'object' && item !== null ? (item as JsonObject)['baseUrl'] : null;
      if (typeof url === 'string' && url.startsWith('https://')) urls.add(url);
    }
    if (urls.size > best.length) best = [...urls];
  }
  return best.length > 0 ? best : null;
}

function dropNulls(fields: Partial<PageFields>): Partial<PageFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<PageFields>;
}

/** Takes each field from whichever JSON script has it. */
function fromEmbeddedState(html: string): Partial<PageFields> {
  const found: Partial<PageFields> = {};
  for (const doc of jsonScripts(html)) {
    if (found.locationIsExact === undefined) Object.assign(found, locationFrom(doc));
    if (found.strRegistrationId === undefined) {
      const registration = findRegistration(doc);
      if (registration) found.strRegistrationId = registration;
    }
    if (found.hostId === undefined) {
      const hostId = findHostId(doc);
      if (hostId) found.hostId = hostId;
    }
    Object.assign(
      found,
      dropNulls({
        roomType: found.roomType ?? soleValue(doc, 'roomType', 'string'),
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
  if (number !== null) found.strRegistrationId = `STR${number}`;
  const hostId = soleMatch(RAW_HOST_ID_RE_G, html);
  if (hostId !== null) found.hostId = hostId;
  const roomType = soleMatch(RAW_ROOM_TYPE_RE_G, html);
  if (roomType !== null) found.roomType = roomType;
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

const PAGE_FIELD_NAMES = [
  'lat',
  'lng',
  'locationIsExact',
  'locationExactAddress',
  'locationSubtitle',
  'locationVerified',
  'strRegistrationId',
  'hostId',
  'roomType',
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
export function parseListingPage(html: string, roomId: string): ListingPage {
  const byLayer: Record<Layer, Partial<PageFields>> = {
    'json-ld': fromJsonLd(html),
    state: fromEmbeddedState(html),
    'raw-html': fromRawHtml(html),
  };

  const page = emptyListingPage(roomId);
  const contributors: Layer[] = [];
  for (const layer of LAYERS) {
    let used = false;
    for (const name of PAGE_FIELD_NAMES) {
      const value = byLayer[layer][name];
      if (page[name] === null && value !== undefined && value !== null) {
        Object.assign(page, { [name]: value });
        used = true;
      }
    }
    if (used) contributors.push(layer);
  }

  if (contributors.length === 0) {
    throw new Error(`no location data in the page for room ${roomId}`);
  }

  warnOnDisagreement(byLayer, roomId);
  page.locationSource = contributors.join('+');
  return page;
}

const COMPARED_FIELDS = [
  'lat',
  'lng',
  'locationIsExact',
  'strRegistrationId',
  'hostId',
  'roomType',
  'guestCapacity',
  'beds',
  'bedrooms',
  'bathrooms',
] as const satisfies ReadonlyArray<keyof PageFields>;

/** Warn when layers disagree, which means one is matching the wrong thing. */
function warnOnDisagreement(byLayer: Record<Layer, Partial<PageFields>>, roomId: string): void {
  for (const name of COMPARED_FIELDS) {
    const reported = new Map<Layer, unknown>();
    for (const layer of LAYERS) {
      const value = byLayer[layer][name];
      if (value !== undefined && value !== null) reported.set(layer, value);
    }
    const distinct = new Set(
      [...reported.values()].map((value) =>
        typeof value === 'number' ? value.toFixed(5) : String(value),
      ),
    );
    if (distinct.size > 1) {
      const detail = [...reported].map(([layer, value]) => `${layer}=${String(value)}`).join(', ');
      log.warn(`room ${roomId}: layers disagree on ${name}: ${detail}`);
    }
  }
}

// --------------------------------------------------------------------------
// fetching

/** One listing's page. A per-listing failure is reported, not thrown. */
export type FetchOnePage = (roomId: string) => Promise<ListingPage>;

export function livePageFetcher(): FetchOnePage {
  return async (roomId) => {
    try {
      // Parsing inside the retry means a truncated or blocked page is
      // fetched again.
      return await withRetries(
        async () => {
          const html = await request(`https://www.airbnb.com/rooms/${roomId}`, {
            headers: PAGE_HEADERS,
            timeoutMs: config.PAGE_TIMEOUT_MS,
          });
          return parseListingPage(html, roomId);
        },
        {
          label: `listing page for room ${roomId}`,
          attempts: config.PAGE_MAX_RETRIES,
          backoffMs: config.RETRY_BACKOFF_MS,
        },
      );
    } catch (err) {
      // A rate limit is IP-wide, so it aborts the pass.
      if (err instanceof RateLimitedError) throw err;
      return emptyListingPage(roomId, describeError(rootCause(err)));
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
  roomIds: readonly string[],
  options: FetchListingPagesOptions,
): Promise<ListingPage[]> {
  const results = await mapWithConcurrency(
    roomIds,
    options.concurrency ?? config.PAGE_CONCURRENCY,
    (roomId) => options.fetchOne(roomId),
  );
  for (const result of results) {
    if (result.error) {
      log.warn(`listing page fetch failed for room ${result.roomId}: ${result.error}`);
    }
  }
  return results;
}
