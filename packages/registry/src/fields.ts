/**
 * Mapping the layer's columns onto this package's columns.
 *
 * A publisher names ArcGIS fields however they like, and the names are not
 * documented anywhere outside the layer itself. Rather than hard-code one
 * guess, each column here lists the names it accepts, matched
 * case-insensitively and ignoring `_` and spaces, and `mapFields` resolves
 * them against the layer's own field list once per run.
 *
 * Two things keep a wrong or incomplete guess from costing data:
 *
 * - every record stores its whole `attributes` object verbatim as JSON, so a
 *   column this file fails to recognize is still in the database and can be
 *   mapped later without re-scraping;
 * - the version hash is computed over those raw attributes, so a change in
 *   an unmapped column still opens a new version.
 *
 * `registry probe <url>` prints the layer's fields next to what they mapped
 * to, which is how to extend the lists below.
 */

import type { LayerField } from './arcgis/layer.ts';

/** The columns `records.ts` produces and `store.ts` writes. */
export const CANONICAL_FIELDS = [
  'registrationId',
  'status',
  'registrationType',
  'address',
  'unit',
  'zip',
  'parcelId',
  'operatorName',
  'issuedDate',
  'expiresDate',
  'editedDate',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/**
 * Candidate layer field names per column, most specific first.
 *
 * Drawn from what Anchorage and comparable municipal STR layers call these
 * columns; the permit-system names (`folderrsn`, `permitnum`, `recordnum`)
 * are there because Anchorage's registrations are issued through its
 * CityView permitting system, whose GIS exports carry them.
 */
export const FIELD_ALIASES: Record<CanonicalField, readonly string[]> = {
  registrationId: [
    'strnumber',
    'strregistrationnumber',
    'registrationnumber',
    'registrationno',
    'registrationid',
    'registration',
    'permitnumber',
    'permitnum',
    'licensenumber',
    'licensenum',
    'recordnumber',
    'recordnum',
    'casenumber',
    'folderrsn',
  ],
  status: ['status', 'registrationstatus', 'permitstatus', 'licensestatus', 'statusdescription'],
  registrationType: [
    'registrationtype',
    'strtype',
    'rentaltype',
    'permittype',
    'licensetype',
    'type',
    'category',
    'subtype',
    'usetype',
  ],
  address: [
    'address',
    'siteaddress',
    'propertyaddress',
    'streetaddress',
    'fulladdress',
    'addressfull',
    'location',
    'addr',
  ],
  unit: ['unit', 'unitnumber', 'unitno', 'suite', 'apt'],
  zip: ['zip', 'zipcode', 'postalcode', 'zip5'],
  // The join key to https://github.com/NickCrews/anchorage-property.
  parcelId: ['parcelid', 'parcelnumber', 'parcelno', 'taxid', 'taxparcelid', 'pin', 'apn', 'kpb'],
  operatorName: [
    'operatorname',
    'operator',
    'ownername',
    'owner',
    'applicantname',
    'applicant',
    'businessname',
    'dba',
    'contactname',
  ],
  issuedDate: ['issuedate', 'issueddate', 'dateissued', 'approveddate', 'effectivedate', 'startdate'],
  expiresDate: ['expirationdate', 'expiresdate', 'expirydate', 'dateexpires', 'enddate', 'expires'],
  editedDate: ['lasteditdate', 'editdate', 'lastedited', 'lastupdate', 'lastupdated', 'modifieddate'],
};

/** Which layer field each column resolved to; null where the layer has none. */
export type FieldMap = Record<CanonicalField, string | null>;

/** Lowercase, with `_`, `-` and spaces removed: `Site_Address` -> `siteaddress`. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Resolve every column against the layer's fields.
 *
 * A column takes the first alias the layer actually has, so the order of
 * `FIELD_ALIASES` decides between a layer carrying both `registrationnumber`
 * and `permitnumber`. A column with no match is null, and the
 * `field_mapping_alive` check reports it.
 */
export function mapFields(fields: readonly LayerField[]): FieldMap {
  const byNormalized = new Map<string, string>();
  for (const field of fields) {
    // First wins, so a layer with both `Address` and `address` keeps the one
    // it declared first rather than flipping between runs.
    if (!byNormalized.has(normalizeFieldName(field.name))) {
      byNormalized.set(normalizeFieldName(field.name), field.name);
    }
  }

  const map = {} as FieldMap;
  for (const column of CANONICAL_FIELDS) {
    map[column] =
      FIELD_ALIASES[column].map((alias) => byNormalized.get(alias)).find((name) => name) ?? null;
  }
  return map;
}

/**
 * The layer fields no column claimed, which are still stored in
 * `attributes`. The object-id field is not among them: it has a column of
 * its own and is deliberately not one of `CANONICAL_FIELDS`.
 */
export function unmappedFields(
  fields: readonly LayerField[],
  map: FieldMap,
  objectIdField?: string,
): string[] {
  const claimed = new Set(Object.values(map).filter((name): name is string => name !== null));
  if (objectIdField !== undefined) claimed.add(objectIdField);
  return fields.map((field) => field.name).filter((name) => !claimed.has(name));
}

/**
 * A registration number reduced to its join key: uppercase, with everything
 * that is not a letter or digit removed. `STR-2026-0001`, `str 2026 0001`
 * and `STR20260001` all become `STR20260001`.
 *
 * Both sides of the join need this. The municipal layer holds the number as
 * the clerk's office issued it; the Airbnb side holds whatever the host
 * typed into a free-text box, which is the same number with its own spacing,
 * punctuation and case. Anything subtler — dropping a prefix, correcting a
 * digit — belongs in analysis, where a wrong guess can be seen and undone,
 * not in the stored key.
 *
 * Returns null for a value with no letter or digit in it, which is how blank
 * and placeholder cells ("-", "n/a") arrive.
 */
export function normalizeRegistrationId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const key = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!key) return null;
  // "NA", "NONE", "PENDING", "EXEMPT" are things hosts type where a number
  // belongs; they are not registration numbers and must not join to each
  // other. A real number always contains a digit.
  if (!/\d/.test(key)) return null;
  return key;
}
