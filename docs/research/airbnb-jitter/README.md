# How Airbnb jitters a listing's coordinate

Researched 2026-11-26 on the published database of 2026-11-16. Answers
[#82](https://github.com/NickCrews/anchorage-str-db/issues/82).

**Summary:** When a listing's location is not exact, Airbnb offsets latitude
and longitude independently, each by a random sign times a distance drawn
uniformly between 0.0002° and 0.0012°. The offset is in degrees, so at
Anchorage's latitude it reaches 133 m north–south and 64 m east–west. The
range does not vary with density within the Municipality. The true location
lies in a box around the pin, outside a cross through it, and every point in
that region is equally likely.

[notebook.py](notebook.py) is a [marimo](https://marimo.io) notebook with
the method, every figure and table, and download buttons for the data. It
runs in the browser, with nothing to install, at
<https://marimo.app/?src=https://github.com/NickCrews/anchorage-str-db/blob/main/docs/research/airbnb-jitter/notebook.py>.
Run locally, it reads `public/` beside it; in the browser it fetches
`public/` from the `main` branch on GitHub.

## Files

| File | What it is |
| --- | --- |
| [notebook.py](notebook.py) | The analysis. Reads `public/`. |
| [extract.sql](extract.sql) | Writes the CSVs in `public/` from the published database. |
| [public/listings.csv](public/listings.csv) | Active listings: pin, `is_exact`, printed registration id. |
| [public/registrations.csv](public/registrations.csv) | Active, geocoded registrations, with parcels within 500 m. |
| [public/flips.csv](public/flips.csv) | Listings seen with both an exact and a jittered coordinate. |

## Reproducing

```sh
gh release download latest-data --repo NickCrews/anchorage-str-db -O anchorage_str.duckdb
duckdb anchorage_str.duckdb -c ".read docs/research/airbnb-jitter/extract.sql"
uvx marimo edit --sandbox docs/research/airbnb-jitter/notebook.py
```

## Matching a jittered coordinate

A point can be the true location behind a jittered pin when its offset from
the pin is between 0.0002° and 0.0012° on both axes. Against a
registration's geocoded point, widen each edge by 30 m for geocoder error
(0.00027° of latitude, 0.00056° of longitude at 61.2°). That passes a
jittered listing's own registration 97.4% of the time with a mean of 7.0
candidates, where a 150 m circle passes 94.5% with 7.4.

```sql
SELECT l.listing_id, r.registration_id
FROM listings_active l
JOIN registrations_active r
  ON abs(r.geocoded_lat - l.location_lat) BETWEEN 0.0002 - 0.00027 AND 0.0012 + 0.00027
 AND abs(r.geocoded_lng - l.location_lng) BETWEEN 0.0002 - 0.00056 AND 0.0012 + 0.00056
WHERE NOT l.location_is_exact;
```
