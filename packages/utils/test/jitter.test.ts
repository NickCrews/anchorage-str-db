import { describe, expect, it } from 'vitest';

import { jitterFits } from '../src/jitter.ts';

const pin = { lat: 61.2, lng: -149.9 };

describe('jitterFits', () => {
  it.each([
    ['inside the box, off both axes', 0.0005, -0.0008, true],
    ['just inside the outer corner', 0.00119, 0.00119, true],
    ['on the pin', 0, 0, false],
    ['on the cross: latitude offset too small', 0.0001, 0.0008, false],
    ['on the cross: longitude offset too small', 0.0008, 0.0001, false],
    ['beyond the box in latitude', 0.0013, 0.0008, false],
    ['beyond the box in longitude', 0.0008, -0.0013, false],
  ])('%s', (_case, dLat, dLng, fits) => {
    expect(jitterFits(pin, { lat: pin.lat + dLat, lng: pin.lng + dLng })).toBe(fits);
  });

  it('widens every edge by the tolerance, in degrees per axis', () => {
    // 20 m is 0.00018° of latitude and 0.00037° of longitude at 61.2°.
    const outside = { lat: pin.lat + 0.0013, lng: pin.lng + 0.0015 };
    expect(jitterFits(pin, outside)).toBe(false);
    expect(jitterFits(pin, outside, 20)).toBe(true);
    expect(jitterFits(pin, { lat: pin.lat + 0.0013, lng: pin.lng + 0.0017 }, 20)).toBe(false);
    expect(jitterFits(pin, pin, 20)).toBe(false);
    expect(jitterFits(pin, pin, 30)).toBe(true);
  });
});
