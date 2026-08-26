# Prior art: matching fuzzed Airbnb listings to real addresses

Research date: 2026-08-18. Scope: how others (researchers, cities, and
compliance vendors) go from a public Airbnb listing — with its
deliberately fuzzed map pin — to a real street address or parcel, in
order to inform `girdwood-str-lake`'s eventual goal of cross-referencing
scraped listings against Girdwood's municipal STR permit registry.

Bottom line up front: the dominant real-world method is **not** technical
de-anonymization at all. It's legal compulsion — ordinances that force
Airbnb/Vrbo to hand cities the address or parcel number directly, or to
refuse bookings on unregistered listings. Technical de-anonymization
(image matching, geocoding, parcel triangulation) is a real, patented,
commercially-sold capability, but it is used by compliance vendors as a
*prerequisite to getting an enforceable ordinance passed* or as a
*fallback where no data-sharing law exists yet* — not as the industry's
first choice once legal leverage is available. Girdwood/Anchorage, as of
this research, has chosen a third path: a free self-registration portal,
not yet paired with either platform data-sharing law or a public open-data
registry.

---

## 1. Inside Airbnb

Inside Airbnb (insideairbnb.com) explicitly documents the jitter Airbnb
applies to listing coordinates and does **not** attempt to reverse it.

From their own "Data Assumptions" page:

> "Location information for listings are anonymized by Airbnb ... In
> practice, this means the location for a listing on the map, or in the
> data will be from 0-450 feet (150 metres) of the actual address."
>
> "Listings in the same building are anonymized by Airbnb individually,
> and therefore may appear 'scattered' in the area surrounding the actual
> address."

Source: https://insideairbnb.com/data-assumptions/ (fetched directly,
2026-08-18)

Separately, multiple secondary academic sources describing Inside
Airbnb-style datasets characterize the underlying jitter as **drawn from
a skewed (right-skewed) distribution with a mean displacement on the
order of 150–200 m**, rather than a uniform circle — i.e., most points
land closer to the true location than the 150 m (or reported 200 m)
headline figure suggests, with a long tail further out. I could not find
a single canonical primary-source paper pinning down the exact
distribution parameters Airbnb uses internally; different studies quote
100–200 m as the practical displacement scale. Treat "150–200 m,
right-skewed" as the working estimate, not a verified constant.

**No public Inside Airbnb scraper repo.** I could not find a
`github.com/insideairbnb` organization or public scraper codebase — their
scraping/compilation pipeline is not open-sourced; the org page 404s.
Inside Airbnb publishes only the resulting jittered datasets, along with
the methodology text above. This is consistent with their stated
position: they treat the jitter as a hard constraint from their data
source (Airbnb) and a deliberate privacy protection, not something they
work around.

## 2. Academic research on Airbnb coordinate obfuscation and de-anonymization

- **General location-data de-anonymization literature** (Gambs, Killijian
  & del Prado Cortez, "De-anonymization attack on geolocated data,"
  *Journal of Computer and System Sciences*, 2014,
  https://www.sciencedirect.com/science/article/pii/S0022000014000683)
  and related hidden-Markov-model location-trace attacks
  (https://www.tandfonline.com/doi/full/10.1080/17489725.2024.2385312)
  are about re-identifying *people* from *mobility trajectories* (e.g.
  repeated GPS traces). They are not about Airbnb and don't transfer
  directly to a single static fuzzed point — I include them only because
  the prompt asked for the general de-anonymization literature; they are
  not evidence of an Airbnb-specific attack.

- **Airbnb-specific obfuscation-radius studies.** Multiple urban-studies
  papers analyzing Airbnb spatial data (e.g. work on Airbnb price/revenue
  hedonic models, and toponymy/NER studies of Airbnb NYC data,
  https://arxiv.org/pdf/2310.15302) note the jitter as a *limitation*
  that forces aggregation to census-tract or neighborhood level for valid
  point-level inference, rather than proposing a correction/de-jitter
  method. One relevant methodological note, from research on Airbnb
  spatial analysis: "for the purposes of point-level analysis the
  lowest-error option is to use the reported coordinates without
  modification" — i.e., published academic practice is to accept the
  fuzz, not try to invert it.

- **I did not find a peer-reviewed paper that successfully "de-jitters"
  individual Airbnb coordinates back to a real address.** Academic
  literature treats the obfuscation as a privacy-preserving constraint to
  work around statistically (aggregate to larger areas), not as an
  attack surface to defeat point-by-point. Be skeptical of any claim to
  the contrary that isn't backed by a citable paper — I looked and didn't
  find one.

- **Airbnb's own obfuscation mechanism is patented**, which is a useful
  primary source for how the fuzz is actually generated (see §5).

## 3. Municipal/regulatory STR compliance — what cities and their vendors actually do

### 3a. The legal-compulsion model (the real answer for most serious enforcement)

This is the dominant, well-documented pattern: cities pass ordinances
that either (i) require platforms to disclose the address/parcel/host
identity of every listing directly, or (ii) require platforms to refuse
to process a booking for any listing lacking a valid city-issued
registration number — pushing the burden of address-matching onto the
platform itself rather than the city.

- **California SB 346** (effective Jan 1, 2026): gives California cities
  the authority to compel "short-term rental facilitators" (Airbnb, Vrbo,
  etc.) to disclose, per listing: the Assessor's Parcel Number (APN),
  the property address, the listing URL, and ZIP code, on a recurring
  (quarterly or, if TOT is remitted monthly, monthly) basis. It is not
  self-executing — a city must adopt its own ordinance invoking it.
  Sources: bill text
  https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260SB346
  and analysis
  https://sjud.senate.ca.gov/system/files/2025-05/sb-346-durazo-sjud-analysis.pdf,
  summarized at
  https://www.rentresponsibly.org/california-passes-bill-requiring-airbnb-vrbo-to-share-host-data-with-cities/
  and https://bbklaw.com/resources/la-010625-new-state-law-helps-cities-get-short-term-rental-information-from-airbnb-vrbo.
  A secondary summary (https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/)
  frames this as a deliberate shift: "Before SB 346, compliance software
  vendors did the detective work of matching listings to properties
  because platforms would not share that data voluntarily" — i.e., legal
  disclosure is explicitly understood in the industry as displacing the
  technical-matching approach where it's available.

- **New York City, Local Law 18 of 2022**: hosts must register with the
  Mayor's Office of Special Enforcement (OSE) before listing; **platforms
  must verify a valid registration number before processing any
  booking**, on pain of fines. This is enforced as a platform-side gate,
  not city-side detective work. Effect was dramatic: Airbnb active NYC
  listings reportedly fell from ~22,000 to ~2,300 within about a year of
  enforcement. Source: https://en.wikipedia.org/wiki/Local_Law_18_of_2022
  (Wikipedia is secondary; I did not independently verify against NYC.gov
  primary text in this pass — flagged as lower-confidence on the exact
  numbers, but the registration-before-booking mechanism is corroborated
  by multiple sources).

- **New Orleans, Ordinance 34,806** (effective March 2025): requires
  platforms to verify listings against a city-issued permit database
  before allowing bookings, re-verify regularly, and file monthly
  compliance reports. Result: over 1,000 unlicensed listings removed in
  August 2025 out of roughly 7,000 active listings against ~1,350 legally
  permitted units. Source:
  https://www.avalara.com/mylodgetax/en/blog/2024/10/new-orleans-will-require-short-term-rental-platforms-to-verify-permits.html
  and https://www.snw.law/city-council-shifts-enforcement-burden-to-short-term-rental-platforms.

- **Santa Monica, CA** — the foundational legal precedent enabling this
  whole model. In *HomeAway.com, Inc.; Airbnb, Inc. v. City of Santa
  Monica* (9th Cir. 2019), the Ninth Circuit unanimously upheld Santa
  Monica's home-sharing ordinance, which requires platforms to (1)
  collect/remit transient occupancy tax, (2) regularly disclose listing
  and booking information to the city, (3) refuse to process bookings for
  properties not on the city's registry, and (4) refuse fees for
  unregistered listings — and held this does not violate Section 230 or
  the First/Fourth Amendments because it regulates *booking transactions*,
  not listing *content*. This ruling is the legal backbone that later
  ordinances (NYC, New Orleans, SB 346) build on. Sources:
  https://www.santamonica.gov/press/2019/03/13/city-of-santa-monica-prevails-against-airbnb-and-homeaway-at-ninth-circuit-in-unanimous-decision
  and analysis at
  https://www.hansonbridgett.com/Publications/articles/2019-03-santa-monica-short-term-rental.

- **Honolulu, HI** — cautionary counter-example. Honolulu passed one of
  the toughest platform-fine laws in the country in 2019 (up to
  $10,000/day per illegal listing) but **has essentially never enforced
  the platform-reporting provision**, after settling a lawsuit from
  vacation-rental owners by agreeing not to require Airbnb/Vrbo's monthly
  booking reports. As of 2025 the city was still enforcing case-by-case
  against individual owners rather than via platform data. This shows
  that having the legal authority is necessary but not sufficient — it
  can be litigated into non-enforcement. Source:
  https://www.civilbeat.org/2025/05/honolulu-can-fine-airbnb-vrbo-for-illegal-vacation-rentals-it-never-has/
  and https://www.civilbeat.org/2025/07/heres-why-honolulu-doesnt-enforce-law-against-short-term-rental-companies/.

- **Colorado mountain towns** (Breckenridge, Vail, Steamboat Springs,
  Summit County) all run license/registration regimes with per-listing
  license numbers, occupancy/zoning limits, and lodging-tax collection,
  but I could not find primary-source documentation of a specific
  technical address-matching pipeline in these towns — coverage found
  describes licensing/tax policy, not enforcement mechanics. This is a
  gap in what's publicly documented, not evidence they don't do
  technical matching. Source (general, not primary):
  https://coloradosun.com/2023/09/05/mountain-town-short-term-rental-crackdown/.

### 3b. Named commercial vendors and their documented technical methods

- **Deckard Technologies (product: Rentalscape STR)**. Marketing claims
  "scans over 15 million listings across 10,000+ rental websites daily,
  tying each listing to a specific parcel number and property address,"
  using "patented data-mining technology," AI, NLP, and image analysis,
  backstopped by "over 50 in-house data analysts" who validate AI
  findings. **The public-facing pages do not disclose the actual
  technical method** (no description of geocoding logic, image-matching
  algorithm, etc.) — this is marketing copy, not a methodology paper.
  Source: https://deckard.com/short-term-rental (fetched directly,
  2026-08-18).

- **GovOS** (successor product line covering the former Host Compliance /
  Granicus STR product). Claims "98% of all STRs" identified via a
  process that includes "human-eye verification" layered on automated
  detection — i.e., explicitly a human-in-the-loop review step, not pure
  algorithmic address resolution. Source:
  https://govos.com/products/short-term-rental/.

- **Granicus (formerly Host Compliance)**: per secondary reporting,
  "automates the capture of listings from over 70 STR websites,
  cross-references active bookings with permit databases, and generates
  violation notices with court-defensible screenshots." Served ~300
  jurisdictions at acquisition, reportedly 500+ by 2024. I did not find a
  primary Granicus technical-methodology document describing exactly how
  the listing-to-parcel match is computed (their marketing pages, not
  independently re-verified in this pass beyond the summary source
  https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/).

- **Harmari (an Avenu Insights & Analytics company)** — the one vendor
  where I found an actual **primary-source patent** describing the
  technical method in real detail:

  **US Patent 12,456,297 B2**, "System and method for identifying a
  location of an unlocated short term rental using image recognition,"
  assignee **Avenu STR IP LLC**, filed June 14, 2022 (priority June 14,
  2021), published Oct 28, 2025. Fetched via
  https://patents.google.com/patent/US12456297 (2026-08-18). Its
  described method:
  1. Classify each listing photo into one of seven "archetypes":
     Exterior House Front, Exterior House Rear, Exterior View Building,
     Common Elements, Interior View, View From Unit, View From Balcony.
  2. Run object detection on the photos to find features like doors,
     windows, **house numbers**, driveways, and furniture, feeding the
     archetype classification.
  3. Pull candidate comparison images from property databases, real
     estate listing sites, and map/street-view services for locations
     near the fuzzed pin.
  4. Compare the unlocated listing's images against same-archetype
     candidate images and compute a matching score; above a threshold,
     the candidate location is accepted as the real one.
  5. For multi-unit buildings, additional techniques are claimed:
     floor-counting via Fourier-transform analysis of window patterns
     and landmark triangulation, to identify a specific unit rather than
     just a building.

  This is the clearest, most concrete, citable technical description of
  "photo-vs-street-view/parcel-photo matching" I found anywhere in this
  research — it validates that approach (c)/(a) hybrid from the task
  brief as a real, patented, currently-commercialized technique, not
  merely folklore. Corroborating secondary summary:
  https://staystra.com/str-enforcement-technology-2026-ai-tools-cities/
  ("Harmari's patent-pending system classifies images by scene type, then
  matches them across platforms to link multiple listings to the same
  property... crawls more than 80 STR listing websites").

### 3c. Techniques named in the task brief — what I could and couldn't substantiate

- **(a) Reverse-geocode + manual photo/street-view verification**: well
  substantiated as the human-in-the-loop layer GovOS explicitly claims
  ("human-eye verification"), and as the automated version of the same
  idea in the Harmari patent above.
- **(b) Host name/phone number leaked via reviews or iCal, cross-referenced
  against parcel/tax owner records**: I found evidence the *iCal leak
  channel specifically has been closed*. Airbnb changed its iCal export
  in December 2019 to strip guest names and full phone numbers, leaving
  only blocked-date ranges and last-4-digits of a guest's phone — and
  that leak was about *guest* PII, not host address, in the first place.
  Source: https://www.uplisting.io/blog/how-the-airbnb-icalendar-ical-changes-will-affect-you-and-how-to-avoid-disruption.
  I found no primary source substantiating host-identity leakage via
  reviews/iCal as an active, currently-used compliance technique — treat
  this as unsubstantiated/likely defunct.
- **(c) Matching house numbers/architectural features in photos**: directly
  substantiated by the Harmari/Avenu patent (object detection explicitly
  targets "house numbers"); also informally corroborated by consumer-side
  writeups describing manual photo + Google Street View matching as
  quick and effective for a motivated individual (secondary source,
  Kingston News, not independently re-fetched successfully — 403'd on
  refetch, cited only as background color, low confidence).
- **(d) Cross-platform (Airbnb+VRBO) calendar/pricing fingerprinting**:
  substantiated at the commercial level — AirDNA is reported to "identify
  every Airbnb and VRBO property within 600 meters of each other using
  latitude and longitude" to merge cross-listed properties (secondary
  source, not an AirDNA primary methodology page I could independently
  verify in this pass). Separately, **Airbnb itself has patented
  cross-listing detection** — a system that compares a host's photos
  against other vacation-rental sites' listings via an ML model that
  categorizes rooms (kitchen, bedroom, pool, etc.) to catch hosts
  cross-listing the same property — described in coverage of patent
  US 11,869,106, "Cross-listed property matching using image descriptor
  features" (https://patents.justia.com/patent/11869106), reported on at
  https://www.thedailyupside.com/technology/airbnb-may-sniff-out-crosslisters/.
  This is Airbnb defending against hosts gaming multiple platforms, not a
  city compliance tool, but the underlying technique (cross-platform
  image matching) is the same idea applied by (d).
- **(e) Subpoena/legal data-sharing agreements**: this is the
  best-substantiated and most consequential mechanism found in this
  research — see §3a. It is very likely the *real* answer for how most
  serious, well-resourced STR enforcement programs actually work at
  scale, with technical matching (Harmari-style) serving as (i) leverage
  to identify violators in jurisdictions that don't yet have a
  disclosure law, and (ii) an audit/cross-check even where disclosure
  laws exist.

## 4. Open-source tools/datasets

- **`CodeForBc/airbnb-regulation`** (GitHub, MIT license) — a Code for BC
  civic-tech project explicitly aimed at flagging Airbnb listings that
  violate BC's short-term rental policy. Architecture: a data-ingestion
  module (scrapes Airbnb) and a listing-processing module (validates
  against BC's business registry and applies policy rules), with results
  in a Grafana dashboard. 269 commits, 13 open issues at time of
  fetching. It does **not** appear to attempt photo/address de-jittering
  — its compliance check is cross-referencing scraped listings against
  BC's *business registry* (i.e., checking whether a host has a required
  business license number), which is closer to Girdwood's own "does the
  listing show a registration number" question than to geolocation
  attack. This is the closest civic-tech analog to
  `girdwood-str-lake`'s stated goal that I found. Source:
  https://github.com/CodeForBc/airbnb-regulation.
- **Apify "Airbnb Address Finder"** — a commercial Apify actor claiming to
  resolve Airbnb listing addresses; I did not fetch/verify its internals
  (paywalled Apify Store listing) — flagged as unverified,
  https://apify.com/kawsar/airbnb-address-finder.
- I did **not** find a maintained, general-purpose open-source library
  that does Airbnb-listing-to-parcel matching as its core function. The
  closest things are (i) generic Airbnb scrapers (many, e.g.
  `digital-engineering/airbnb-scraper`, unrelated to this project's own
  `pyairbnb`-based approach) and (ii) the BC project above, which solves
  a narrower "registration number present?" problem, not a geolocation
  problem.

## 5. Airbnb's own stated/patented obfuscation mechanism

- **US Patent 11,774,260 B2**, "Dynamic obfuscation of a mapped point of
  interest," assignee **Airbnb, Inc.** Fetched via
  https://patents.google.com/patent/US11774260 (2026-08-18). Describes a
  **two-concentric-circle** obfuscation scheme: an inner circle hides the
  exact point, an outer circle bounds the general vicinity a guest can
  infer. Circle sizes are set **based on population density around the
  listing** — smaller circles (less area hidden) in dense urban areas,
  larger circles in rural areas, to keep the *number of plausible
  candidate properties* roughly constant regardless of density. The
  system preserves obfuscation across zoom levels (the inner circle's
  screen-radius is held constant on zoom-in, so zooming doesn't reveal
  more precision). Hosts can also manually override circle radii. This
  is directly relevant to Girdwood: **because Girdwood is low-density
  and rural, this patent implies Airbnb likely uses a *larger* real-world
  obfuscation radius there than in a dense city**, meaning the
  commonly-quoted ~150m (Inside Airbnb) or ~0.7-mile (secondary,
  pre-2026-booking-policy-change reporting) figures for urban contexts
  may understate the true jitter radius for Girdwood-area listings. I
  could not find a primary source giving Airbnb's exact rural-vs-urban
  radius numbers — this is inference from the patent's stated design
  principle, not a confirmed number.
- **Pre-booking map behavior** (secondary sourcing, not independently
  re-verified against a live Airbnb help page — the official
  `airbnb.com/resources/...` pages 403'd on fetch in this session):
  reporting describes the general-location map as showing "the area
  around a listing within about a half-mile ... radius," with a
  "specific location" pin variant snapped to the nearest cross-street
  rather than the true address; other reporting says pre-2026 the
  visible obfuscation circle was "about 0.7 miles regardless of
  location." These are inconsistent with each other and with the
  150–200m figures Inside Airbnb and academic sources use for the raw
  *data* coordinates — my read is that the **map pin's visual fuzz
  circle shown to browsing guests is deliberately larger/coarser** than
  the **raw jittered coordinate Airbnb returns in its API/search
  responses** (which is what `pyairbnb` and this project actually
  capture). This distinction matters for `girdwood-str-lake`: the
  lat/lng this scraper stores comes from the API response object, not
  a rendered map pin, so the applicable jitter bound is closer to the
  150–200m (or larger, rural) figure than to the 0.5–0.7 mile visual
  circle.
- **2026 policy change**: multiple sources (StaySTRA, BNBCalc — both
  secondary, STR-industry blogs, not Airbnb primary text) report that as
  of March 9, 2026 Airbnb began showing guests the **exact address
  immediately upon booking confirmation**, even during a free-cancellation
  window, versus the older behavior of withholding it until the
  cancellation window closed for Firm/Strict-policy listings. This is a
  change to *guest-facing post-booking* disclosure, not to the
  fuzzed public search-result coordinates this project scrapes — I found
  no indication it affects the pre-booking jitter behavior relevant to
  this project. Sources: https://staystra.com/airbnb-address-disclosure-policy-2026/,
  https://www.bnbcalc.com/blog/airbnb-business/how-to-start-airbnb/airbnb-address-disclosure-policy-2026.
  Flagged low-confidence pending an Airbnb primary source (help center
  pages returned 403 to WebFetch in this session).

## 6. Girdwood/Anchorage's own STR registration program (directly relevant context)

Found while researching §3, and important enough to call out separately
since it changes what "cross-referencing against the permit registry"
will actually mean in practice:

- The Municipality of Anchorage passed **AO 2025-115(S-2)**, approved
  10-2, creating a free, online short-term rental **registration**
  requirement (not a licensing/permit-cap regime). The Municipal Clerk
  opened the registration portal (via the existing CityView portal) on
  **May 1, 2026**; existing operators must register by **July 30, 2026**;
  listings/ads must display a municipal STR number by **July 31, 2026**.
  Sources:
  https://www.muni.org/Departments/Mayor/PressReleases/Pages/Municipality-of-Anchorage-will-require-registration-for-short-term-rentals.aspx,
  https://www.adn.com/alaska-news/anchorage/2026/05/04/anchorage-vacation-rental-owners-have-until-july-30-to-register-properties-with-the-city/,
  https://www.adn.com/alaska-news/anchorage/2025/12/28/anchorage-will-require-short-term-rental-registration-some-in-girdwood-say-policy-comes-years-too-late/.
- Registrants must supply: **street address**, unit type, owner name(s)
  and local contact, seasonal-vs-year-round status, on-site residency,
  and whether it was long-term-rented in the past year.
  Source: same ADN/muni.org pages above.
- **No confirmed public/open-data registry.** Neither the muni.org press
  release nor the ADN coverage mentions the resulting dataset being
  published as open data, queryable, or otherwise publicly accessible —
  it's described purely as an internal registration system. Anchorage
  does run a general GIS/parcel viewer and an "MOA Open Data Portal" for
  other datasets (appraisal, restaurant inspections, etc.,
  https://www.muni.org/Departments/OCPD/GIS2/Pages/default.aspx), but I
  found no evidence the STR registry has been added to it as of this
  research date.
- **Enforcement is complaint-driven**, not platform-verification-based:
  violators get a notice-of-violation with 14 days to comply before fines
  "may be imposed"; complaints go through a code-enforcement hotline
  (907-343-4141) or the ANCWorks portal. As of the May 2026 ADN article,
  roughly 350 rentals had registered.
- There is **no evidence Anchorage has adopted anything like California's
  SB 346 model** (compelling Airbnb/Vrbo to disclose addresses/APNs
  directly) or an NYC/New-Orleans-style platform-verification-before-booking
  requirement. Alaska has no comparable state law found in this research.

## Recommendation for girdwood-str-lake

Given the realistic constraints — a hobby/civic-tech project with no
subpoena power, no data-sharing agreement with Airbnb, and (per §6) no
current legal hook forcing Airbnb to disclose addresses to Anchorage —
the tractable next steps, roughly in order of effort and defensibility:

1. **Ask for the registry directly, as a public-records request, before
   building anything technical.** Anchorage/Girdwood's new registration
   system (AO 2025-115(S-2)) already collects the one field this project
   actually needs — the registrant's **street address** — for every
   compliant listing. A municipal public-records request (Alaska's public
   records act, or simply asking the Municipal Clerk / OCPD GIS team
   whether the STR registry dataset can be shared or added to the MOA
   Open Data Portal) is far more reliable, far less effort, and far less
   ethically fraught than any address-inference pipeline. This also
   directly answers the actual compliance question the project cares
   about — "is this scraped listing registered?" — without ever needing
   to resolve an address at all, if the request instead returns a list of
   registered STR numbers that scraped listing pages could be checked
   against (once Airbnb starts requiring hosts to display the municipal
   STR number in listings, per the July 31, 2026 requirement — worth
   scraping that field directly going forward, if it flows through
   `pyairbnb`'s search response, rather than solving geolocation at all).
2. **If a records request stalls or the registry can't be shared,
   parcel-matching within the known jitter radius is the next most
   tractable technical step** — but treat it as probabilistic
   triage, not ground truth. Concretely: buffer each scraped
   `(lat, lng)` by a generous radius (given §5's inference that rural
   areas likely get a larger real-world jitter than the ~150–200 m urban
   figure — 300–500 m might be a safer working assumption for Girdwood
   pending better data), intersect against Girdwood parcel polygons from
   Anchorage's public GIS/parcel data
   (https://www.muni.org/Departments/OCPD/GIS2/Pages/default.aspx or a
   third-party mirror like https://gis.equatorstudios.com/alaska_anchoragemunicipality/),
   and produce a short candidate-parcel list per listing rather than a
   single answer. Girdwood's low building density (a few thousand
   parcels, not a dense city block) makes this far more tractable than
   the same technique would be downtown — a several-hundred-meter buffer
   in Girdwood likely catches only a handful of candidate parcels, versus
   dozens in a city core.
3. **Manual spot-check the candidate list using listing photos**, the
   same core idea as the Harmari/Avenu patent (house numbers, exterior
   angles, distinctive architectural/landscape features) cross-referenced
   against the handful of candidate parcels' street-view or assessor
   photos — but doing this by hand for a double-digit or low-hundreds
   count of Girdwood listings is realistic for a hobby project in a way
   that building automated image-archetype classification (their patented
   pipeline) is not. This should be treated as a manual verification aid
   for a short candidate list from step 2, not a bulk automated matcher.
4. **Do not build (b)-style techniques** (mining host PII from iCal/reviews)
   — the evidence found in this research (§3c) is that Airbnb closed that
   leak in 2019, it targeted guest PII rather than host address in the
   first place, and pursuing it would be a privacy/ethics red flag for a
   civic-transparency project without much technical payoff.
5. **Skip cross-platform (Airbnb+VRBO) fingerprinting** (technique d) as a
   *primary* strategy — it's designed to catch cross-listers, and requires
   scraping and maintaining a second platform's data, disproportionate
   effort for what it would add over steps 1–3 in a market as small as
   Girdwood.
6. **Watch for the municipal STR-number-in-listing requirement to
   actually take effect (July 31, 2026)** and prioritize scraping/parsing
   that field over any geolocation approach — if Airbnb hosts comply,
   this turns the whole problem from "find the address" into "read a
   number off the page," which is both easier and exactly what the
   ordinance intends. Confirming whether pyairbnb's search-result payload
   surfaces that field (likely inside listing title/description text
   rather than structured metadata, based on how other cities' STR
   numbers show up in Airbnb listings) is a concrete, low-risk next
   engineering task independent of any de-anonymization work.

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
