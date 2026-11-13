CREATE TABLE "property_parcel_imports" (
	"import_date" date NOT NULL,
	"run_started_at" timestamp NOT NULL,
	"run_finished_at" timestamp,
	"parcels_imported" integer,
	"source_ingest_run" varchar,
	"error_summary" varchar
);
--> statement-breakpoint
CREATE TABLE "property_parcels" (
	"parcel_id" varchar PRIMARY KEY NOT NULL,
	"parcel_address" varchar,
	"property_type" varchar,
	"total_living_units" integer,
	"land_use" varchar,
	"zoning_district" varchar,
	"centroid_lat" double precision,
	"centroid_lon" double precision,
	"valid_from" timestamp,
	"imported_date" date NOT NULL
);
