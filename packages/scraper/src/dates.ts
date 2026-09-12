/**
 * Dates are ISO `YYYY-MM-DD` strings everywhere in this package.
 *
 * A scrape date is a calendar day in UTC, never an instant, and JavaScript's
 * `Date` cannot represent that: it is a timestamp that renders differently
 * depending on the reader's timezone, so `new Date('2026-09-11')` printed in
 * Anchorage is the 10th. Airbnb's calendar already speaks ISO dates, DuckDB
 * casts them to `DATE` without ambiguity, and they sort and compare as
 * strings — so the string *is* the representation and there is nothing to
 * convert.
 */

/** An ISO `YYYY-MM-DD` calendar date. */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  return ISO_DATE_RE.test(value);
}

export function parseIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) throw new Error(`not an ISO YYYY-MM-DD date: ${value}`);
  // Rejects 2026-02-30 and friends, which the regex alone would accept.
  const roundTrip = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || toIsoDate(roundTrip) !== value) {
    throw new Error(`not a real calendar date: ${value}`);
  }
  return value;
}

export function toIsoDate(instant: Date): IsoDate {
  return instant.toISOString().slice(0, 10);
}

export function todayUtc(): IsoDate {
  return toIsoDate(new Date());
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toIsoDate(shifted);
}

/**
 * Days since 1970-01-01. Two uses: it is DuckDB's own `DATE` representation,
 * so it is what the appender wants, and it is the per-day seed the coverage
 * audit samples with.
 */
export function epochDays(date: IsoDate): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);
}

/** A naive UTC timestamp, `YYYY-MM-DD HH:MM:SS`, for DuckDB's `TIMESTAMP`. */
export function toSqlTimestamp(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}
