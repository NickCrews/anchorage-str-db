CREATE TABLE "muni_address_geocodes" (
	"address" varchar PRIMARY KEY NOT NULL,
	"geocoded_date" date NOT NULL,
	"matched_address" varchar,
	"lat" double precision,
	"lng" double precision,
	"community_council" varchar,
	"score" double precision,
	"match_type" varchar
);
--> statement-breakpoint
CREATE TABLE "muni_parcel_types" (
	"parcel_id" varchar PRIMARY KEY NOT NULL,
	"read_date" date NOT NULL,
	"in_layer" boolean NOT NULL,
	"property_type" varchar
);
