# Prior art: matching jittered Airbnb listings to addresses

Researched 2026-08-18. How researchers, cities and compliance vendors get from
a public Airbnb listing, with its jittered map pin, to a street address or
parcel. Background for eventually matching listings against Anchorage's STR
registry.

**Summary:** Most enforcement relies on legal compulsion rather than technical
de-anonymization: ordinances require platforms to disclose addresses or
parcel numbers, or to refuse bookings for unregistered listings. Technical
matching (image matching, geocoding, parcel triangulation) exists and is
patented and sold, but vendors use it where no disclosure law exists yet or to
build the case for one. Anchorage has a free self-registration portal, with no
platform disclosure law and no public registry.

---

## 1. Inside Airbnb

Inside Airbnb documents Airbnb's coordinate jitter and does not try to reverse
it. From its "Data Assumptions" page:

> "Location information for listings are anonymized by Airbnb ... In
> practice, this means the location for a listing on the map, or in the
> data will be from 0-450 feet (150 metres) of the actual address."
>
> "Listings in the same building are anonymized by Airbnb individually,
> and therefore may appear 'scattered' in the area surrounding the actual
> address."

Source: https://insideairbnb.com/data-assumptions/

Secondary academic sources describe the displacement as right-skewed with a
mean of roughly 150–200 m. No primary source gives Airbnb's parameters, so
treat that as an estimate.

Inside Airbnb's scraper is not public (`github.com/insideairbnb` returns 404);
it publishes only the jittered datasets.

## 2. Academic research

- **General location de-anonymization** (Gambs, Killijian & del Prado Cortez,
  "De-anonymization attack on geolocated data," *JCSS*, 2014,
  https://www.sciencedirect.com/science/article/pii/S0022000014000683; HMM
  trace attacks, https://www.tandfonline.com/doi/full/10.1080/17489725.2024.2385312)
  re-identifies people from mobility traces. It does not apply to a single
  static jittered point.
- **Airbnb spatial studies** (e.g. https://arxiv.org/pdf/2310.15302) treat the
  jitter as a limitation and aggregate to tract or neighborhood level. One
  methodological note: "for the purposes of point-level analysis the
  lowest-error option is to use the reported coordinates without
  modification."
- **No peer-reviewed paper was found that recovers individual Airbnb
  addresses from jittered coordinates.**
- Airbnb's obfuscation mechanism is patented; see §5.

## 3. Municipal enforcement

### 3a. Legal compulsion

Cities require platforms either to disclose each listing's address, parcel or
host, or to refuse bookings for listings without a valid registration id.

- **California SB 346** (effective 2026-01-01): lets cities compel platforms
  to disclose, per listing, the parcel number (APN), address, listing URL and
  ZIP, quarterly or monthly. A city must adopt an ordinance to use it.
  Sources: https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260SB346,
  https://sjud.senate.ca.gov/system/files/2025-05/sb-346-durazo-sjud-analysis.pdf,
  https://www.rentresponsibly.org/california-passes-bill-requiring-airbnb-vrbo-to-share-host-data-with-cities/,
  https://bbklaw.com/resources/la-010625-new-state-law-helps-cities-get-short-term-rental-information-from-airbnb-vrbo.
  An industry summary (https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/)
  notes that before SB 346, compliance vendors matched listings to properties
  because platforms wouldn't share the data.
- **New York City, Local Law 18 of 2022:** hosts register with the Office of
  Special Enforcement, and platforms must verify the registration id
  before processing a booking. Active Airbnb listings reportedly fell from
  ~22,000 to ~2,300 within about a year. Source:
  https://en.wikipedia.org/wiki/Local_Law_18_of_2022 (secondary; the numbers
  are unverified against NYC primary sources).
- **New Orleans, Ordinance 34,806** (effective March 2025): platforms verify
  listings against the city permit database before booking, re-verify
  regularly, and report monthly. Over 1,000 unlicensed listings were removed in
  August 2025, out of ~7,000 active against ~1,350 permitted units. Sources:
  https://www.avalara.com/mylodgetax/en/blog/2024/10/new-orleans-will-require-short-term-rental-platforms-to-verify-permits.html,
  https://www.snw.law/city-council-shifts-enforcement-burden-to-short-term-rental-platforms.
- **Santa Monica:** *HomeAway.com, Inc.; Airbnb, Inc. v. City of Santa Monica*
  (9th Cir. 2019) unanimously upheld an ordinance requiring platforms to
  collect occupancy tax, disclose listing and booking data, and refuse bookings
  and fees for unregistered properties. The court held this regulates booking
  transactions, not listing content, so it does not violate Section 230 or the
  First or Fourth Amendments. Later ordinances build on this ruling. Sources:
  https://www.santamonica.gov/press/2019/03/13/city-of-santa-monica-prevails-against-airbnb-and-homeaway-at-ninth-circuit-in-unanimous-decision,
  https://www.hansonbridgett.com/Publications/articles/2019-03-santa-monica-short-term-rental.
- **Honolulu:** passed platform fines of up to $10,000/day in 2019 but, after
  settling a lawsuit, has not enforced the platform-reporting provision, and
  still enforces against individual owners. Legal authority alone did not
  produce enforcement. Sources:
  https://www.civilbeat.org/2025/05/honolulu-can-fine-airbnb-vrbo-for-illegal-vacation-rentals-it-never-has/,
  https://www.civilbeat.org/2025/07/heres-why-honolulu-doesnt-enforce-law-against-short-term-rental-companies/.
- **Colorado mountain towns** (Breckenridge, Vail, Steamboat Springs, Summit
  County) run license regimes with per-listing numbers. No public documentation
  of their address-matching methods was found. Source:
  https://coloradosun.com/2023/09/05/mountain-town-short-term-rental-crackdown/.

### 3b. Commercial vendors

- **Deckard Technologies (Rentalscape STR):** claims to scan 15M+ listings on
  10,000+ sites daily and tie each to a parcel and address, using patented data
  mining, AI and image analysis checked by 50+ analysts. No method is
  disclosed. Source: https://deckard.com/short-term-rental.
- **GovOS** (successor to Host Compliance's STR product): claims to identify
  98% of STRs using automated detection plus "human-eye verification." Source:
  https://govos.com/products/short-term-rental/.
- **Granicus (formerly Host Compliance):** reportedly captures listings from
  70+ sites, cross-references bookings with permit databases, and generates
  violation notices; ~300 jurisdictions at acquisition, 500+ by 2024. No
  methodology found. Source:
  https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/.
- **Harmari (Avenu Insights & Analytics):** the only vendor with a detailed
  primary source. **US Patent 12,456,297 B2**, "System and method for
  identifying a location of an unlocated short term rental using image
  recognition" (assignee Avenu STR IP LLC; filed 2022-06-14, published
  2025-10-28; https://patents.google.com/patent/US12456297):
  1. Classify listing photos into seven types: Exterior House Front, Exterior
     House Rear, Exterior View Building, Common Elements, Interior View, View
     From Unit, View From Balcony.
  2. Detect doors, windows, house numbers, driveways and furniture.
  3. Pull comparison images near the jittered pin from property databases,
     real-estate sites and street-view services.
  4. Score same-type image matches; accept a location above a threshold.
  5. For multi-unit buildings, count floors via Fourier analysis of window
     patterns and triangulate landmarks to identify the unit.

  Secondary summary: https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/.

### 3c. Specific techniques

- **Reverse geocoding plus manual photo/street-view checks:** GovOS's
  human-verification step, and automated in the Harmari patent.
- **Host identity from reviews or iCal, matched to owner records:** likely
  defunct. Airbnb's December 2019 iCal change removed guest names and full
  phone numbers, and that data was about guests, not hosts. Source:
  https://www.uplisting.io/blog/how-the-airbnb-icalendar-ical-changes-will-affect-you-and-how-to-avoid-disruption.
  No current use was found.
- **House numbers and architectural features in photos:** in the Harmari
  patent. Consumer writeups also describe manual photo and street-view
  matching (Kingston News; could not be re-fetched, low confidence).
- **Cross-platform (Airbnb + Vrbo) fingerprinting:** AirDNA reportedly merges
  Airbnb and Vrbo properties within 600 m of each other (secondary source).
  Airbnb's patent US 11,869,106, "Cross-listed property matching using image
  descriptor features" (https://patents.justia.com/patent/11869106; coverage at
  https://www.thedailyupside.com/technology/airbnb-may-sniff-out-crosslisters/),
  detects hosts listing the same property elsewhere by classifying room photos.
- **Subpoenas and data-sharing laws:** the best-supported mechanism (§3a).
  Technical matching serves to find violators where no disclosure law exists
  and to audit where one does.

## 4. Open-source tools

- **`CodeForBc/airbnb-regulation`** (MIT): a Code for BC project that scrapes
  Airbnb and checks listings against BC's business registry, with a Grafana
  dashboard. It checks for a license number rather than resolving addresses,
  which is closest to checking Anchorage registration ids. Source:
  https://github.com/CodeForBc/airbnb-regulation.
- **Apify "Airbnb Address Finder":** a commercial actor claiming to resolve
  addresses; internals unverified. https://apify.com/kawsar/airbnb-address-finder.
- No maintained open-source listing-to-parcel matcher was found.

## 5. Airbnb's obfuscation mechanism

- **US Patent 11,774,260 B2**, "Dynamic obfuscation of a mapped point of
  interest" (Airbnb, Inc.; https://patents.google.com/patent/US11774260):
  an inner circle hides the exact point and an outer circle bounds the visible
  vicinity. Radii scale with population density so the number of candidate
  properties stays roughly constant: smaller in cities, larger in rural areas.
  The inner circle's screen size is held constant when zooming. Hosts can
  override the radii. This implies Girdwood, being rural, likely gets a larger
  offset than the ~150 m urban figure. No published rural radius was found.
- **Pre-booking map display** (secondary sources; Airbnb help pages returned
  403): the guest-facing map reportedly shows an area of about a half-mile
  radius, or ~0.7 mile before 2026. These are larger than the 150–200 m
  offset in the data. The guest-facing circle appears coarser than the
  coordinate the API returns, and this project stores the API coordinate.
- **2026 policy change** (secondary: StaySTRA, BNBCalc): from 2026-03-09 guests
  reportedly see the exact address on booking confirmation. This does not
  affect pre-booking search coordinates. Sources:
  https://staystra.com/airbnb-address-disclosure-policy-2026/,
  https://www.bnbcalc.com/blog/airbnb-business/how-to-start-airbnb/airbnb-address-disclosure-policy-2026.
  Low confidence without an Airbnb primary source.

## 6. Anchorage's STR registration program

- **AO 2025-115(S-2)** (approved 10-2) created a free online registration
  requirement, not a permit cap. The portal opened 2026-05-01; existing
  operators had to register by 2026-07-30; listings must show the municipal
  STR number from 2026-07-31. Sources:
  https://www.muni.org/Departments/Mayor/PressReleases/Pages/Municipality-of-Anchorage-will-require-registration-for-short-term-rentals.aspx,
  https://www.adn.com/alaska-news/anchorage/2026/05/04/anchorage-vacation-rental-owners-have-until-july-30-to-register-properties-with-the-city/,
  https://www.adn.com/alaska-news/anchorage/2025/12/28/anchorage-will-require-short-term-rental-registration-some-in-girdwood-say-policy-comes-years-too-late/.
- Registrants provide street address, unit type, owner names and local
  contact, seasonal or year-round status, on-site residency, and whether the
  unit was long-term rented in the past year.
- **The registry is not public.** No source mentions publishing it. Anchorage
  has a GIS/parcel viewer and an open data portal
  (https://www.muni.org/Departments/OCPD/GIS2/Pages/default.aspx), but the STR
  registry was not on it as of this research.
- **Enforcement is complaint-driven:** violators get 14 days to comply before
  fines may apply; complaints go to code enforcement (907-343-4141) or ANCWorks.
  About 350 rentals had registered as of May 2026.
- Anchorage has no platform disclosure or booking-verification requirement,
  and no comparable Alaska state law was found.

## Recommendations

With no subpoena power, data-sharing agreement, or disclosure law, in order
of effort:

1. **Request the registry through a public-records request first.** It
   already holds each registrant's street address. Ask the Municipal Clerk or
   OCPD GIS team whether it can be shared or added to the open data portal. A
   list of registered STR numbers alone would answer "is this listing
   registered?" without addresses, by comparison against the numbers scraped
   from listing pages.
2. **If that fails, match parcels within the jitter radius**, as probabilistic
   triage. Buffer each coordinate generously (300–500 m for Girdwood, given
   §5), intersect with parcel polygons from Anchorage GIS
   (https://www.muni.org/Departments/OCPD/GIS2/Pages/default.aspx, or the
   mirror at https://gis.equatorstudios.com/alaska_anchoragemunicipality/), and
   produce a short candidate list per listing. Girdwood's low density keeps
   those lists short.
3. **Check candidates manually against listing photos** (house numbers,
   exteriors, landscape) and street-view or assessor photos. Feasible by hand
   for Girdwood's listing count; automating it as in the Harmari patent is not.
4. **Don't mine host identity from iCal or reviews.** That leak was closed in
   2019, concerned guests, and would raise privacy concerns.
5. **Don't prioritize cross-platform fingerprinting.** It targets cross-listing
   and would require scraping a second platform.
6. **Scrape the municipal STR number from listings.** Now implemented; see
   [`pdp-location-payload.md`](pdp-location-payload.md).

## Sources

- https://insideairbnb.com/data-assumptions/
- https://github.com/insideairbnb (404 — no public org/scraper repo found)
- https://arxiv.org/pdf/2310.15302 (Toward a Critical Toponymy Framework for NER: Airbnb NYC case study)
- https://www.sciencedirect.com/science/article/pii/S0022000014000683 (Gambs, Killijian & del Prado Cortez, "De-anonymization attack on geolocated data," JCSS 2014)
- https://www.tandfonline.com/doi/full/10.1080/17489725.2024.2385312 (HMM-based location-trace de-anonymization)
- https://patents.google.com/patent/US11774260 (Airbnb, Inc., "Dynamic obfuscation of a mapped point of interest," US 11,774,260 B2)
- https://patents.google.com/patent/US12456297 (Avenu STR IP LLC, "System and method for identifying a location of an unlocated short term rental using image recognition," US 12,456,297 B2)
- https://patents.justia.com/patent/11869106 (Airbnb cross-listed property matching patent, US 11,869,106)
- https://www.thedailyupside.com/technology/airbnb-may-sniff-out-crosslisters/
- https://deckard.com/short-term-rental
- https://deckard.com/
- https://govos.com/products/short-term-rental/
- https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/
- https://staystra.com/airbnb-address-disclosure-policy-2026/
- https://www.bnbcalc.com/blog/airbnb-business/how-to-start-airbnb/airbnb-address-disclosure-policy-2026
- https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260SB346 (California SB 346 bill text)
- https://sjud.senate.ca.gov/system/files/2025-05/sb-346-durazo-sjud-analysis.pdf (Senate Judiciary Committee analysis of SB 346)
- https://www.rentresponsibly.org/california-passes-bill-requiring-airbnb-vrbo-to-share-host-data-with-cities/
- https://bbklaw.com/resources/la-010625-new-state-law-helps-cities-get-short-term-rental-information-from-airbnb-vrbo
- https://en.wikipedia.org/wiki/Local_Law_18_of_2022 (NYC STR registration law)
- https://www.avalara.com/mylodgetax/en/blog/2024/10/new-orleans-will-require-short-term-rental-platforms-to-verify-permits.html
- https://www.snw.law/city-council-shifts-enforcement-burden-to-short-term-rental-platforms
- https://www.santamonica.gov/press/2019/03/13/city-of-santa-monica-prevails-against-airbnb-and-homeaway-at-ninth-circuit-in-unanimous-decision
- https://www.hansonbridgett.com/Publications/articles/2019-03-santa-monica-short-term-rental
- https://www.civilbeat.org/2025/05/honolulu-can-fine-airbnb-vrbo-for-illegal-vacation-rentals-it-never-has/
- https://www.civilbeat.org/2025/07/heres-why-honolulu-doesnt-enforce-law-against-short-term-rental-companies/
- https://coloradosun.com/2023/09/05/mountain-town-short-term-rental-crackdown/
- https://github.com/CodeForBc/airbnb-regulation
- https://apify.com/kawsar/airbnb-address-finder (unverified, paywalled listing)
- https://www.uplisting.io/blog/how-the-airbnb-icalendar-ical-changes-will-affect-you-and-how-to-avoid-disruption
- https://www.muni.org/Departments/Mayor/PressReleases/Pages/Municipality-of-Anchorage-will-require-registration-for-short-term-rentals.aspx
- https://www.adn.com/alaska-news/anchorage/2026/05/04/anchorage-vacation-rental-owners-have-until-july-30-to-register-properties-with-the-city/
- https://www.adn.com/alaska-news/anchorage/2025/12/28/anchorage-will-require-short-term-rental-registration-some-in-girdwood-say-policy-comes-years-too-late/
- https://www.muni.org/Departments/OCPD/GIS2/Pages/default.aspx
- https://gis.equatorstudios.com/alaska_anchoragemunicipality/ (third-party mirror of Anchorage parcel GIS, not verified as authoritative)
