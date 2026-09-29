-- The count of every listing on a host's profile, wherever it is, beside the
-- Anchorage-only counts `host_listing_portfolios` derives. Rows written before
-- this pass existed hold NULL in both columns, which reads as "not read".
ALTER TABLE "airbnb_host_observations" ADD COLUMN "listings_anywhere_read_ok" boolean;--> statement-breakpoint
ALTER TABLE "airbnb_host_observations" ADD COLUMN "listings_anywhere" integer;--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_attempted" integer;--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_failed" integer;
