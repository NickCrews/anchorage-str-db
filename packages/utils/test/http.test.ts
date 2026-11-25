import { expect, it } from 'vitest';

import { parseRetryAfter } from '../src/http.ts';

it('reads Retry-After as seconds or an HTTP date', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');

  expect(parseRetryAfter('30', now)).toBe(30_000);
  expect(parseRetryAfter('Wed, 25 Nov 2026 12:00:05 GMT', now)).toBe(5_000);
  expect(parseRetryAfter('Wed, 25 Nov 2026 11:00:00 GMT', now)).toBe(0);
  expect(parseRetryAfter(null, now)).toBeNull();
  expect(parseRetryAfter('soon', now)).toBeNull();
});
