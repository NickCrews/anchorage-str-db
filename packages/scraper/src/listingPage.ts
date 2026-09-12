/**
 * Read a listing's own page for the two things search results don't carry:
 * whether its coordinate is real, and its municipal STR registration number.
 *
 * ## Why this module exists
 *
 * Airbnb jitters the map pin for listings whose host hasn't opted into
 * showing the exact spot. The search endpoint gives us a `(lat, lng)` either
 * way and never says which case it is — but the listing page does, via an
 * `isExactLocation` boolean. Roughly half of Anchorage listings publish a
 * real coordinate; see `docs/research/airbnb-pdp-location-payload.md`.
 *
 * The page also carries the Municipality of Anchorage STR registration
 * number (AO 2025-115(S-2), required in listings from 2026-07-31).
 *
 * ## Why it's built in layers
 *
 * None of this is a documented API, so the parse is written as three
 * independent extraction layers, tried in order, rather than one path into
 * one blob. Each field takes the first layer that produces it, and every
 * layer that contributed is recorded in `locationSource`, which the run's
 * data-quality gate reads (via `PageFetchStats`) so a silent degradation
 * fails the run instead of only leaving a log line:
 *
 * 1. **`json-ld`** — the schema.org `VacationRental` block Airbnb publishes
 *    for Google rich results. A public standard, load-bearing for their SEO,
 *    and by far the least likely thing on the page to change shape. Carries
 *    the coordinate, but not `isExactLocation`.
 * 2. **`state`** — the server-rendered GraphQL response embedded in a
 *    `<script type="application/json">`. This has every field, and is the
 *    only source for `isExactLocation`. Located by *shape* — we search every
 *    JSON script for an object that has a boolean key matching
 *    `exact…location` — rather than by walking a hardcoded path like
 *    `niobeClientData[0][1].data.node.pdpPresentation.location`, so a
 *    reshuffle of the surrounding structure (or a renamed script id, or a
 *    renamed wrapper) doesn't break it. Only renaming the leaf fields does.
 * 3. **`raw-html`** — regexes over the undecoded document. Survives the JSON
 *    failing to parse at all. Deliberately refuses to guess: if a pattern
 *    matches more than one distinct value anywhere in the page, it returns
 *    nothing rather than picking one.
 */

import { request } from './airbnb/http.ts';
import { mapWithConcurrency } from './concurrency.ts';
import * as config from './config.ts';
import { scriptTags } from './html.ts';
import { describeError, log, rootCause } from './log.ts';
import { RateLimitedError } from './pace.ts';
import { withRetries } from './retry.ts';

// Matched against *key names* in the embedded JSON, not against a fixed
// path — survives isExactLocation -> hasExactLocation and friends.
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

const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': config.LANGUAGE,
};

/** The fields the three layers compete to fill. */
export interface PageFields {
  lat: number | null;
  lng: number | null;
  /**
   * Airbnb's own flag (`isExactLocation`) for whether `lat`/`lng` is the
   * listing's true position or the obfuscated pin. The reason this module
   * exists.
   */
  locationIsExact: boolean | null;
  /**
   * Populated only for listings publishing a street address outright; null
   * on most listings measured so far, but cheap to carry.
   */
  locationExactAddress: string | null;
  locationSubtitle: string | null;
  locationVerified: boolean | null;
  strRegistrationId: string | null;
}

/**
 * What one listing's page told us. Every field is optional: a layer that
 * can't find something leaves it null rather than guessing, and
 * `locationSource` records which layers actually contributed.
 */
export interface ListingPage extends PageFields {
  roomId: string;
  /**
   * Which extraction layers contributed, e.g. `"json-ld+state"`. Provenance
   * about the parse, not the listing: it feeds logs and the run's
   * `PageFetchStats`, and is not persisted to the database.
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
 * The value of the first key matching `pattern` that holds the wanted type.
 *
 * Type-checking the value matters as much as matching the key: an object can
 * carry both a `latitude` number and a `latitudeDelta`, and a run asking for
 * a coordinate must not be answered by `isExactLocation`.
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
 * Every parseable JSON `<script>`, biggest first.
 *
 * Not selecting `#data-deferred-state-0` by id on purpose — the id is an
 * implementation detail of Airbnb's renderer. The payload we want is always
 * the largest JSON blob on the page, so trying them in size order finds it
 * first without naming it.
 */
function* jsonScripts(html: string): Generator<unknown> {
  const candidates = scriptTags(html).filter(
    // By declared type, or — if Airbnb drops the attribute — by the content
    // simply looking like a JSON document.
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
      // Only the coordinate. JSON-LD's `addressLocality` is a bare town name
      // where `locationSubtitle` is a full "Anchorage, Alaska, United
      // States" — taking it here would silently change what that column
      // means depending on which layer won.
      return { lat: obj['latitude'], lng: obj['longitude'] };
    }
  }
  return {};
}

// --------------------------------------------------------------------------
// layer 2: the embedded GraphQL state, located by shape

/**
 * The number appears twice: as a titled list item (clean — the value is the
 * whole string) and inlined at the end of the long description. Prefer the
 * titled item, fall back to any long text that mentions one.
 */
function findRegistration(doc: unknown): string | null {
  const prose = new Set<string>();
  for (const obj of iterObjects(doc)) {
    const title = obj['title'];
    if (typeof title === 'string' && REGISTRATION_TITLE_RE.test(title)) {
      // A field Airbnb itself labels "Registration…" is authoritative.
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
  // Unlabelled prose only counts if it says one thing. A description naming
  // two different numbers (a host who manages several units, say) is
  // ambiguous, and picking the first would be a coin flip recorded as a fact
  // — the same rule `soleMatch` applies to the raw-html layer.
  return prose.size === 1 ? `STR${[...prose][0]}` : null;
}

function locationFrom(doc: unknown): Partial<PageFields> {
  for (const obj of iterObjects(doc)) {
    const flag = firstKey(obj, EXACT_LOCATION_KEY_RE, 'boolean');
    if (flag === null) continue;
    // Whatever this object is called now, it's the location object.
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

function dropNulls(fields: Partial<PageFields>): Partial<PageFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<PageFields>;
}

/**
 * Accumulate across every JSON script rather than committing to one.
 *
 * The location object and the registration item live in the same blob today,
 * but nothing guarantees they always will, so each is taken from whichever
 * script has it.
 */
function fromEmbeddedState(html: string): Partial<PageFields> {
  const found: Partial<PageFields> = {};
  for (const doc of jsonScripts(html)) {
    if (found.locationIsExact === undefined) Object.assign(found, locationFrom(doc));
    if (found.strRegistrationId === undefined) {
      const registration = findRegistration(doc);
      if (registration) found.strRegistrationId = registration;
    }
  }
  return found;
}

// --------------------------------------------------------------------------
// layer 3: regex over the undecoded document

/**
 * A value only if the page agrees with itself about it.
 *
 * Every one of these patterns can in principle match something unrelated.
 * Rather than take the first hit, take the hit only when the whole document
 * yields exactly one distinct value — otherwise we'd be inventing a
 * coordinate or a permit number out of a coincidence.
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
] as const satisfies ReadonlyArray<keyof PageFields>;

/**
 * Extract what we can, recording which layers it came from.
 *
 * Throws only if *no* layer produced anything — that means a blocked,
 * redirected, or captcha'd fetch, which must surface as an error rather than
 * as a row of plausible-looking nulls.
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
        // Each field is written from the layer that declares it, so the
        // narrowing is per-field rather than across the union.
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

/**
 * Layers reading different parts of the page should agree. If they don't,
 * one of them has started matching the wrong thing — which is exactly the
 * failure mode a single-path parser hides.
 */
function warnOnDisagreement(byLayer: Record<Layer, Partial<PageFields>>, roomId: string): void {
  for (const name of ['lat', 'lng', 'locationIsExact', 'strRegistrationId'] as const) {
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
      // A bad body is this listing's problem alone, so the parse sits inside
      // the retry: a truncated or captcha'd page is worth asking for again.
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
      // A rate limit is IP-wide, not this listing's problem, and aborts the
      // whole pass rather than being recorded as one failed row.
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
 * Fetch every listing's page, capped concurrency, globally paced.
 *
 * The pacing is not this function's business — it belongs to the run-wide
 * budget in `pace.ts`, because Airbnb counts the search, this pass and the
 * calendar pass against one per-IP total. `PAGE_CONCURRENCY` is only a cap
 * on how many sockets are open at once.
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
