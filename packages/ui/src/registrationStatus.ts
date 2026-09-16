import {sql, type Column, type SQL} from 'drizzle-orm';

/**
 * The columns of `listings_current_with_registration` that say how a listing's
 * number matched. Typed by name rather than as the view, so a query can pass
 * the view itself or a subquery that carries the same columns.
 */
type Matched = Record<
  'strRegistrationId' | 'registrationFound' | 'registrationIsCurrent',
  Column
>;

export const REGISTRATION_STATUSES = [
  'Registered',
  'Registration not current',
  'Number not in registry',
  'No number shown',
] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * Classifies a row of `listings_current_with_registration` by how its STR
 * registration number matches the Muni registry. The `CASE` is declared as
 * returning one of `REGISTRATION_STATUSES`, so a query that selects or
 * filters on it is checked against that list rather than against `string`.
 *
 * "Number not in registry" includes numbers issued since the Muni last
 * published its layer, so it is not proof of an invalid number.
 */
export const registrationStatusSql = (r: Matched): SQL<RegistrationStatus> => sql`CASE
    WHEN ${r.strRegistrationId} IS NULL THEN 'No number shown'
    WHEN NOT ${r.registrationFound} THEN 'Number not in registry'
    WHEN NOT ${r.registrationIsCurrent} THEN 'Registration not current'
    ELSE 'Registered'
  END`;
