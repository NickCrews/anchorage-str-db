-- `room_type` becomes `listing_type`. The values are Airbnb's display text
-- ('Entire home/apt', 'Private room', 'Shared room', 'Hotel room') and stay
-- verbatim, but the concept is "how much of a unit this listing covers",
-- which is a property of the listing. "Room type" is Airbnb's word for it,
-- and it only fits Airbnb: a unit-level equivalent for housing policy would
-- not have hotel rooms or single rooms in it at all.
--
-- A column rename, so the archive is untouched and each column keeps its
-- position, which `appendRows` depends on.
ALTER TABLE "airbnb_listing_observations" RENAME COLUMN "room_type" TO "listing_type";
