/**
 * `registry probe <url>`: describe a candidate layer without writing anything.
 *
 * This exists because the endpoint is the one thing about this source that
 * cannot be settled from a desk. Point it at a URL and it prints what the
 * layer calls itself, every field beside the column `fields.ts` mapped it to,
 * and a few real records. That is enough to tell the registrations from
 * some other layer, and to see which names `FIELD_ALIASES` is missing.
 *
 * Output goes to stdout, so it can be redirected into a file or a diff;
 * progress and errors go to stderr through `log`.
 */

import { fetchLayerInfo } from './arcgis/layer.ts';
import { queryByObjectIds, queryObjectIds } from './arcgis/query.ts';
import { PROBE_SAMPLE_SIZE } from './config.ts';
import { CANONICAL_FIELDS, mapFields, unmappedFields } from './fields.ts';
import { toRecords } from './records.ts';
import { withRetries } from './retry.ts';

/** Pad to a column width, for the field table. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export async function probe(url: string, write: (line: string) => void): Promise<void> {
  const layer = await withRetries(() => fetchLayerInfo(url), 'layer metadata');
  const fieldMap = mapFields(layer.fields);
  const unmapped = unmappedFields(layer.fields, fieldMap, layer.objectIdField);

  write(`layer:        ${layer.name}`);
  write(`url:          ${layer.url}`);
  write(`geometry:     ${layer.geometryType ?? 'none (table)'}`);
  write(`object id:    ${layer.objectIdField}`);
  write(`page size:    ${layer.maxRecordCount ?? 'unstated'}`);
  write(
    `last edited:  ${layer.lastEditMs === null ? 'not published' : new Date(layer.lastEditMs).toISOString()}`,
  );

  const objectIds = await withRetries(() => queryObjectIds(url), 'object ids');
  write(`records:      ${objectIds.length}`);
  write('');

  // Which column claimed each field, so a missing alias is obvious.
  const byLayerField = new Map<string, string>();
  for (const column of CANONICAL_FIELDS) {
    const name = fieldMap[column];
    if (name !== null) byLayerField.set(name, column);
  }
  const nameWidth = Math.max(4, ...layer.fields.map((field) => field.name.length));
  const typeWidth = Math.max(4, ...layer.fields.map((field) => field.type.length));
  write(`${pad('field', nameWidth)}  ${pad('type', typeWidth)}  column`);
  for (const field of layer.fields) {
    write(
      `${pad(field.name, nameWidth)}  ${pad(field.type, typeWidth)}  ` +
        (byLayerField.get(field.name) ?? '-'),
    );
  }
  if (unmapped.length > 0) {
    write('');
    write(`${unmapped.length} fields mapped to no column; they are stored in attributes only.`);
    write('To give one a column, add its name to FIELD_ALIASES in src/fields.ts.');
  }

  if (objectIds.length === 0) return;
  const sample = objectIds.slice(0, PROBE_SAMPLE_SIZE);
  const features = await withRetries(
    () => queryByObjectIds(url, sample, layer.geometryType !== null),
    'sample records',
  );
  const records = toRecords(features, fieldMap, layer.objectIdField);

  write('');
  write(`first ${records.length} records, as this package would store them:`);
  for (const record of records) {
    write('');
    write(JSON.stringify(record, null, 2));
  }
}
