-- Airbnb columns take airbnb-dlp's values.
--
-- `price_qualifier` ('for 5 nights') becomes `price_nights` (5), in place so
-- the column keeps its position, which `appendRows` depends on. Any other
-- text becomes NULL. `listing_type` takes airbnb-dlp's `roomType` values.
--
-- Both are ALTERs whose USING is a CASE over literals: DuckDB refuses an
-- UPDATE after an ALTER of the same table in one transaction, and cannot
-- replay a WAL holding an ALTER whose USING calls a function. `quote_label` is
-- dropped: a stay Airbnb will not quote keeps its check-in and nights with a
-- NULL total, and discounts are lines in `quote_breakdown`.
ALTER TABLE "airbnb_listing_observations" RENAME COLUMN "price_qualifier" TO "price_nights";--> statement-breakpoint
ALTER TABLE "airbnb_listing_observations" ALTER COLUMN "price_nights" SET DATA TYPE integer USING CASE "price_nights"
    WHEN 'for 1 night' THEN 1
    WHEN 'for 2 nights' THEN 2
    WHEN 'for 3 nights' THEN 3
    WHEN 'for 4 nights' THEN 4
    WHEN 'for 5 nights' THEN 5
    WHEN 'for 6 nights' THEN 6
    WHEN 'for 7 nights' THEN 7
    WHEN 'for 8 nights' THEN 8
    WHEN 'for 9 nights' THEN 9
    WHEN 'for 10 nights' THEN 10
    WHEN 'for 11 nights' THEN 11
    WHEN 'for 12 nights' THEN 12
    WHEN 'for 13 nights' THEN 13
    WHEN 'for 14 nights' THEN 14
    WHEN 'for 15 nights' THEN 15
    WHEN 'for 16 nights' THEN 16
    WHEN 'for 17 nights' THEN 17
    WHEN 'for 18 nights' THEN 18
    WHEN 'for 19 nights' THEN 19
    WHEN 'for 20 nights' THEN 20
    WHEN 'for 21 nights' THEN 21
    WHEN 'for 22 nights' THEN 22
    WHEN 'for 23 nights' THEN 23
    WHEN 'for 24 nights' THEN 24
    WHEN 'for 25 nights' THEN 25
    WHEN 'for 26 nights' THEN 26
    WHEN 'for 27 nights' THEN 27
    WHEN 'for 28 nights' THEN 28
    WHEN 'for 29 nights' THEN 29
    WHEN 'for 30 nights' THEN 30
    WHEN 'for 31 nights' THEN 31
END;--> statement-breakpoint
ALTER TABLE "airbnb_listing_observations" ALTER COLUMN "listing_type" SET DATA TYPE varchar USING CASE "listing_type"
    WHEN 'Entire home/apt' THEN 'entire_home'
    WHEN 'Private room' THEN 'private_room'
    WHEN 'Shared room' THEN 'shared_room'
    WHEN 'Hotel room' THEN 'hotel_room'
END;--> statement-breakpoint
ALTER TABLE "airbnb_listing_observations" DROP COLUMN "quote_label";
