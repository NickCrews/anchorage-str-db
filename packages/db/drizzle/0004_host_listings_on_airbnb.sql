-- A host's listing count across all of Airbnb, read from their profile, beside
-- the Anchorage-only count `host_listing_portfolios` derives. Nullable: rows
-- written before the profile-listings pass have no read to report.
ALTER TABLE "airbnb_host_observations" ADD COLUMN "listings_on_airbnb_read_ok" boolean;--> statement-breakpoint
ALTER TABLE "airbnb_host_observations" ADD COLUMN "listings_on_airbnb" integer;--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_attempted" integer;--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_failed" integer;