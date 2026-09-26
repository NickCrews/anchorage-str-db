-- The listings on each host's Airbnb profile, wherever they are, change-only
-- per (host, listing) in their own table, and the day's fetch outcome on the
-- host's observation row, with the responses verbatim when they didn't fit
-- the table. Nullable on the observation: rows written before the pass have
-- no fetch to report.
CREATE TABLE "airbnb_host_profile_listings" (
	"host_id" bigint NOT NULL,
	"listing_id" bigint NOT NULL,
	"valid_from" date NOT NULL,
	"listed" boolean NOT NULL,
	"name" varchar,
	"photo_url" varchar,
	"building_type" varchar,
	"listing_type" varchar,
	"listing_type_key" varchar,
	"rating_value" double precision,
	"review_count" integer,
	"is_superhost" boolean,
	"is_new_listing" boolean,
	CONSTRAINT "airbnb_host_profile_listings_host_id_listing_id_valid_from_pk" PRIMARY KEY("host_id","listing_id","valid_from")
);
--> statement-breakpoint
ALTER TABLE "airbnb_host_observations" ADD COLUMN "profile_listings_fetch_ok" boolean;--> statement-breakpoint
ALTER TABLE "airbnb_host_observations" ADD COLUMN "profile_listings_error" varchar;--> statement-breakpoint
ALTER TABLE "airbnb_host_observations" ADD COLUMN "profile_listings_responses" "VARCHAR"[];--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_attempted" integer;--> statement-breakpoint
ALTER TABLE "airbnb_scrape_runs" ADD COLUMN "host_listings_fetch_failed" integer;