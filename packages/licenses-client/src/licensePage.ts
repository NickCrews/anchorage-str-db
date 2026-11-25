/**
 * The Muni's CityView license status page for one license, e.g.
 * https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B
 *
 * Every license type has one: Short-Term Rentals, Business (private
 * detectives) and Alcohol among them. An STR license's page has fields the
 * ArcGIS registration layer lacks: the licensee's description of the
 * business ("Provides short term rentals, logistics, meeting space and
 * overnight lodging."), parcel ids, the license type, and every certificate
 * issued under the license.
 *
 * Fields are found by the text a reader sees, not by element ids or CSS
 * classes: a summary value by its label ("Business Name:"), a section by its
 * heading ("Locations"), an issuance column by its header ("Date Issued").
 * A label, heading or column that is missing throws, so a markup change
 * fails the read instead of storing NULLs. `test/licensePage.test.ts` reads
 * real pages covering each case below.
 *
 * Text is stored as the page shows it: entities decoded, leading and
 * trailing whitespace trimmed, and line breaks and repeated spaces inside a
 * description kept.
 *
 * A hidden license id returns HTTP 200 with an "Invalid License" page headed
 * "License Not Found", which parses to a `HiddenLicensePage`.
 */

import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

import { mapWithinBudget } from '@anchorage-str-db/utils/concurrency';
import type { IsoDate } from '@anchorage-str-db/utils/dates';
import { fetchCookies, fetchText } from '@anchorage-str-db/utils/http';
import { describeError, log, rootCause } from '@anchorage-str-db/utils/log';
import { Pacer } from '@anchorage-str-db/utils/pace';
import { withRetries } from '@anchorage-str-db/utils/retry';

/**
 * One item of the page's Locations section.
 *
 * A value the portal links to its property search (`link` set) comes from
 * the Muni's property records: `Property` is a parcel id, and `Address` is
 * that record's address in the Muni's parcel-address style (all caps, units
 * as `Unit:APT 1`). The ArcGIS layer's `Location` is the same string. An
 * unlinked value is text the registrant typed that matched no property
 * record, such as `525 w 3rd Ave #501, anchorage AK 99501`; it usually has no
 * label, and the registration then has no parcel id.
 */
export interface LicenseLocation {
  /**
   * The label shown before the value: `Property`, `Address`, or null. The
   * portal prints its own error here when its property lookup fails on the
   * address (license 13966: an apostrophe in WENDY'S WAY).
   */
  label: string | null;
  value: string;
  /** The portal's property search URL the value links to; null for typed text. */
  link: string | null;
}

export interface LicenseIssuance {
  /** `STR Certificate`. */
  type: string | null;
  issuedDate: IsoDate | null;
  expiresDate: IsoDate | null;
  status: string | null;
  /** The registration id, `STR20260309`. */
  number: string | null;
}

/**
 * One row of the Submittals table. The portal shows no date column; the date
 * is the one it writes at the end of the name.
 */
export interface LicenseSubmittal {
  /**
   * As shown, the portal's sequence number, type and date:
   * `1 Private Detective 10/13/2026`, or `1 06/06/2023` when the type is empty.
   */
  name: string | null;
  /** `Private Detective`. */
  type: string | null;
  /** The `MM/DD/YYYY` date ending `name`; null when it ends in none. */
  date: IsoDate | null;
  /** `Pending`. */
  status: string | null;
}

export interface LicensePage {
  hidden: false;
  /** CityView's own row id, from the `licenseId` in the page's URL. */
  cityviewLicenseId: number;
  /**
   * `LC260500349`, the license's own id, which the page labels "Licensee
   * Number" and the registration layer calls `ApplicationNumber`. One per
   * license, not per licensee.
   */
  licenseId: string;
  businessName: string | null;
  /** `Short-Term Rentals`, `Business`, `Alcohol`. */
  licenseType: string | null;
  /**
   * The page's "Application Status", `Active` on every page sampled, even one
   * whose only issuance has expired. An issuance's `status` is the license's.
   */
  status: string | null;
  description: string | null;
  /** In page order (see `parseLocations`); empty when the page has no Locations section. */
  locations: LicenseLocation[];
  issuances: LicenseIssuance[];
  /** In page order; empty when the page says there are none. */
  submittals: LicenseSubmittal[];
}

/** The "Invalid License" page of a hidden license id: nothing about the license is shown. */
export interface HiddenLicensePage {
  hidden: true;
  cityviewLicenseId: number;
}

const PORTAL_ORIGIN = 'https://www.muni.org';

export function licensePageUrl(cityviewLicenseId: number): string {
  return `${PORTAL_ORIGIN}/CityViewPortal/License/Status?licenseId=${cityviewLicenseId}&category=B`;
}

/** Whitespace collapsed to single spaces and trimmed, for labels and short values. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A label's text without its trailing colon: `Business Name:` is `Business Name`. */
function labelText(element: HTMLElement): string {
  return squash(element.textContent).replace(/:$/, '').trim();
}

/** The element a `<label>` names, by its `for` attribute, else the label's next sibling block. */
function labelledElement(root: HTMLElement, label: HTMLElement): HTMLElement | null {
  const target = label.getAttribute('for');
  if (target) {
    const byId = root.querySelectorAll('[id]').find((element) => element.id === target);
    if (byId) return byId;
  }
  return label.parentNode?.nextElementSibling ?? null;
}

/** The value of each summary label, trimmed; null when empty. Throws when a label is missing. */
function summaryValue(root: HTMLElement, labels: readonly HTMLElement[], name: string): string | null {
  const label = labels.find((element) => labelText(element) === name);
  if (!label) throw new Error(`no "${name}" label`);
  const value = labelledElement(root, label);
  if (!value) throw new Error(`no value for the "${name}" label`);
  const text = value.textContent.trim();
  return text === '' ? null : text;
}

/** The content of the section headed `heading`: what follows its `<legend>`. Null when missing. */
function optionalSection(root: HTMLElement, heading: string): HTMLElement | null {
  const legend = root.querySelectorAll('legend').find((element) => squash(element.textContent) === heading);
  return legend?.parentNode ?? null;
}

/** `optionalSection`, throwing when missing. */
function section(root: HTMLElement, heading: string): HTMLElement {
  const container = optionalSection(root, heading);
  if (!container) throw new Error(`no "${heading}" section`);
  return container;
}

function isWithin(node: Node, ancestor: HTMLElement): boolean {
  for (let current = node.parentNode; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function isBlank(node: Node): boolean {
  return node.nodeType === NodeType.COMMENT_NODE || squash(node.textContent) === '';
}

/**
 * The Locations section lists items, each a parcel id, an address, or a
 * label for the item after it. An item linking to the portal's property
 * search is a value, and the unlinked item just before it is its label:
 * `Property` then `07606227000`, `Address` then `257 ECHO RIDGE DR, ...`. Any
 * other item is a value without a label, such as an address typed in free
 * text (license 15993). The label is kept as shown, including the error
 * message the portal prints when its own parcel lookup fails (license 13966).
 * A page may have no Locations section (Business license 16427).
 */
function parseLocations(root: HTMLElement, labels: readonly HTMLElement[]): LicenseLocation[] {
  const content = optionalSection(root, 'Locations');
  if (!content) return [];
  const label = labels.find((element) => labelText(element) === 'Locations' && isWithin(element, content));
  const list = (label && labelledElement(root, label)) ?? content;
  const items = list.childNodes
    .filter((node) => !isBlank(node) && !(node instanceof HTMLElement && node.tagName === 'LABEL'))
    .map((node) => {
      const anchor =
        node instanceof HTMLElement ? (node.tagName === 'A' ? node : node.querySelector('a')) : null;
      const href = anchor?.getAttribute('href');
      return { text: squash(node.textContent), link: href ? new URL(href, PORTAL_ORIGIN).href : null };
    });

  const locations: LicenseLocation[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const next = items[i + 1];
    if (item.link === null && next?.link) {
      locations.push({ label: item.text, value: next.text, link: next.link });
      i++;
    } else {
      locations.push({ label: null, value: item.text, link: item.link });
    }
  }
  return locations;
}

/** `MM/DD/YYYY` as ISO. Throws on any other non-empty value, so a format change fails the read. */
function usDate(value: string | null): IsoDate | null {
  if (value === null) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`not an MM/DD/YYYY date: ${value}`);
  return `${match[3]}-${match[1]}-${match[2]}`;
}

/**
 * The body rows of `table`, each as a cell value (squashed, null when empty)
 * by column header. Throws when the table has no header row or lacks one of
 * `columns`; `name` names the table in the error.
 */
function tableRows<C extends string>(
  table: HTMLElement,
  name: string,
  columns: readonly C[],
): Record<C, string | null>[] {
  const rows = table.querySelectorAll('tr');
  const headerRow = rows.find((row) => row.querySelector('th') !== null);
  if (!headerRow) throw new Error(`the ${name} table has no header row`);
  const headers = headerRow.querySelectorAll('th').map((cell) => squash(cell.textContent));
  const index = columns.map((column) => {
    const at = headers.indexOf(column);
    if (at === -1) throw new Error(`the ${name} table has no "${column}" column (has ${headers.join(', ')})`);
    return at;
  });

  return rows
    .filter((row) => row !== headerRow && row.querySelector('td') !== null)
    .map((row) => {
      const cells = row.querySelectorAll('td').map((cell) => squash(cell.textContent) || null);
      return Object.fromEntries(columns.map((column, i) => [column, cells[index[i]!] ?? null])) as Record<
        C,
        string | null
      >;
    });
}

const ISSUANCE_COLUMNS = ['Type', 'Date Issued', 'Date Expires', 'Status', 'Number'] as const;

/** Rows of the Issuances table, by column header. A section with no table has no issuances. */
function parseIssuances(root: HTMLElement): LicenseIssuance[] {
  const table = section(root, 'Issuances').querySelector('table');
  if (!table) return [];
  return tableRows(table, 'Issuances', ISSUANCE_COLUMNS).map((row) => ({
    type: row['Type'],
    issuedDate: usDate(row['Date Issued']),
    expiresDate: usDate(row['Date Expires']),
    status: row['Status'],
    number: row['Number'],
  }));
}

const SUBMITTAL_COLUMNS = ['Name', 'Type', 'Status'] as const;
const NO_SUBMITTALS = 'There are no submittals for this license application.';

/**
 * Rows of the Submittals table, by column header. Without a table, the
 * section must say there are none; anything else throws.
 */
function parseSubmittals(root: HTMLElement): LicenseSubmittal[] {
  const content = section(root, 'Submittals');
  const table = content.querySelector('table');
  if (!table) {
    if (squash(content.textContent).endsWith(NO_SUBMITTALS)) return [];
    throw new Error(`the Submittals section has neither a table nor "${NO_SUBMITTALS}"`);
  }
  return tableRows(table, 'Submittals', SUBMITTAL_COLUMNS).map((row) => ({
    name: row['Name'],
    type: row['Type'],
    date: usDate(/\b(\d{2}\/\d{2}\/\d{4})$/.exec(row['Name'] ?? '')?.[1] ?? null),
    status: row['Status'],
  }));
}

/** The visible heading of the "Invalid License" page a hidden license id returns. */
const HIDDEN_HEADING = 'License Not Found';

/**
 * A license page, or `HiddenLicensePage` for the "Invalid License" page. Throws
 * on any other page without a license summary, or a changed layout.
 */
export function parseLicensePage(html: string, cityviewLicenseId: number): LicensePage | HiddenLicensePage {
  // The portal sends CRLF line endings. Browsers normalize them to LF when
  // parsing (HTML spec, input stream preprocessing); node-html-parser doesn't.
  const root = parse(html.replace(/\r\n?/g, '\n'));
  const labels = root.querySelectorAll('label');
  const isHidden =
    !labels.some((label) => labelText(label) === 'Licensee Number') &&
    root.querySelectorAll('h1, h2, h3').some((heading) => squash(heading.textContent) === HIDDEN_HEADING);
  if (isHidden) return { hidden: true, cityviewLicenseId };
  try {
    const licenseId = summaryValue(root, labels, 'Licensee Number');
    if (licenseId === null) throw new Error('empty "Licensee Number"');
    return {
      hidden: false,
      cityviewLicenseId,
      licenseId,
      businessName: summaryValue(root, labels, 'Business Name'),
      licenseType: summaryValue(root, labels, 'License Type'),
      status: summaryValue(root, labels, 'Application Status'),
      description: summaryValue(root, labels, 'Description'),
      locations: parseLocations(root, labels),
      issuances: parseIssuances(root),
      submittals: parseSubmittals(root),
    };
  } catch (err) {
    const title = squash(root.querySelector('title')?.textContent ?? '');
    throw new Error(`license ${cityviewLicenseId}: ${(err as Error).message} (page title: ${title})`);
  }
}

/** A read's page (a `HiddenLicensePage` for a hidden license id), or the error when it failed. */
export type LicensePageResult =
  | { cityviewLicenseId: number; page: LicensePage | HiddenLicensePage; error: null }
  | { cityviewLicenseId: number; page: null; error: string };

/**
 * Request tuning. The portal's Cloudflare front answers HTTP 429 to GitHub's
 * runners above about 1 request a second, so reads go one at a time at 1/s:
 * about 3,600 an hour, against a full read order of about 2,700 ids.
 * `chooseLicenseIds` puts the ids that matter most first, for when the read
 * budget runs out.
 *
 * The pacer takes the default rate-limit policy (`utils/pace`): a 429 halves
 * the rate, down to `MIN_REQUESTS_PER_SECOND`, and the read is retried after
 * 10s, then 20s, or the response's `Retry-After` up to a minute. After
 * `RECOVER_AFTER` successes in a row the rate rises by a quarter, back up to
 * `REQUESTS_PER_SECOND`.
 */
const REQUESTS_PER_SECOND = 1;
const MIN_REQUESTS_PER_SECOND = 0.25;
const RECOVER_AFTER = 20;
const CONCURRENCY = 1;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;

/** Backoff between retries of a failed read: `RETRY_BACKOFF_MS * attempt`. */
const RETRY_BACKOFF_MS = 500;

export type FetchOneLicensePage = (cityviewLicenseId: number) => Promise<LicensePage | HiddenLicensePage>;

function portalPacer(): Pacer {
  return new Pacer({
    rate: REQUESTS_PER_SECOND,
    minRate: MIN_REQUESTS_PER_SECOND,
    recoverAfter: RECOVER_AFTER,
    service: 'the CityView portal',
  });
}

/**
 * Real requests, paced by one `Pacer` for all pages and retried. A 429 slows
 * the pacer and is retried; a read fails only once its retries are spent.
 */
export function liveLicensePageFetcher(pacer = portalPacer()): FetchOneLicensePage {
  return (cityviewLicenseId) =>
    // Parsing inside the retry means a truncated page is fetched again.
    withRetries(
      async () => parseLicensePage(await fetchText(licensePageUrl(cityviewLicenseId), TIMEOUT_MS), cityviewLicenseId),
      {
        label: `license page ${cityviewLicenseId}`,
        attempts: MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
        pacer,
      },
    );
}

export interface FetchLicensePagesOptions {
  fetchOne?: FetchOneLicensePage;
  concurrency?: number;
  /** No page is read once this many milliseconds have passed. Unlimited by default. */
  budgetMs?: number;
}

/**
 * Read each license page, in the order given, until `budgetMs` is spent. A
 * failure is recorded in its result rather than thrown; a hidden page is not a
 * failure. Ids not reached in the budget have no result.
 */
export async function fetchLicensePages(
  cityviewLicenseIds: readonly number[],
  options: FetchLicensePagesOptions = {},
): Promise<LicensePageResult[]> {
  const fetchOne = options.fetchOne ?? liveLicensePageFetcher();
  const results = await mapWithinBudget(
    cityviewLicenseIds,
    options.concurrency ?? CONCURRENCY,
    options.budgetMs ?? Infinity,
    async (cityviewLicenseId): Promise<LicensePageResult> => {
      try {
        return { cityviewLicenseId, page: await fetchOne(cityviewLicenseId), error: null };
      } catch (err) {
        return { cityviewLicenseId, page: null, error: describeError(rootCause(err)) };
      }
    },
  );
  for (const result of results) {
    if (result.error) log.warn(`license page ${result.cityviewLicenseId} failed: ${result.error}`);
  }
  return results;
}

const LOCATOR_URL = `${PORTAL_ORIGIN}/CityViewPortal/License/Locator`;
const LOCATOR_RESULTS_URL =
  `${PORTAL_ORIGIN}/CityViewPortal/License/LocatorResults` +
  '?searchValue=*&jurisdictionFilter=&licenseType=&pageNumber=0';

/**
 * The highest `cityviewLicenseId` on the first page of the License Locator's
 * results for `*`, from the `licenseId` of each item's "License Status"
 * link. The response is JSON whose `View` is the results' HTML. The list runs
 * newest first, but not entirely: on 2026-11-10 its first item was license
 * 559, an Alcohol license, followed by 16459, 16458, ... So the
 * newest id is the highest on the page, not the first. Throws on a response
 * that is not that JSON or lists no license.
 */
export function parseNewestCityviewLicenseId(json: string): number {
  let view: unknown;
  try {
    view = (JSON.parse(json) as { View?: unknown }).View;
  } catch {
    throw new Error(`the License Locator's results are not JSON: ${squash(json).slice(0, 200)}`);
  }
  if (typeof view !== 'string') throw new Error('the License Locator\'s results have no "View"');
  const ids = parse(view)
    .querySelectorAll('a')
    .filter((anchor) => squash(anchor.textContent) === 'License Status')
    .map((anchor) => {
      const href = anchor.getAttribute('href') ?? '';
      const id = new URL(href, PORTAL_ORIGIN).searchParams.get('licenseId');
      if (id === null || !/^\d+$/.test(id)) throw new Error(`a License Status link without a licenseId: ${href}`);
      return Number(id);
    });
  if (ids.length === 0) throw new Error('the License Locator listed no licenses');
  return Math.max(...ids);
}

/**
 * The newest `cityviewLicenseId` the License Locator lists, which is the
 * newest visible license. Its results answer only within a session: the
 * Locator page sets the session cookies, and without them the results
 * redirect to an error page. Two requests, paced and retried together.
 */
export async function fetchNewestCityviewLicenseId(pacer = portalPacer()): Promise<number> {
  return withRetries(
    async () => {
      const cookie = await fetchCookies(LOCATOR_URL, TIMEOUT_MS);
      await pacer.waitTurn();
      const json = await fetchText(LOCATOR_RESULTS_URL, TIMEOUT_MS, {
        headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' },
        redirect: 'manual',
      });
      return parseNewestCityviewLicenseId(json);
    },
    { label: 'the License Locator', attempts: MAX_RETRIES, backoffMs: RETRY_BACKOFF_MS, pacer },
  );
}
