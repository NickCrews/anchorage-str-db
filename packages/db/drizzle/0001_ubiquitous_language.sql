-- Renames to the vocabulary in docs/TERMINOLOGY.md. No data moves: every statement is
-- a column rename, which keeps each column's position, so `appendRows`, which
-- writes by position, is unaffected.
--
-- `_number` becomes `_id`: these identifiers are alphanumeric (`STR20260309`,
-- `LC260500349`), so they are ids, not numbers. The registration id a listing
-- prints and the one the Clerk publishes are the same value and now share one
-- name. `location` becomes `registered_address`, since `location_*` on a
-- listing is a coordinate. A registration that leaves the layer has lapsed,
-- not departed.
ALTER TABLE "airbnb_listing_observations" RENAME COLUMN "str_registration_id" TO "registration_id";--> statement-breakpoint
ALTER TABLE "muni_str_registration_observations" RENAME COLUMN "registration_number" TO "registration_id";--> statement-breakpoint
ALTER TABLE "muni_str_registration_observations" RENAME COLUMN "application_number" TO "licensee_id";--> statement-breakpoint
ALTER TABLE "muni_str_registration_observations" RENAME COLUMN "location" TO "registered_address";--> statement-breakpoint
ALTER TABLE "muni_license_page_reads" RENAME COLUMN "licensee_number" TO "licensee_id";--> statement-breakpoint
ALTER TABLE "muni_str_registry_runs" RENAME COLUMN "registrations_departed" TO "registrations_lapsed";
