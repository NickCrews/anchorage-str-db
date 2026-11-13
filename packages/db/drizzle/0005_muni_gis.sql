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
