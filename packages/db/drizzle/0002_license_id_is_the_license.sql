-- The `LC260500349` value identifies the license, not the licensee, despite
-- the CityView page labelling it "Licensee Number": every one of the 312
-- business names holding more than one registration holds a separate one for
-- each. So it takes `license_id`, and CityView's internal row id — the
-- `licenseId` in the page's URL, which nobody outside the portal sees — takes
-- `cityview_license_id`.
--
-- `muni_license_page_reads` holds both, so its vacating rename comes first.
ALTER TABLE "muni_license_page_reads" RENAME COLUMN "license_id" TO "cityview_license_id";--> statement-breakpoint
ALTER TABLE "muni_license_page_reads" RENAME COLUMN "licensee_id" TO "license_id";--> statement-breakpoint
ALTER TABLE "muni_str_registration_observations" RENAME COLUMN "licensee_id" TO "license_id";
