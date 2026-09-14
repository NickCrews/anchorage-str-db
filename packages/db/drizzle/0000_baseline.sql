-- IF NOT EXISTS so that a file which already has these tables reaches
-- connect's schema check, which explains any difference, instead of failing here.
CREATE TABLE IF NOT EXISTS "airbnb_calendar_status" (
	"listing_id" bigint NOT NULL,
	"night_date" date NOT NULL,
	"available" boolean NOT NULL,
	"min_nights" integer,
	"status_hash" varchar NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"is_current" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "airbnb_host_observations" (
	"host_id" bigint NOT NULL,
	"scrape_date" date NOT NULL,
	"profile_read_ok" boolean NOT NULL,
	"name" varchar,
	"about" varchar,
	"time_as_host_years" integer,
	"time_as_host_months" integer,
	CONSTRAINT "airbnb_host_observations_host_id_scrape_date_pk" PRIMARY KEY("host_id","scrape_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "airbnb_listing_first_reviews" (
	"listing_id" bigint PRIMARY KEY NOT NULL,
	"first_review_date" date,
	"resolved_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "airbnb_listing_observations" (
	"listing_id" bigint NOT NULL,
	"scrape_date" date NOT NULL,
	"name" varchar,
	"property_title" varchar,
	"location_lat" double precision,
	"location_lng" double precision,
	"url" varchar,
	"badges" "VARCHAR"[],
	"rating_value" double precision,
	"review_count" integer,
	"price_hint_per_night" double precision,
	"price_qualifier" varchar,
	"page_fetch_ok" boolean NOT NULL,
	"location_is_exact" boolean,
	"location_exact_address" varchar,
	"location_subtitle" varchar,
	"location_verified" boolean,
	"str_registration_id" varchar,
	"host_id" bigint,
	"room_type" varchar,
	"guest_capacity" integer,
	"beds" integer,
	"bedrooms" varchar,
	"bathrooms" varchar,
	"quote_check_in" date,
	"quote_nights" integer,
	"quote_total" double precision,
	"quote_label" varchar,
	"quote_breakdown" "VARCHAR"[],
	CONSTRAINT "airbnb_listing_observations_listing_id_scrape_date_pk" PRIMARY KEY("listing_id","scrape_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "airbnb_listing_photos" (
	"listing_id" bigint NOT NULL,
	"valid_from" date NOT NULL,
	"photo_urls" "VARCHAR"[] NOT NULL,
	CONSTRAINT "airbnb_listing_photos_listing_id_valid_from_pk" PRIMARY KEY("listing_id","valid_from")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "airbnb_scrape_runs" (
	"scrape_date" date NOT NULL,
	"run_started_at" timestamp NOT NULL,
	"run_finished_at" timestamp,
	"listings_seen" integer,
	"listings_new" integer,
	"listings_changed" integer,
	"listings_retired" integer,
	"calendar_fetch_attempted" integer,
	"calendar_fetch_failed" integer,
	"calendar_nights_changed" integer,
	"page_fetch_attempted" integer,
	"page_fetch_failed" integer,
	"error_summary" varchar,
	"first_review_fetch_attempted" integer,
	"first_review_fetch_failed" integer,
	"quote_fetch_attempted" integer,
	"quote_fetch_failed" integer,
	"host_profile_attempted" integer,
	"host_profile_failed" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "muni_license_page_reads" (
	"license_id" integer NOT NULL,
	"scrape_date" date NOT NULL,
	"licensee_number" varchar NOT NULL,
	"business_name" varchar,
	"license_type" varchar,
	"status" varchar,
	"description" varchar,
	"locations" STRUCT(label VARCHAR, value VARCHAR, link VARCHAR)[] NOT NULL,
	"issuances" STRUCT(type VARCHAR, issued_date DATE, expires_date DATE, status VARCHAR, number VARCHAR)[] NOT NULL,
	CONSTRAINT "muni_license_page_reads_license_id_scrape_date_pk" PRIMARY KEY("license_id","scrape_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "muni_str_registration_observations" (
	"registration_number" varchar NOT NULL,
	"scrape_date" date NOT NULL,
	"application_number" varchar,
	"submitted_date" date,
	"issued_date" date,
	"expires_date" date,
	"location" varchar,
	"business_name" varchar,
	"status" varchar,
	"status_url" varchar,
	"community_council" varchar,
	"parcel_type" varchar,
	"geocoded_address" varchar,
	"geocoded_lat" double precision,
	"geocoded_lng" double precision,
	"published_at" timestamp,
	CONSTRAINT "muni_str_registration_observations_registration_number_scrape_date_pk" PRIMARY KEY("registration_number","scrape_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "muni_str_registry_runs" (
	"scrape_date" date NOT NULL,
	"run_started_at" timestamp NOT NULL,
	"run_finished_at" timestamp,
	"layer_data_edited_at" timestamp,
	"registrations_seen" integer,
	"registrations_new" integer,
	"registrations_departed" integer,
	"license_page_attempted" integer,
	"license_page_failed" integer,
	"error_summary" varchar
);
