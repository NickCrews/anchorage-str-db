/**
 * Classifies a row of `listings_current_with_registration` by how its STR
 * registration number matches the Muni registry. `alias` is the table alias
 * the query gives that view.
 *
 * "Number not in registry" includes numbers issued since the Muni last
 * published its layer, so it is not proof of an invalid number.
 */
export const registrationStatusSql = (alias: string) => `CASE
    WHEN ${alias}.str_registration_id IS NULL THEN 'No number shown'
    WHEN NOT ${alias}.registration_found THEN 'Number not in registry'
    WHEN NOT ${alias}.registration_is_current THEN 'Registration not current'
    ELSE 'Registered'
  END`;

export const REGISTRATION_STATUSES = [
  'Registered',
  'Registration not current',
  'Number not in registry',
  'No number shown',
] as const;
