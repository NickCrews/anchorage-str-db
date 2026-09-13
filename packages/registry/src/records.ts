/**
 * One ArcGIS feature -> one `RegistrationRecord`.
 *
 * Attributes are stored twice: as the columns `fields.ts` recognized, and
 * whole, verbatim, as JSON. The JSON copy is the authoritative one — it
 * survives a wrong guess in `FIELD_ALIASES` and a column the Municipality
 * adds later, either of which can then be mapped from stored data instead of
 * being re-scraped, which for a current-state layer with no history is not
 * possible after the fact.
 */

import { createHash } from 'node:crypto';

import type { Attributes, Feature } from './arcgis/query.ts';
import { fromEsriDate, type IsoDate } from './dates.ts';
import { normalizeRegistrationId, type FieldMap } from './fields.ts';

export interface RegistrationRecord {
  /** The SCD2 key. See `recordKey`. */
  recordKey: string;
  /** The registration number, normalized for joining; null if unreadable. */
  registrationId: string | null;
  /** The registration number as the layer published it. */
  registrationLabel: string | null;
  objectId: number | null;

  status: string | null;
  registrationType: string | null;
  address: string | null;
  unit: string | null;
  zip: string | null;
  parcelId: string | null;
  operatorName: string | null;

  issuedDate: IsoDate | null;
  expiresDate: IsoDate | null;
  /** The layer's own last-edited stamp, when it publishes one. */
  editedDate: IsoDate | null;

  locationLat: number | null;
  locationLng: number | null;

  /** Every attribute the layer returned, trimmed. */
  attributes: Attributes;
  /** md5 over the attributes and coordinate that define a version. */
  attrsHash: string;
}

/**
 * Attributes left out of `attrsHash`, matched case-insensitively.
 *
 * These are Esri's own housekeeping columns. Every one of them moves when the
 * publisher rebuilds the layer — a truncate-and-append refresh, which is how
 * most municipal layers are kept current, rewrites object ids, GlobalIDs and
 * edit stamps for every row without a single registration having changed.
 * Hashing them would open a new version for the whole registry on such a day
 * and drown the real changes. The object-id field is excluded separately, by
 * name, since layers spell it differently.
 */
const HOUSEKEEPING_FIELDS = new Set(
  [
    'globalid',
    'shape__area',
    'shape__length',
    'shape.starea()',
    'shape.stlength()',
    'createdate',
    'created_date',
    'creationdate',
    'creator',
    'created_user',
    'editdate',
    'edit_date',
    'lasteditdate',
    'last_edited_date',
    'editor',
    'last_edited_user',
  ].map((name) => name.toLowerCase()),
);

/** Trim strings, and read a blank cell as null so `''` and NULL do not alternate. */
function clean(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function text(attributes: Attributes, field: string | null): string | null {
  if (field === null) return null;
  const value = attributes[field];
  return value === null || value === undefined ? null : String(value);
}

/** A point's coordinate, or null for a polygon layer or a record with no shape. */
function coordinate(feature: Feature): { lat: number | null; lng: number | null } {
  const geometry = feature.geometry as { x?: unknown; y?: unknown } | undefined;
  const lng = typeof geometry?.x === 'number' && Number.isFinite(geometry.x) ? geometry.x : null;
  const lat = typeof geometry?.y === 'number' && Number.isFinite(geometry.y) ? geometry.y : null;
  // A shape at exactly (0, 0) is Esri's null island, not the Gulf of Guinea.
  if (lat === 0 && lng === 0) return { lat: null, lng: null };
  return { lat, lng };
}

/**
 * md5 over the attributes that define a version, plus the coordinate.
 *
 * Keys are sorted so the hash does not depend on the order the server
 * happened to serialize them in, and coordinates are rounded to 6dp (~10cm)
 * so float noise in a reprojection does not open a version — the same
 * rounding the Airbnb side uses in `VERSION_KEY_SQL`.
 */
function hashAttributes(
  attributes: Attributes,
  objectIdField: string,
  lat: number | null,
  lng: number | null,
): string {
  const skip = new Set([objectIdField.toLowerCase(), ...HOUSEKEEPING_FIELDS]);
  const entries = Object.entries(attributes)
    .filter(([name]) => !skip.has(name.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const round = (value: number | null): number | null =>
    value === null ? null : Math.round(value * 1e6) / 1e6;
  return createHash('md5')
    .update(JSON.stringify([entries, round(lat), round(lng)]))
    .digest('hex');
}

/**
 * The SCD2 key: the normalized registration number.
 *
 * Two records can fail to have one of their own — a row whose number is
 * blank or unparseable, and the second of two rows sharing a number (one
 * registration covering two units, or a duplicate the clerk's office has not
 * merged). Both fall back to the layer's object id, which identifies the row
 * only until the publisher rebuilds the layer; the
 * `registration_id_present` and `duplicate_registration_ids` checks report
 * how many records are in that position.
 */
function recordKey(registrationId: string | null, objectId: number | null, unique: boolean): string {
  if (registrationId !== null && unique) return registrationId;
  const suffix = objectId === null ? 'unknown' : String(objectId);
  return `${registrationId ?? 'oid'}#${suffix}`;
}

/** Standardize one extract. Keys are assigned across the whole set, so it takes all of it. */
export function toRecords(
  features: readonly Feature[],
  fieldMap: FieldMap,
  objectIdField: string,
): RegistrationRecord[] {
  const counts = new Map<string, number>();
  const partial = features.map((feature) => {
    const attributes: Attributes = {};
    for (const [name, value] of Object.entries(feature.attributes)) attributes[name] = clean(value);

    const registrationLabel = text(attributes, fieldMap.registrationId);
    const registrationId = normalizeRegistrationId(registrationLabel);
    if (registrationId !== null) counts.set(registrationId, (counts.get(registrationId) ?? 0) + 1);

    const rawObjectId = attributes[objectIdField];
    const objectId = typeof rawObjectId === 'number' ? rawObjectId : null;
    const { lat, lng } = coordinate(feature);

    return {
      registrationId,
      registrationLabel,
      objectId,
      status: text(attributes, fieldMap.status),
      registrationType: text(attributes, fieldMap.registrationType),
      address: text(attributes, fieldMap.address),
      unit: text(attributes, fieldMap.unit),
      zip: text(attributes, fieldMap.zip),
      parcelId: text(attributes, fieldMap.parcelId),
      operatorName: text(attributes, fieldMap.operatorName),
      issuedDate: fromEsriDate(fieldMap.issuedDate && attributes[fieldMap.issuedDate]),
      expiresDate: fromEsriDate(fieldMap.expiresDate && attributes[fieldMap.expiresDate]),
      editedDate: fromEsriDate(fieldMap.editedDate && attributes[fieldMap.editedDate]),
      locationLat: lat,
      locationLng: lng,
      attributes,
      attrsHash: hashAttributes(attributes, objectIdField, lat, lng),
    };
  });

  return partial.map((record) => ({
    recordKey: recordKey(
      record.registrationId,
      record.objectId,
      record.registrationId !== null && counts.get(record.registrationId) === 1,
    ),
    ...record,
  }));
}

/** Registration numbers held by more than one record in this extract. */
export function duplicateRegistrationIds(records: readonly RegistrationRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.registrationId === null) continue;
    counts.set(record.registrationId, (counts.get(record.registrationId) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
}
