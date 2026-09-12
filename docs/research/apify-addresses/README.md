# Apify "Airbnb location" actor (`fKjuTGhSmE1YcZqSB`)

There is an apify provider https://console.apify.com/actors/fKjuTGhSmE1YcZqSB/input
that claims to give the street address for a given room.
TLDR: not usable, gives the wrong address, they fudge it with a geocode using nominatim
using the jittered coords.

Tested 2026-09-12 on 3 listings from `listings` (`sample_listings.csv`), input in `input.json`.
The actor's output is in `responses.js`, written by
`APIFY_TOKEN=... ./fetch-responses.sh` (each run uses Apify quota). Open `review.html` to compare each
result with Google Street View at the returned coordinates.

## Finding: the address is a reverse geocode of Airbnb's approximate pin

The actor reads the listing's public latitude/longitude (the same fuzzed
coordinates we already store in `location_lat`/`location_lng`) and reverse
geocodes them with OpenStreetMap Nominatim. It does not reveal the real street
address.

Evidence:

- Returned coordinates match our DB to 5 decimals for all 3 listings.
- The address fields (`house_number`, `road`, `neighbourhood`, `suburb`, ...)
  are Nominatim's schema. Querying Nominatim directly with listing 1101681's
  coordinates returns the identical `full_address`.
- Both listings checked by hand (using `review.html`) are at a different address
  than the actor returned.

| room_id | Airbnb pin | actor `full_address` | true address |
|---|---|---|---|
| 1101681 | [61.29751, -149.41675](https://www.google.com/maps/search/?api=1&query=61.29751,-149.41675) | [Coleman Circle, Anchorage, Alaska, 99518](https://www.google.com/maps/search/?api=1&query=Coleman+Circle%2C+Anchorage%2C+Alaska%2C+99518) | [8475 Ruth Dr, Eagle River, AK 99577](https://www.google.com/maps/search/?api=1&query=8475+Ruth+Dr%2C+Eagle+River%2C+AK+99577) |
| 4694553 | [61.22077, -149.75726](https://www.google.com/maps/search/?api=1&query=61.22077,-149.75726) | [300 Donna Drive, Peppertree, Anchorage, Alaska, 99504](https://www.google.com/maps/search/?api=1&query=300+Donna+Drive%2C+Anchorage%2C+Alaska%2C+99504) | [6682 Whispering Loop, Anchorage, AK 99504](https://www.google.com/maps/search/?api=1&query=6682+Whispering+Loop%2C+Anchorage%2C+AK+99504) |
| 6248973 | [61.2076, -149.85884](https://www.google.com/maps/search/?api=1&query=61.2076,-149.85884) | [1298 East 15th Avenue, Fairview, Anchorage, Alaska, 99501](https://www.google.com/maps/search/?api=1&query=1298+East+15th+Avenue%2C+Anchorage%2C+Alaska%2C+99501) | not checked |

Airbnb offsets unbooked listings' pins by up to a few hundred meters, so a
house number from this actor is a nearby building, not the listing.

### Why 1101681 comes back as "Anchorage, 99518"

The pin is in Eagle River, and Nominatim matches it to the Coleman Circle there
(OSM way 8906413), which runs beside the true address on Ruth Dr. The street is
right but the rest of the address is not:

- `city: Anchorage` is the Municipality of Anchorage boundary (admin level 6),
  which contains Eagle River. OSM has no Eagle River place in that street's
  address hierarchy, so the town name never appears.
- `postcode: 99518` is Nominatim's `calculated_postcode`: the street has no
  postcode tag in OSM, so Nominatim estimates one, and here the estimate is a
  south Anchorage zip. Eagle River is 99577.

Nominatim's details endpoint shows both:
`https://nominatim.openstreetmap.org/details.php?osmtype=W&osmid=8906413&addressdetails=1&format=json`

## Other fields

`property_type`, `room_type`, `guests`, `rating`, `is_superhost` were populated.
`bedrooms`, `beds`, `bathrooms`, `review_count`, `host_name`, `price_per_night`
were null for all 3. The existing scraper already collects everything that came back.

The run completed synchronously in ~4 s with no errors.