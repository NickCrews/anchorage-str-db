-- Every source's run log is `<source>_scrape_runs`, stamped with
-- `scrape_date`, matching `airbnb_scrape_runs`. Renames only, so no row moves
-- and each column keeps its position, which `appendRows` depends on.
--
-- `connect` accepts the old table names until this migration runs: see
-- `RENAMED_TABLES` in `src/connect.ts`.
ALTER TABLE "muni_license_runs" RENAME TO "muni_license_scrape_runs";--> statement-breakpoint
ALTER TABLE "property_parcel_imports" RENAME TO "property_parcel_scrape_runs";--> statement-breakpoint
ALTER TABLE "property_parcel_scrape_runs" RENAME COLUMN "import_date" TO "scrape_date";--> statement-breakpoint
ALTER TABLE "property_parcel_scrape_runs" RENAME COLUMN "parcels_imported" TO "parcels_written";--> statement-breakpoint
ALTER TABLE "property_parcels" RENAME COLUMN "imported_date" TO "scrape_date";
