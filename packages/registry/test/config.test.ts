import { afterEach, describe, expect, it } from 'vitest';

import { MissingServiceUrlError, SERVICE_URL_ENV, serviceUrl } from '../src/config.ts';

const LAYER = 'https://services1.arcgis.com/abc/arcgis/rest/services/STR/FeatureServer/0';

afterEach(() => {
  delete process.env[SERVICE_URL_ENV];
});

describe('serviceUrl', () => {
  it('takes the override, then the environment', () => {
    process.env[SERVICE_URL_ENV] = `${LAYER}/`;
    expect(serviceUrl()).toBe(LAYER);
    expect(serviceUrl(` ${LAYER} `)).toBe(LAYER);
  });

  it('says how to configure it when nothing did', () => {
    expect(() => serviceUrl()).toThrow(MissingServiceUrlError);
    expect(() => serviceUrl('  ')).toThrow(new RegExp(SERVICE_URL_ENV));
  });

  it('rejects a service URL that names no layer', () => {
    // Every query against it would fail with an ArcGIS error that does not
    // say this is the reason.
    expect(() => serviceUrl('https://services1.arcgis.com/abc/arcgis/rest/services/STR/FeatureServer'))
      .toThrow(/must end with a layer index.*FeatureServer\/0/s);
    expect(() => serviceUrl('https://example.test/whatever')).toThrow(/layer index/);
  });

  it('takes a MapServer layer too', () => {
    const mapLayer = 'https://maps.example.test/arcgis/rest/services/STR/MapServer/3';
    expect(serviceUrl(mapLayer)).toBe(mapLayer);
  });
});
