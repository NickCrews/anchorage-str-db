import {sql, type Column, type SQL} from 'drizzle-orm';

/**
 * The columns of `listings_active_with_registration` that say how a listing's
 * registration id matched. Typed by name rather than as the view, so a query can pass
 * the view itself or a subquery that carries the same columns.
 */
type Matched = Record<
  'registrationId' | 'registrationFound' | 'registrationIsActive',
  Column
>;

export const REGISTRATION_STATUSES = [
  'Registered',
  'Registration lapsed',
  'Id not in registry',
  'No id shown',
] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * Classifies a row of `listings_active_with_registration` by how its STR
 * registration id matches the Muni registry. The `CASE` is declared as
 * returning one of `REGISTRATION_STATUSES`, so a query that selects or
 * filters on it is checked against that list rather than against `string`.
 *
 * "Id not in registry" includes ids issued since the Muni last published
 * its layer, so it is not proof of an invalid id.
 */
export const registrationStatusSql = (r: Matched): SQL<RegistrationStatus> => sql`CASE
    WHEN ${r.registrationId} IS NULL THEN 'No id shown'
    WHEN NOT ${r.registrationFound} THEN 'Id not in registry'
    WHEN NOT ${r.registrationIsActive} THEN 'Registration lapsed'
    ELSE 'Registered'
  END`;
