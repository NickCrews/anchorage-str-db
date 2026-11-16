/**
 * Classifies a row of `listings_active_with_registration` by how its STR
 * registration id matches the Muni registry. `alias` is the table alias
 * the query gives that view.
 *
 * "Id not in registry" includes ids issued since the license scrape last read
 * new license ids, so it is not proof of an invalid id.
 */
export const registrationStatusSql = (alias: string) => `CASE
    WHEN ${alias}.registration_id IS NULL THEN 'No id shown'
    WHEN NOT ${alias}.registration_found THEN 'Id not in registry'
    WHEN NOT ${alias}.registration_is_active THEN 'Registration lapsed'
    ELSE 'Registered'
  END`;

export const REGISTRATION_STATUSES = [
  'Registered',
  'Registration lapsed',
  'Id not in registry',
  'No id shown',
] as const;
