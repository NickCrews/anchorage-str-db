// Builds report.html from the database:
//   node docs/research/registration-location-mismatch/build.mjs [path/to/anchorage_str.duckdb]
// Needs the duckdb CLI on PATH.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? join(here, '../../../data/anchorage_str.duckdb');

const query = (file) =>
  JSON.parse(
    execFileSync('duckdb', ['-readonly', '-json', dbPath], {
      input: readFileSync(join(here, file)),
      maxBuffer: 64 * 1024 * 1024,
    }).toString(),
  );
const rows = query('cases.sql');
const [distances] = query('distances.sql');

// Business names are typed by registrants, so compare them loosely:
// case, punctuation and company suffixes are ignored.
const SUFFIXES = new Set(['llc', 'inc', 'the', 'co', 'ltd', 'd', 'b', 'a']);
function norm(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !SUFFIXES.has(t))
    .join(' ');
}

function namesMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na.length < 5 || nb.length < 5) return false;
  if (na === nb) return true;
  return na.length >= 8 && nb.length >= 8 && (na.startsWith(nb) || nb.startsWith(na));
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A listing title and a business name match when one starts with the other for 15+ characters. */
function titleMatches(title, businessName) {
  const nt = norm(title);
  const nb = norm(businessName);
  if (nb.length < 8) return false;
  return nt === nb || commonPrefixLength(nt, nb) >= Math.min(15, nb.length);
}

const STREET_WORDS = new Set([
  'street', 'avenue', 'drive', 'circle', 'court', 'place', 'road', 'lane', 'loop', 'boulevard',
  'north', 'south', 'east', 'west', 'anchorage', 'girdwood', 'eagle', 'river', 'chugiak', 'alaska',
  'unit', 'apartment',
]);

/** Distinctive words of an address's street name: '3907 PYRENEAN CIR, ...' gives ['pyrenean']. */
function streetWords(address) {
  const street = norm((address ?? '').split(',')[0]);
  return street.split(' ').filter((t) => t.length >= 5 && !/\d/.test(t) && !STREET_WORDS.has(t));
}

function titleNamesStreet(title, address) {
  const words = new Set(norm(title).split(' '));
  return streetWords(address).some((w) => words.has(w));
}

/** '1327 Medfra Street': a business name that is a street address. */
function looksLikeAddress(businessName) {
  return /^\s*\d+\s+[A-Za-z]/.test(businessName ?? '');
}

function oneDigitApart(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}

const NEAR_REGISTERED_M = 500;

const cases = rows.map((row) => {
  const listings = row.listings_on_number ?? [];
  const near = (row.registrations_near_listing ?? []).map((n) => {
    const reasons = [];
    if (namesMatch(n.business_name, row.business_name)) {
      reasons.push(`same business name as ${row.registration_number}`);
    }
    if (namesMatch(n.business_name, row.host_name)) {
      reasons.push("business name matches the listing's Airbnb host name");
    }
    if (titleMatches(row.listing_name, n.business_name)) {
      reasons.push("business name matches the listing's title");
    }
    // Other registrations on the same street are common, so a street named in
    // the title only supports a name match.
    if (reasons.length > 0 && titleNamesStreet(row.listing_name, n.address)) {
      reasons.push("registered street is named in the listing's title");
    }
    return { ...n, reasons };
  });
  const suggested = near.filter((n) => n.reasons.length > 0);
  // One digit apart is only telling for a single candidate: an operator who
  // registered several units at once has consecutive numbers.
  if (suggested.length === 1 && oneDigitApart(suggested[0].registration_number, row.registration_number)) {
    suggested[0].reasons.push(`number differs from ${row.registration_number} by one digit`);
  }
  const atRegistered = listings.filter((o) => o.distance_m <= NEAR_REGISTERED_M);

  let finding;
  if (suggested.length > 0) finding = 'wrong-number';
  else if (atRegistered.length > 0) finding = 'second-property';
  else finding = 'not-at-address';

  return {
    ...row,
    listing_pin_is_exact: row.listing_pin_is_exact === true || row.listing_pin_is_exact === 'true',
    registrations_near_listing: near,
    suggested_registrations: suggested,
    listings_at_registered_address: atRegistered.length,
    business_name_is_address: looksLikeAddress(row.business_name),
    finding,
  };
});

const registryDate = cases.map((c) => c.registry_published_date).sort().at(-1) ?? '';
const listingDate = cases.map((c) => c.listing_seen_date).sort().at(-1) ?? '';

const data = JSON.stringify({ cases, distances, registryDate, listingDate, thresholdM: NEAR_REGISTERED_M })
  // Keep the JSON from closing its <script> element.
  .replace(/</g, '\\u003c');

const template = readFileSync(join(here, 'template.html'), 'utf8');
writeFileSync(join(here, 'report.html'), template.replace('__REPORT_DATA__', () => data));

const counts = Object.groupBy(cases, (c) => c.finding);
console.log(
  `${cases.length} listings, ${new Set(cases.map((c) => c.registration_number)).size} registrations:`,
  Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length])),
);
