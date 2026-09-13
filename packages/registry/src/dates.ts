/**
 * Dates are ISO `YYYY-MM-DD` strings throughout this package, as in
 * `packages/scraper/src/dates.ts`.
 *
 * This is a second copy rather than a shared module because a package here is
 * run straight from its sources (`node src/cli.ts`), and Node strips types
 * only outside `node_modules`: a `@anchorage-str-db/common` would have to be
 * compiled before either package could run. The copy is small, has no
 * dependencies, and the two must agree only on the ISO format, which is the
 * storage format on both sides.
 */

/** An ISO `YYYY-MM-DD` calendar date. */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toIsoDate(instant: Date): IsoDate {
  return instant.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): IsoDate {
  if (!ISO_DATE_RE.test(value)) throw new Error(`not an ISO YYYY-MM-DD date: ${value}`);
  // Rejects 2026-02-30 and friends, which the regex alone would accept.
  const roundTrip = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || toIsoDate(roundTrip) !== value) {
    throw new Error(`not a real calendar date: ${value}`);
  }
  return value;
}

export function todayUtc(): IsoDate {
  return toIsoDate(new Date());
}

/** Days since 1970-01-01: DuckDB's `DATE` representation. */
export function epochDays(date: IsoDate): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);
}

/** A naive UTC timestamp, `YYYY-MM-DD HH:MM:SS`, for DuckDB's `TIMESTAMP`. */
export function toSqlTimestamp(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * An Esri date field as an ISO date, or null.
 *
 * Esri stores dates as epoch milliseconds, always UTC. A registration's
 * issue and expiry dates are calendar days that the publisher wrote at local
 * midnight or at noon; taking the UTC day is the only reading that does not
 * invent a timezone, and is off by at most a day either way. Documented in
 * `docs/research/anchorage-str-registry.md` so no query treats these as
 * instants.
 */
export function fromEsriDate(value: unknown): IsoDate | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return toIsoDate(instant);
}
