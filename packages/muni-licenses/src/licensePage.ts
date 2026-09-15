/**
 * The Muni's CityView license status page for one STR registration, e.g.
 * https://www.muni.org/CityViewPortal/License/Status?licenseId=13923&category=B
 *
 * The page has fields the ArcGIS registration layer lacks: the licensee's
 * description of the business ("Provides short term rentals, logistics,
 * meeting space and overnight lodging."), parcel ids, the license type, and
 * every certificate issued under the license.
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
 * description kept. An unknown `licenseId` returns HTTP 200 with an "Invalid
 * License" page, which has no summary and is rejected.
 */

import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

import { mapWithConcurrency } from '@anchorage-str-db/utils/concurrency';
import type { IsoDate } from '@anchorage-str-db/utils/dates';
import { fetchText } from '@anchorage-str-db/utils/http';
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

export interface LicensePage {
  licenseId: number;
  /** `LC260500349`: the layer's `ApplicationNumber`. */
  /** `LC260500349`, the page's "Licensee Number": one per license, not per licensee. */
  licenseeId: string;
  businessName: string | null;
  /** `Short-Term Rentals`. */
  licenseType: string | null;
  /** `Active`. */
  status: string | null;
  description: string | null;
  /** In page order (see `parseLocations`). */
  locations: LicenseLocation[];
  issuances: LicenseIssuance[];
}

const PORTAL_ORIGIN = 'https://www.muni.org';

export function licensePageUrl(licenseId: number): string {
  return `${PORTAL_ORIGIN}/CityViewPortal/License/Status?licenseId=${licenseId}&category=B`;
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

/** The content of the section headed `heading`: what follows its `<legend>`. Throws when missing. */
function section(root: HTMLElement, heading: string): HTMLElement {
  const legend = root.querySelectorAll('legend').find((element) => squash(element.textContent) === heading);
  const container = legend?.parentNode;
  if (!legend || !container) throw new Error(`no "${heading}" section`);
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
 */
function parseLocations(root: HTMLElement, labels: readonly HTMLElement[]): LicenseLocation[] {
  const content = section(root, 'Locations');
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

const ISSUANCE_COLUMNS = ['Type', 'Date Issued', 'Date Expires', 'Status', 'Number'] as const;

/** Rows of the Issuances table, by column header. A section with no table has no issuances. */
function parseIssuances(root: HTMLElement): LicenseIssuance[] {
  const table = section(root, 'Issuances').querySelector('table');
  if (!table) return [];
  const rows = table.querySelectorAll('tr');
  const headerRow = rows.find((row) => row.querySelector('th') !== null);
  if (!headerRow) throw new Error('the Issuances table has no header row');
  const headers = headerRow.querySelectorAll('th').map((cell) => squash(cell.textContent));
  const index = Object.fromEntries(
    ISSUANCE_COLUMNS.map((column) => {
      const at = headers.indexOf(column);
      if (at === -1) throw new Error(`the Issuances table has no "${column}" column (has ${headers.join(', ')})`);
      return [column, at];
    }),
  ) as Record<(typeof ISSUANCE_COLUMNS)[number], number>;

  return rows
    .filter((row) => row !== headerRow && row.querySelector('td') !== null)
    .map((row) => {
      const cells = row.querySelectorAll('td').map((cell) => squash(cell.textContent) || null);
      return {
        type: cells[index['Type']] ?? null,
        issuedDate: usDate(cells[index['Date Issued']] ?? null),
        expiresDate: usDate(cells[index['Date Expires']] ?? null),
        status: cells[index['Status']] ?? null,
        number: cells[index['Number']] ?? null,
      };
    });
}

/** Throws on a page without a license summary, such as the "Invalid License" page, or a changed layout. */
export function parseLicensePage(html: string, licenseId: number): LicensePage {
  // The portal sends CRLF line endings. Browsers normalize them to LF when
  // parsing (HTML spec, input stream preprocessing); node-html-parser doesn't.
  const root = parse(html.replace(/\r\n?/g, '\n'));
  const labels = root.querySelectorAll('label');
  try {
    const licenseeId = summaryValue(root, labels, 'Licensee Number');
    if (licenseeId === null) throw new Error('empty "Licensee Number"');
    return {
      licenseId,
      licenseeId,
      businessName: summaryValue(root, labels, 'Business Name'),
      licenseType: summaryValue(root, labels, 'License Type'),
      status: summaryValue(root, labels, 'Application Status'),
      description: summaryValue(root, labels, 'Description'),
      locations: parseLocations(root, labels),
      issuances: parseIssuances(root),
    };
  } catch (err) {
    const title = squash(root.querySelector('title')?.textContent ?? '');
    throw new Error(`license ${licenseId}: ${(err as Error).message} (page title: ${title})`);
  }
}

export interface LicensePageResult {
  licenseId: number;
  page: LicensePage | null;
  error: string | null;
}

/**
 * Request tuning. A license page takes ~0.5s to serve; 2/s keeps the load on
 * the CityView portal to about one request at a time.
 */
const REQUESTS_PER_SECOND = 2;
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;

/** Backoff between retries of a failed read: `RETRY_BACKOFF_MS * attempt`. */
const RETRY_BACKOFF_MS = 500;

export type FetchOneLicensePage = (licenseId: number) => Promise<LicensePage>;

/** Real requests, paced by one `Pacer` for all pages and retried. */
export function liveLicensePageFetcher(
  pacer = new Pacer({ rate: REQUESTS_PER_SECOND, service: 'the CityView portal' }),
): FetchOneLicensePage {
  return (licenseId) =>
    // Parsing inside the retry means a truncated page is fetched again.
    withRetries(
      async () => parseLicensePage(await fetchText(licensePageUrl(licenseId), TIMEOUT_MS), licenseId),
      {
        label: `license page ${licenseId}`,
        attempts: MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
        pacer,
      },
    );
}

export interface FetchLicensePagesOptions {
  fetchOne?: FetchOneLicensePage;
  concurrency?: number;
}

/** Read each license page. A failure is recorded in its result rather than thrown. */
export async function fetchLicensePages(
  licenseIds: readonly number[],
  options: FetchLicensePagesOptions = {},
): Promise<LicensePageResult[]> {
  const fetchOne = options.fetchOne ?? liveLicensePageFetcher();
  const results = await mapWithConcurrency(
    licenseIds,
    options.concurrency ?? CONCURRENCY,
    async (licenseId): Promise<LicensePageResult> => {
      try {
        return { licenseId, page: await fetchOne(licenseId), error: null };
      } catch (err) {
        return { licenseId, page: null, error: describeError(rootCause(err)) };
      }
    },
  );
  for (const result of results) {
    if (result.error) log.warn(`license page ${result.licenseId} failed: ${result.error}`);
  }
  return results;
}
