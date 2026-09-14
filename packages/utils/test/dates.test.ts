import { describe, expect, it } from 'vitest';

import { addDays, epochDays, parseIsoDate, toIsoDate, toSqlTimestamp } from '../src/dates.ts';

describe('parseIsoDate', () => {
  it('accepts a real calendar date', () => {
    expect(parseIsoDate('2026-02-28')).toBe('2026-02-28');
  });

  it.each(['2026-2-8', '18/08/2026', '2026-02-30', '2026-13-01', 'today'])(
    'rejects %s',
    (value) => {
      expect(() => parseIsoDate(value)).toThrow();
    },
  );
});

describe('addDays', () => {
  it.each([
    ['2026-08-18', 1, '2026-08-19'],
    ['2026-08-18', -6, '2026-08-12'],
    ['2026-08-31', 1, '2026-09-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
  ])('%s + %i days = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('does not shift across a DST boundary in the local zone', () => {
    // Local-time `Date` arithmetic across a DST change can land on the wrong day.
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
  });
});

describe('epochDays', () => {
  it('matches DuckDB’s own DATE representation', () => {
    expect(epochDays('1970-01-01')).toBe(0);
    expect(epochDays('2026-09-12')).toBe(20_708);
  });
});

describe('toIsoDate and toSqlTimestamp', () => {
  it('render an instant in UTC, never the local zone', () => {
    // 2026-09-11 21:30 in Anchorage is the 12th in UTC.
    const instant = new Date('2026-09-12T05:30:00Z');
    expect(toIsoDate(instant)).toBe('2026-09-12');
    expect(toSqlTimestamp(instant)).toBe('2026-09-12 05:30:00');
  });
});
