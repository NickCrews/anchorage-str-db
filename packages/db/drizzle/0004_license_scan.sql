CREATE TABLE "muni_license_hidden_reads" (
	"cityview_license_id" integer NOT NULL,
	"scrape_date" date NOT NULL,
	CONSTRAINT "muni_license_hidden_reads_cityview_license_id_scrape_date_pk" PRIMARY KEY("cityview_license_id","scrape_date")
);
--> statement-breakpoint
CREATE TABLE "muni_license_runs" (
	"scrape_date" date NOT NULL,
	"run_started_at" timestamp NOT NULL,
	"run_finished_at" timestamp,
	"newest_cityview_license_id" integer,
	"pages_attempted" integer,
	"pages_read" integer,
	"hidden_read" integer,
	"pages_failed" integer,
	"licenses_new" integer,
	"licenses_status_changed" integer,
	"error_summary" varchar
);
--> statement-breakpoint
ALTER TABLE "muni_license_page_reads" ADD COLUMN "submittals" STRUCT(name VARCHAR, type VARCHAR, date DATE, status VARCHAR)[];