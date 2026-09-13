/**
 * Layer metadata: `GET <layer>?f=json`.
 *
 * Read once per run, before any query. It supplies three things the extract
 * needs and one the run log wants:
 *
 * - the object-id field's name, which is `OBJECTID` on most layers and `FID`,
 *   `ESRI_OID` or a publisher's own name on the rest;
 * - `maxRecordCount`, the server's page size;
 * - the field list, which `fields.ts` maps to this package's columns, and
 *   which the `field_mapping_alive` check watches for renames;
 * - `editingInfo.lastEditDate`, when the publisher exposes it: the instant
 *   the layer was last edited, which is the cheapest available answer to
 *   "how often does this data actually change?" and is recorded on every run
 *   whether or not anything in the rows moved.
 */

import { requestJson } from './http.ts';

/** One field, as the layer describes itself. */
export interface LayerField {
  name: string;
  type: string;
  alias: string | null;
  /** Present on string fields; useful when deciding a column's width. */
  length: number | null;
}

export interface LayerInfo {
  url: string;
  name: string;
  /** `esriGeometryPoint`, `esriGeometryPolygon`, or null for a table. */
  geometryType: string | null;
  objectIdField: string;
  maxRecordCount: number | null;
  fields: LayerField[];
  /** Epoch milliseconds of the last edit, when the layer reports one. */
  lastEditMs: number | null;
}

interface RawLayer {
  name?: string;
  type?: string;
  geometryType?: string;
  objectIdField?: string;
  maxRecordCount?: number;
  fields?: Array<{ name?: string; type?: string; alias?: string; length?: number }>;
  editingInfo?: { lastEditDate?: number };
}

/**
 * The default object-id field name. ArcGIS omits `objectIdField` on some
 * older services even though every layer has one.
 */
const DEFAULT_OBJECT_ID_FIELD = 'OBJECTID';

/** Field types that hold the object id, in the order they are preferred. */
const OID_FIELD_TYPES = ['esriFieldTypeOID'];

export async function fetchLayerInfo(url: string): Promise<LayerInfo> {
  const raw = await requestJson<RawLayer>(url, {});
  const fields: LayerField[] = (raw.fields ?? []).map((field) => ({
    name: field.name ?? '',
    type: field.type ?? '',
    alias: field.alias ?? null,
    length: field.length ?? null,
  }));

  // Prefer the declared name, fall back to the field typed as an OID, and
  // only then to the conventional name.
  const declared = raw.objectIdField?.trim();
  const typed = fields.find((field) => OID_FIELD_TYPES.includes(field.type))?.name;

  return {
    url,
    name: raw.name ?? '(unnamed)',
    geometryType: raw.geometryType ?? null,
    objectIdField: declared || typed || DEFAULT_OBJECT_ID_FIELD,
    maxRecordCount: raw.maxRecordCount ?? null,
    fields,
    lastEditMs: raw.editingInfo?.lastEditDate ?? null,
  };
}
