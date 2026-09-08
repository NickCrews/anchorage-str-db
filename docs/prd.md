# Product Requirement Document for Anchorage STR DB

Three main users:
a. housing researchers and experts
b. policy makers, such as girdwood board of supervisor members
c. members of the public

This will work for all of anchorage muni, even though I need it just for girdwood,
we will need anchorage as a baseline.

This will help answer the basic questions
- how are STRs affecting the girdwood housing market
- how can we characterize these STRs
- what policy levers could we pull and how would they affect STRs (ie conversion to long term rentals or owner-occupied)
- How do these change over time, location, housing type, other sub-populations

This repo serves as feedstock of data, but it doesn't contain opinions or analysis.
Other repos/projects should be able to pull data easily from this programmatically.

## DB Requirements

What we publish as a duckdb file for an agent to query. Some subset shown in the web ui

### Hosts

1. MUST store a host profile and the history of their listings.
  a. see if a room in girdwood is owned by a tycoon or an on-prem owner
  b. store name and bio so downstream users can try to link to voterfile/property db to see if they live in girdwood or anchorage.
  c. see year they started hosting (web ui shows "11 years hosting")

### Rooms

2. id'ed by room id in url.
3. street address and lat/lon are never never null, and should be stable for the life of the room
4. Get as near an exact date for when the room was first available using the review history for the room
5. store the most recent set of photo urls for thumbnails in a web app viewer
6. History of dates available, price, n beds, n baths, n guests, room type (whole house, room, etc)
  "Not available" does not always mean a guest booking; hosts can block nights

## Non-goals and Limitaions

- In this repo we don't measure the rest of the housing market, the property ownership db, etc.
  Those may be handled separately.
- Airbnb only (no Vrbo/Expedia yet)
- History starts when you start collecting; no retroactive backfill
- Some map points are intentionally blurred by Airbnb for privacy

## Privacy

This only scrapes and stores data that is already public.
We need to be able to store the names and addresses of hosts and rooms
so that our results can be verified.
We don't do any voterfile linking or anything in this repo, only public STR data.