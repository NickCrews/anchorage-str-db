/**
 * Airbnb's public web API key, scraped from the homepage HTML.
 *
 * It is a long-lived public constant embedded in every page — not a session
 * token — which is what makes fetching it once per run and threading it
 * through every request safe. Callers take it as a required argument with no
 * default, because fetching it per call means re-downloading this ~600 KB
 * homepage once per listing to re-extract the same string: two thirds of a
 * run's requests.
 *
 * If the key does go stale mid-run, every request after it fails at once,
 * which the run's failure-rate checks catch.
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
