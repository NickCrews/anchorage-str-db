# Product Requirement Document for Anchorage STR DB

Three main users:
a. housing researchers and experts
b. policy makers, such as Girdwood Board of Supervisors members
c. members of the public

This will work for all of the Anchorage Muni, even though I need it just for
Girdwood: we need the rest of Anchorage as a baseline, to the same full depth
as Girdwood.

This will help answer the basic questions
- how are short-term rentals affecting the Girdwood housing market
- how can we characterize these rentals
- what policy levers could we pull and how would they affect them (ie conversion to long term rentals or owner-occupied)
- How do these change over time, location, housing type, other sub-populations

The database is feedstock: it records what the sources publish, with no
opinions or estimates, and other repos/projects should be able to pull data
easily from it programmatically. The viewer in `packages/ui` is where analysis
lives: it tells the story chapter by chapter and estimates revenue and
occupancy in the browser, so those interpretations never enter the database.

How the requirements below are met, and where they fall short, is in
[methodology.md](methodology.md).

## DB Requirements

What we publish as a duckdb file for an agent to query. Some subset shown in the web ui.
Aim to pull fresh data every day.

### Join keys

So downstream repos can pull this data and join it against other sources
(voterfile, etc) without talking to us first:
- `listing_id` — stable for the life of a listing, per Listings #2.
- `host_id` — the primary host's Airbnb user id, stable for the life of the
  host account. On `listings`; a listing changing hands opens a new version.
  Co-hosts are not recorded.
- `registration_id` — the Muni's STR registration id, on `registrations` and
  on every listing that shows one.
- `parcel_id` — the Muni's 11-digit Parcel_ID, on `registrations`,
  `licenses` and `property_parcels`, and on a listing through its
  registration.
- coordinate — a listing's `location_lat`/`location_lng`, with
  `location_is_exact` saying whether it is exact or jittered; a
  registration's geocoded coordinate.

### Hosts

1. MUST store a host profile and the history of their listings.
  a. see whether a Girdwood listing belongs to a large portfolio or an on-premise owner
  b. store name and bio so downstream users can try to link to voterfile/property db to see if they live in Girdwood or Anchorage.
  c. see year they started hosting (web ui shows "11 years hosting")
  d. host_id, stable for the life of the host account

### Listings

2. id'ed by the listing id in the url.
3. Coordinates are never null and are stable for the life of the listing.
   A street address, parcel and owner of record come from the registration
   the listing shows; a listing showing none has only its coordinate.
4. Get as near an exact date as possible for when the listing was first available, using its review history
5. store the most recent set of photo urls for thumbnails in a web app viewer
6. History of dates available, price, n beds, n baths, n guests, listing type (whole house, private room, etc)
  "Not available" does not always mean a guest booking; hosts can block nights
7. Last updated date for freshness signal
8. URL to str rental page for someone to verify/explore more

### Registrations and parcels

9. MUST store every STR registration the Muni publishes, active or not: the
   registrant, address, parcel, community council, issue and expiry dates,
   and the license's own description of the business.
10. MUST store every Muni parcel's current owner of record, mailing address,
    property type, living units and exemptions, so a registered listing can be
    traced to its owner and whether the owner claims it as their primary
    residence.

## Non-goals

- Measuring the rest of the housing market. Parcel history and the
  non-STR housing stock belong to
  [anchorage-property](https://github.com/NickCrews/anchorage-property);
  this repo copies its current parcels.
- Platforms other than Airbnb, for now.
- Retroactive backfill: history starts when collection started.
- Schema stability. This is alpha; the schema may change at any time.

## Follow-ups (not now)

- **An address for listings that show no registration id.** See
  [`research/airbnb-address-deanonymization.md`](research/airbnb-address-deanonymization.md)
  and [`research/registration-inference/`](research/registration-inference/README.md).
- **Dwellings.** One row per dwelling and room across listings and
  registrations ([#40](https://github.com/NickCrews/anchorage-str-db/issues/40)),
  with combo listings marked
  ([#38](https://github.com/NickCrews/anchorage-str-db/issues/38)).
- **A host's whole portfolio**, not just their listings inside the Muni
  ([#34](https://github.com/NickCrews/anchorage-str-db/issues/34)).
- **Relisting.** Detect a host deleting a listing and relisting it under a
  new `listing_id` to shed bad reviews or dodge registration.

## Privacy

This only scrapes and stores data that is already public: Airbnb's
listing and host pages, the Muni's license pages, and the Muni's parcel
records. We need to be able to store the names and addresses of hosts,
registrants and owners of record so that our results can be verified.
We don't do any voterfile linking in this repo.
