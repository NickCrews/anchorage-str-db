import { sql, type Selection } from '@sqlrooms/mosaic';

/** Raw SQL as a Mosaic expression, for a predicate built from a known column and a quoted value. */
const rawSql = (text: string) => sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray);

/**
 * Sets `source`'s clause in the chapter selection to `column = value`, or
 * removes it when `value` is null or already selected. For plain charts
 * that filter on click, outside Mosaic's own interactors.
 */
export function toggleEqualsClause(selection: Selection, source: object, column: string, value: string | null) {
  const current = selection.clauses.find((c) => c.source === source)?.value;
  const next = value == null || value === current ? null : value;
  selection.update({
    source,
    value: next,
    predicate: next == null ? null : rawSql(`"${column}" = '${next.replaceAll("'", "''")}'`),
  } as never);
}

/** The value `source` currently selects, if any. */
export const selectedValue = (selection: Selection, source: object): string | null =>
  (selection.clauses.find((c) => c.source === source)?.value as string | undefined) ?? null;

/** The selection's SQL predicate leaving out `source`'s own clause, `true` when none remain. */
export function predicateWithout(xf: { selection: Selection }, source: object): string {
  const parts = xf.selection.clauses
    .filter((c) => c.source !== source && c.predicate != null)
    .map((c) => `(${String(c.predicate)})`);
  return parts.length ? parts.join(' AND ') : 'true';
}
