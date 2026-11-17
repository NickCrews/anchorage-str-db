/**
 * Sorts each case into a problem and explains it in plain sentences. The name
 * matching follows docs/research/registration-location-mismatch/build.mjs.
 */
import { FAR_METERS, type CaseRow, type ListingOnRegistration, type NearbyRegistration } from './sql';

export type Problem = 'no-id' | 'not-on-file' | 'lapsed' | 'wrong-id' | 'second-place' | 'not-at-address';

export type Suggestion = NearbyRegistration & { reasons: string[] };

export type Case = Omit<CaseRow, 'listings_on_registration' | 'registrations_near_listing'> & {
  problem: Problem;
  listings_on_registration: ListingOnRegistration[];
  registrations_near_listing: Suggestion[];
  suggested_registrations: Suggestion[];
  listings_at_registered_address: number;
  business_name_is_address: boolean;
};

export const PROBLEMS: {
  key: Problem;
  label: string;
  description: string;
  fix: string;
  /** The registration whose case is the card's example, when it is still in the data. */
  example?: string;
}[] = [
  {
    key: 'wrong-id',
    label: 'Likely the wrong id',
    description:
      "The id on the listing belongs to a registration somewhere else. Right where the listing is, there is a different registration with a matching name: the same business, the Airbnb host's name, or the listing's title. Likely explanation: the owner has several rentals and copied the id from another of them.",
    fix: "Ask the host to fix the listing, to show the matching nearby registration's id. If that registration is for a different dwelling or room, this rental needs its own registration.",
    example: 'STR20261641',
  },
  {
    key: 'second-place',
    label: 'One id, two places',
    description:
      'Several listings show the same id. Some are at the registered address, but this one is somewhere else. The host may be using one registration for a second rental that needs its own.',
    fix: 'Ask the host to register the second rental and show that new id on its listing.',
    example: 'STR20262172',
  },
  {
    key: 'not-at-address',
    label: 'Not at the registered address',
    description:
      "No listing that shows this id is near the registered address, and no registration near the listing matches it. The registration may have the wrong address, or the rental may be using an id that isn't its own.",
    fix: 'Ask the registrant where the rental is. If the registered address is wrong, correct the registration. If the listing is a different rental, it needs its own registration.',
    example: 'STR20260610',
  },
  {
    key: 'no-id',
    label: 'No id shown',
    description:
      'The listing shows no registration id at all. Where a registration near the listing has a matching name, the table names it as the likely one.',
    fix: 'Ask the host to show the rental\'s registration id on the listing, or to register the rental if it has none.',
  },
  {
    key: 'not-on-file',
    label: 'Id not on file',
    description:
      "The id on the listing is on no license page the Muni publishes. It can be a typo, an id on a license whose page is hidden, or one issued since our last read of the Muni's license pages.",
    fix: 'Ask the host which registration the rental holds, and to correct the id on the listing.',
  },
  {
    key: 'lapsed',
    label: 'Registration lapsed',
    description: "The listing shows a registration whose STR Certificate is no longer Active.",
    fix: 'Ask the registrant to renew the registration, or the host to stop renting.',
  },
];

export const PROBLEM_LABEL = Object.fromEntries(PROBLEMS.map((p) => [p.key, p.label])) as Record<Problem, string>;

// Business names are typed by registrants, so compare them loosely: case,
// punctuation and company suffixes are ignored.
const SUFFIXES = new Set(['llc', 'inc', 'the', 'co', 'ltd', 'd', 'b', 'a']);
function norm(text: string | null | undefined) {
  return (text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !SUFFIXES.has(t))
    .join(' ');
}

function namesMatch(a: string | null, b: string | null) {
  const na = norm(a);
  const nb = norm(b);
  if (na.length < 5 || nb.length < 5) return false;
  if (na === nb) return true;
  return na.length >= 8 && nb.length >= 8 && (na.startsWith(nb) || nb.startsWith(na));
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A listing title and a business name match when one starts with the other for 15+ characters. */
function titleMatches(title: string | null, businessName: string | null) {
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
function streetWords(address: string | null) {
  const street = norm((address ?? '').split(',')[0]);
  return street.split(' ').filter((t) => t.length >= 5 && !/\d/.test(t) && !STREET_WORDS.has(t));
}

function titleNamesStreet(title: string | null, address: string | null) {
  const words = new Set(norm(title).split(' '));
  return streetWords(address).some((w) => words.has(w));
}

/** '1327 Medfra Street': a business name that is a street address. */
const looksLikeAddress = (businessName: string | null) => /^\s*\d+\s+[A-Za-z]/.test(businessName ?? '');

function oneDigitApart(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}

/** Arrow lists and structs as plain arrays and objects. */
function plain<T>(value: unknown): T {
  if (value == null) return value as T;
  if (typeof value === 'bigint') return Number(value) as T;
  if (typeof value === 'object' && 'toArray' in value && typeof value.toArray === 'function') {
    return [...(value.toArray() as unknown[])].map((v) => plain(v)) as T;
  }
  if (typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
    return Object.fromEntries(Object.entries(value.toJSON() as object).map(([k, v]) => [k, plain(v)])) as T;
  }
  return value as T;
}

export function classify(row: CaseRow): Case {
  const listings = plain<ListingOnRegistration[] | null>(row.listings_on_registration) ?? [];
  const near = (plain<NearbyRegistration[] | null>(row.registrations_near_listing) ?? []).map((n) => {
    const reasons: string[] = [];
    if (row.business_name && namesMatch(n.business_name, row.business_name)) {
      reasons.push(`same business name as ${row.registration_id}`);
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
  // registered several dwellings at once has consecutive ids.
  const [only] = suggested;
  if (row.registration_id && suggested.length === 1 && only && oneDigitApart(only.registration_id, row.registration_id)) {
    only.reasons.push(`id differs from ${row.registration_id} by one digit`);
  }
  const atRegistered = listings.filter((o) => o.distance_m != null && o.distance_m <= FAR_METERS);

  let problem: Problem;
  if (row.base_problem !== 'far') problem = row.base_problem;
  else if (suggested.length > 0) problem = 'wrong-id';
  else if (atRegistered.length > 0) problem = 'second-place';
  else problem = 'not-at-address';

  return {
    ...row,
    problem,
    listings_on_registration: listings,
    registrations_near_listing: near,
    suggested_registrations: suggested,
    listings_at_registered_address: atRegistered.length,
    business_name_is_address: looksLikeAddress(row.business_name),
  };
}

const ORDER = Object.fromEntries(PROBLEMS.map((p, i) => [p.key, i])) as Record<Problem, number>;

/** Cases in the order of the problem cards, each problem in the query's order. */
export const sortCases = (cases: Case[]) =>
  cases.map((c, i) => [c, i] as const).sort(([a, i], [b, j]) => ORDER[a.problem] - ORDER[b.problem] || i - j).map(([c]) => c);

export const distance = (m: number | null | undefined) =>
  m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;

export const title = (text: string | null | undefined) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** '6605 STELLA PL, ANCHORAGE, AK 99507' reads as '6605 Stella Pl'. */
export const street = (address: string | null | undefined) =>
  (title(address).split(',')[0] ?? '').trim().toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

const quoted = (text: string | null | undefined) => `“${title(text)}”`;

const registeredAs = (c: Case) =>
  `${c.registration_id} is registered${c.business_name ? ` to ${quoted(c.business_name)}` : ''} at ${street(c.registered_address)}`;

const describeSuggestion = (r: Suggestion) =>
  `${r.registration_id}, registered to ${quoted(r.business_name)} at ${street(r.address)}, ` +
  `${distance(r.distance_m)} from the listing (${r.reasons.join('; ')})`;

function suggestionText(s: Suggestion[]) {
  const [first] = s;
  if (!first) return '';
  if (s.length === 1) return ` Right where the listing is, there is ${describeSuggestion(first)}.`;
  return (
    ` Near the listing there are ${s.length} registrations with a matching name: ` +
    `${s.slice(0, 3).map(describeSuggestion).join('; ')}${s.length > 3 ? `; and ${s.length - 3} more like these` : ''}.`
  );
}

/** Explains one case in plain sentences. */
export function caseText(c: Case): string {
  const n = c.listings_on_registration.length;
  const s = c.suggested_registrations;
  const only = s.length === 1 ? s[0] : undefined;
  switch (c.problem) {
    case 'wrong-id': {
      const opening =
        `The listing ${quoted(c.listing_name)} shows ${c.registration_id}, which is registered` +
        `${c.business_name ? ` to ${quoted(c.business_name)}` : ''} at ${street(c.registered_address)}, ${distance(c.distance_m)} away.`;
      return (
        opening +
        suggestionText(s) +
        (only ? ` The listing probably should show ${only.registration_id}.` : ' The listing probably should show one of these.')
      );
    }
    case 'second-place':
      return (
        `${registeredAs(c)}. ${n} Airbnb listings show this id, and ${c.listings_at_registered_address} ` +
        `${c.listings_at_registered_address === 1 ? 'is' : 'are'} at that address. This one, ${quoted(c.listing_name)}, ` +
        `is ${distance(c.distance_m)} away, so the id seems to be used for a second rental.`
      );
    case 'not-at-address': {
      let text =
        n === 1
          ? `${registeredAs(c)}. The only listing that shows it, ${quoted(c.listing_name)}, is ${distance(c.distance_m)} away.`
          : `${registeredAs(c)}. ${n} listings show it and none are near that address. This one, ${quoted(c.listing_name)}, is ${distance(c.distance_m)} away.`;
      if (c.business_name_is_address) text += ` The registration's business name is itself a different street address.`;
      return `${text} The registration may have the wrong address.`;
    }
    case 'no-id':
      return (
        `The listing ${quoted(c.listing_name)} shows no registration id.` +
        suggestionText(s) +
        (only
          ? ` It may be ${only.registration_id}.`
          : s.length > 1
            ? ' It may be one of these.'
            : c.registrations_near_listing.length > 0
              ? ` ${c.registrations_near_listing.length} other registration${c.registrations_near_listing.length === 1 ? ' is' : 's are'} within 200 m, none with a matching name.`
              : ' No registration is within 200 m.')
      );
    case 'not-on-file':
      return (
        `The listing ${quoted(c.listing_name)} shows ${c.registration_id}, which no license page the Muni publishes holds.` +
        (c.newer_than_newest
          ? ' It is higher than the newest id on file, so it may have been issued since our last read.'
          : ' It is lower than the newest id on file, so it is likely a typo or a hidden license.') +
        suggestionText(s)
      );
    case 'lapsed':
      return (
        `The listing ${quoted(c.listing_name)} shows ${c.registration_id}, registered` +
        `${c.business_name ? ` to ${quoted(c.business_name)}` : ''} at ${street(c.registered_address)}, ` +
        `whose STR Certificate's status is ${c.registration_status ?? 'not Active'}.`
      );
  }
}
