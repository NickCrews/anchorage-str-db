import {sql, type Column, type SQL} from 'drizzle-orm';

/**
 * The columns of `listings_current_with_registration` that say how a listing's
 * number matched. Typed by name rather than as the view, so a query can pass
 * the view itself or an `alias()` of it, whose columns carry the alias.
 */
type Matched = Record<
  'strRegistrationId' | 'registrationFound' | 'registrationIsCurrent',
  Column
>;

/**
 * Classifies a row of `listings_current_with_registration` by how its STR
 * registration number matches the Muni registry.
 *
 * "Number not in registry" includes numbers issued since the Muni last
 * published its layer, so it is not proof of an invalid number.
 */
export const registrationStatusSql = (r: Matched): SQL => sql`CASE
    WHEN ${r.strRegistrationId} IS NULL THEN 'No number shown'
    WHEN NOT ${r.registrationFound} THEN 'Number not in registry'
    WHEN NOT ${r.registrationIsCurrent} THEN 'Registration not current'
    ELSE 'Registered'
  END`;

export const REGISTRATION_STATUSES = [
  'Registered',
  'Registration not current',
  'Number not in registry',
  'No number shown',
] as const;
