/**
 * Literals for SQL built as strings. To check a value against a closed set,
 * say so at the call site: `sqlLiteral('entire_home' satisfies ListingType)`.
 * This module imports nothing, so the browser UI uses it too.
 */

/** A SQL string literal, quotes doubled: `sqlLiteral("O'Malley")` is `'O''Malley'`. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A parenthesized list of SQL string literals, for `IN`: `('a', 'b')`. */
export function sqlList(values: readonly string[]): string {
  return `(${values.map(sqlLiteral).join(', ')})`;
}
