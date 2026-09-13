# Product Requirement Document for Anchorage STR DB

Three main users:
a. housing researchers and experts
b. policy makers, such as girdwood board of supervisor members
c. members of the public

This will work for all of anchorage muni, even though I need it just for girdwood,
we will need anchorage as a baseline, to the same full depth as girdwood.

This will help answer the basic questions
- how are STRs affecting the girdwood housing market
- how can we characterize these STRs
- what policy levers could we pull and how would they affect STRs (ie conversion to long term rentals or owner-occupied)
- How do these change over time, location, housing type, other sub-populations

This repo serves as feedstock of data, but it doesn't contain opinions or analysis.
Other repos/projects should be able to pull data easily from this programmatically.

## DB Requirements

What we publish as a duckdb file for an agent to query. Some subset shown in the web ui.
Aim to pull fresh data every day.

### Join keys

So downstream repos can pull this data and join it against other sources
(property/parcel db, voterfile, etc) without talking to us first:
- `host_id` — the primary host's Airbnb user id, stable for the life of the
  host account. On `listings`; a room changing hands opens a new version.
  Co-hosts are not recorded.
- `room_id` — stable for the life of a room, per Rooms #2.
- location — `lat`/`lon`, with a flag for jittered vs exact (see Rooms #3).
  `location_exact_address` is null for most rooms, so join on coordinates.

### Hosts

1. MUST store a host profile and the history of their listings.
  a. see if a room in girdwood is owned by a tycoon or an on-prem owner
  b. store name and bio so downstream users can try to link to voterfile/property db to see if they live in girdwood or anchorage.
  c. see year they started hosting (web ui shows "11 years hosting")
  d. host_id, stable for the life of the host account

### Rooms

2. id'ed by room id in url.
3. `lat`/`lon` are never null, and are stable for the life of the room.
   Street address is nullable and null for most rooms, because Airbnb only
   publishes one when the host opts in. See the follow-up below.
4. Get as near an exact date for when the room was first available using the review history for the room
5. store the most recent set of photo urls for thumbnails in a web app viewer
6. History of dates available, price, n beds, n baths, n guests, room type (whole house, room, etc)
  "Not available" does not always mean a guest booking; hosts can block nights
7. Last updated date for freshness signal
8. URL to str rental page for someone to verify/explore more

## Non-goals and Limitations

- In this repo we don't measure the rest of the housing market, the property ownership db, etc.
  Those may be handled separately.
- Airbnb only (no Vrbo/Expedia yet)
- History starts when you start collecting; no retroactive backfill
- Some map points are intentionally blurred by Airbnb for privacy
- No price for booked nights (Rooms #6). Airbnb prices a stay only while it
  is bookable, so each day records a quote for one open stay per listing.
  See [`research/airbnb-calendar-price.md`](research/airbnb-calendar-price.md).
- No schema stability guarantee yet. This is alpha; the schema may change at
  any time.
- A host can delete a listing and relist the same physical unit under a new
  room_id to shed bad reviews or dodge a registration requirement. We don't
  currently detect this.

## Follow-ups (not now)

- **Street address for rooms that don't publish one.** `location_exact_address`
  is stored when Airbnb provides it; nothing resolves the rest (no parcel
  matching, geocoding, or photo matching). The most practical route is a
  public-records request to the Municipality; see
  [`research/airbnb-address-deanonymization.md`](research/airbnb-address-deanonymization.md).
- Neighborhood/sub-area tagging (e.g. girdwood vs. rest of anchorage) beyond
  raw lat/lon.
- Trust/quality signal exposed to downstream consumers (scrape health,
  staleness, gaps). Out of scope for now, deal with it later.

## Privacy

This only scrapes and stores data that is already public.
We need to be able to store the names and addresses of hosts and rooms
so that our results can be verified.
We don't do any voterfile linking or anything in this repo, only public STR data.