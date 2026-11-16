/**
 * Airbnb's public web API key, read from the homepage HTML.
 *
 * It is a long-lived public value, not a session token, so the pipeline
 * fetches it once per run and passes it to every request. If it goes stale
 * mid-run, the failure-rate checks catch the resulting errors.
 */

import { request } from './http.ts';

const API_KEY_RE = /"api_config":\{"key":"(.+?)"/;

export async function fetchApiKey(): Promise<string> {
  const html = await request('https://www.airbnb.com/', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
    },
  });
  const match = API_KEY_RE.exec(html);
  if (!match?.[1]) {
    throw new Error(
      "could not find Airbnb's web API key in the homepage HTML — the page shape has " +
        'changed, or the fetch was blocked',
    );
  }
  return match[1];
}
