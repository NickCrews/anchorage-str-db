# /// script
# requires-python = ">=3.11"
# dependencies = ["marimo", "numpy", "pandas", "matplotlib"]
# ///

import marimo

__generated_with = "0.26.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd

    return mo, np, pd, plt


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # How Airbnb jitters a listing's coordinate

    Airbnb publishes a coordinate for every listing. When the host has not
    chosen to show the exact location, the listing page says
    `isExactLocation: false` and the coordinate is offset ("jittered"). The
    Municipality of Anchorage's STR registry gives a geocoded street address
    for most listings, through the registration id the listing prints. That
    gives a reference point for ~1,400 jittered coordinates, enough to
    recover the jitter's distribution.

    **Result.** Latitude and longitude are offset independently, each by a
    random sign times a distance drawn uniformly between **0.0002° and
    0.0012°**. The offset is in degrees, not meters: at Anchorage's latitude
    (61.2°) it reaches 133 m north–south but only 64 m east–west. Neither axis
    is ever offset by less than 0.0002° (22 m north–south, 11 m east–west).
    The range is the same in dense and sparse parts of the Municipality.

    So the true location lies in a box around the pin, outside a cross
    through the pin, and every point in that region is equally likely.
    Distance from the pin does not rank candidates.

    Data: the published database of 2026-11-16. Each step below runs from the
    three CSVs in `public/`, which you can download at the end of the next
    section. The project's `utils/src/jitter.ts` and the database macro
    `jitter_fits` implement the resulting test.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 1. Data

    `public/` holds three extracts, written by `extract.sql` from the
    published database (`gh release download latest-data --repo
    NickCrews/anchorage-str-db`):

    | File | Rows | What |
    | --- | --- | --- |
    | `listings.csv` | one per active listing | Airbnb's pin (`pin_lat`, `pin_lng`, full precision), `is_exact`, the printed `registration_id` |
    | `registrations.csv` | one per active, geocoded registration | the Muni geocoder's point for the registered address, and `parcels_within_500m` (parcel centroids within 500 m, a density measure) |
    | `flips.csv` | one per distinct (coordinate, flag) | listings that showed both an exact and a jittered coordinate during the scrape history, with the dates each was seen |
    """)
    return


@app.cell
def _(mo, pd):
    _public = mo.notebook_location() / "public"
    listings = pd.read_csv(str(_public / "listings.csv"), dtype={"listing_id": str})
    registrations = pd.read_csv(str(_public / "registrations.csv"))
    flips = pd.read_csv(str(_public / "flips.csv"), dtype={"listing_id": str})
    return flips, listings, registrations


@app.cell
def _(flips, listings, mo, registrations):
    def _download(df, name):
        return mo.download(
            data=df.to_csv(index=False).encode(),
            filename=name,
            mimetype="text/csv",
            label=f"{name} ({len(df):,} rows)",
        )

    mo.hstack(
        [
            _download(listings, "listings.csv"),
            _download(registrations, "registrations.csv"),
            _download(flips, "flips.csv"),
        ],
        justify="start",
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 2. Offsets from registrations

    Join each listing to the registration it prints and take the offset from
    the registration's geocoded point to Airbnb's pin, in degrees and in
    meters (east `dx`, north `dy`). Pairs more than 500 m apart are dropped:
    those are listings printing another rental's id
    ([registration-location-mismatch](../registration-location-mismatch/README.md)),
    and nothing falls between 500 m and 1 km.

    The geocoded point is not the host's pin, so each offset is the jitter
    plus geocoder error. Exact listings measure that error: their offset is
    the error alone.
    """)
    return


@app.cell
def _(listings, np, registrations):
    METERS_PER_DEGREE = 6_371_008.8 * np.pi / 180

    pairs = listings.merge(registrations, on="registration_id")
    pairs["dlat"] = pairs.pin_lat - pairs.geocoded_lat
    pairs["dlng"] = pairs.pin_lng - pairs.geocoded_lng
    pairs["dy"] = pairs.dlat * METERS_PER_DEGREE
    pairs["dx"] = pairs.dlng * METERS_PER_DEGREE * np.cos(np.radians(pairs.geocoded_lat))
    pairs["meters"] = np.hypot(pairs.dx, pairs.dy)
    pairs = pairs[pairs.meters < 500].reset_index(drop=True)
    jittered = pairs[~pairs.is_exact].reset_index(drop=True)
    exact = pairs[pairs.is_exact].reset_index(drop=True)
    return METERS_PER_DEGREE, exact, jittered


@app.cell
def _(exact, jittered, np, pd):
    def _row(name, df):
        q = np.percentile(df.meters, [50, 90, 99])
        return {
            "coordinate": name,
            "listings": len(df),
            "median m": round(q[0]),
            "90th pct m": round(q[1]),
            "99th pct m": round(q[2]),
            "std east m": round(df.dx.std()),
            "std north m": round(df.dy.std()),
        }

    pd.DataFrame([_row("exact", exact), _row("jittered", jittered)])
    return


@app.cell(hide_code=True)
def _(mo, np):
    mo.md(rf"""
    ## 3. The offset is drawn in degrees

    In meters, jittered offsets spread about twice as far north–south as
    east–west. A degree of longitude at 61.2° is cos(61.2°) =
    {np.cos(np.radians(61.2)):.3f} of a degree of latitude, so an offset
    drawn equally in degrees would give a ratio of
    {1 / np.cos(np.radians(61.2)):.2f}. Plotted in degrees, the cloud is
    square.
    """)
    return


@app.cell
def _(jittered, plt):
    _fig, _axes = plt.subplots(1, 2, figsize=(10, 4.6))
    _axes[0].scatter(jittered.dx, jittered.dy, s=3, alpha=0.4)
    _axes[0].set(title="Jittered offsets in meters", xlabel="east (m)", ylabel="north (m)",
                 xlim=(-200, 200), ylim=(-200, 200), aspect="equal")
    _axes[1].scatter(jittered.dlng * 1e4, jittered.dlat * 1e4, s=3, alpha=0.4)
    _axes[1].set(title="Jittered offsets in degrees", xlabel="Δlng (0.0001°)",
                 ylabel="Δlat (0.0001°)", xlim=(-20, 20), ylim=(-20, 20), aspect="equal")
    for _ax in _axes:
        _ax.axhline(0, color="grey", lw=0.5)
        _ax.axvline(0, color="grey", lw=0.5)
    _fig.tight_layout()
    _fig
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 4. Each axis has a minimum offset

    Each axis's histogram is two humps with a dip at zero, and the cloud above
    is emptier along both axes than off them. Some pins do land near an axis,
    but geocoder error accounts for that (§5). A disk or a Gaussian would peak
    at zero.
    """)
    return


@app.cell
def _(exact, jittered, np, plt):
    _bins = np.arange(-20, 20.01, 1)
    _fig, _axes = plt.subplots(1, 2, figsize=(10, 3.4), sharey=True)
    for _ax, _col, _name in [(_axes[0], "dlat", "Δlat"), (_axes[1], "dlng", "Δlng")]:
        _ax.hist(jittered[_col] * 1e4, bins=_bins, alpha=0.7, label="jittered")
        _ax.hist(exact[_col] * 1e4, bins=_bins, alpha=0.5, label="exact (geocoder error)")
        _ax.set(xlabel=f"{_name} (0.0001°)")
    _axes[0].set(ylabel="listings")
    _axes[1].legend()
    _fig.tight_layout()
    _fig
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### Ground truth without the geocoder

    Some listings switched between an exact and a jittered coordinate during
    the scrape history. The exact coordinate is the host's pin, rounded to 4
    decimal places (±0.00005°), so the difference is the jitter itself. A
    host may also have moved the pin when switching, so these pairs are
    evidence, not proof.
    """)
    return


@app.cell
def _(flips, pd):
    _rows = []
    for _id, _g in flips.groupby("listing_id"):
        _exact = _g[_g.is_exact].iloc[-1]
        for _, _j in _g[~_g.is_exact].iterrows():
            _rows.append({
                "listing_id": _id,
                "jittered seen": f"{_j.first_seen} – {_j.last_seen}",
                "Δlat (0.0001°)": round((_j.pin_lat - _exact.pin_lat) * 1e4, 1),
                "Δlng (0.0001°)": round((_j.pin_lng - _exact.pin_lng) * 1e4, 1),
            })
    flip_offsets = pd.DataFrame(_rows)
    flip_offsets["largest |axis|"] = flip_offsets[["Δlat (0.0001°)", "Δlng (0.0001°)"]].abs().max(axis=1)
    flip_offsets["smallest |axis|"] = flip_offsets[["Δlat (0.0001°)", "Δlng (0.0001°)"]].abs().min(axis=1)
    flip_summary = {
        "pairs": len(flip_offsets),
        "max": flip_offsets["largest |axis|"].max(),
        "below 2": int((flip_offsets["smallest |axis|"] < 2).sum()),
    }
    flip_offsets.sort_values("listing_id")
    return (flip_summary,)


@app.cell(hide_code=True)
def _(flip_summary, mo):
    mo.md(rf"""
    Across {flip_summary['pairs']} pairs, no axis is offset by more than
    {flip_summary['max']:.1f} × 0.0001°, and {flip_summary['below 2']} of
    them has an axis under 2 × 0.0001°: listing 1788233769672915596, whose
    first jittered coordinate lasted a single day before a different jittered
    coordinate replaced it, so the host was probably moving the pin.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 5. Fitting a model

    Each observed offset is jitter + geocoder error. Error is drawn
    empirically from exact listings within 150 m of their registration, with
    a random sign on each axis. Each candidate jitter model is simulated with
    that error added, binned on a 2 × 0.0001° grid, and scored by the
    log-likelihood of the observed jittered offsets. Units are 0.0001°.

    | Model | Parameters |
    | --- | --- |
    | per-axis | each axis independently ±U(a, b) |
    | square ring | uniform in the square of half-width b, outside the central square of half-width a |
    | disk (degrees) | uniform in the annulus a ≤ r ≤ b |
    | disk (meters) | uniform in a disk of radius r meters |
    | Gaussian | each axis N(0, σ) |
    """)
    return


@app.cell
def _(exact, jittered, np):
    U = 1e4  # work in units of 0.0001°
    noise = np.c_[exact[exact.meters < 150].dlat * U, exact[exact.meters < 150].dlng * U]
    observed = np.c_[jittered.dlat * U, jittered.dlng * U]
    _cos = np.cos(np.radians(jittered.geocoded_lat.mean()))
    _m_per_unit = 6_371_008.8 * np.pi / 180 / U

    def per_axis(rng, n, a, b):
        return rng.uniform(a, b, (n, 2)) * rng.choice([-1, 1], (n, 2))

    def square_ring(rng, n, a, b):
        x = rng.uniform(-b, b, (n * 3, 2))
        return x[np.abs(x).max(axis=1) >= a][:n]

    def disk_degrees(rng, n, a, b):
        r = np.sqrt(rng.uniform(a**2, b**2, n))
        t = rng.uniform(0, 2 * np.pi, n)
        return np.c_[r * np.sin(t), r * np.cos(t)]

    def disk_meters(rng, n, r_m, _unused):
        r = np.sqrt(rng.uniform(0, 1, n)) * r_m
        t = rng.uniform(0, 2 * np.pi, n)
        return np.c_[r * np.sin(t) / _m_per_unit, r * np.cos(t) / (_m_per_unit * _cos)]

    def gaussian(rng, n, s, _unused):
        return rng.normal(0, s, (n, 2))

    def score(model, a, b, n=100_000, seed=0):
        rng = np.random.default_rng(seed)
        j = model(rng, n, a, b)
        e = noise[rng.integers(0, len(noise), len(j))] * rng.choice([-1, 1], (len(j), 2))
        bins = np.arange(-20, 20.01, 2)
        sim, _, _ = np.histogram2d(*(j + e).T, bins=[bins, bins])
        obs, _, _ = np.histogram2d(*observed.T, bins=[bins, bins])
        p = sim / sim.sum() * 0.999 + 0.001 / sim.size
        return float((obs * np.log(p)).sum())

    return U, disk_degrees, disk_meters, gaussian, noise, per_axis, score, square_ring


@app.cell
def _(disk_degrees, disk_meters, gaussian, pd, per_axis, score, square_ring):
    _grid = (
        [("per-axis", per_axis, a, b) for a in (0, 1, 2, 3) for b in (11, 12, 13)]
        + [("square ring", square_ring, a, b) for a in (0, 2, 3) for b in (11, 12, 13)]
        + [("disk (degrees)", disk_degrees, a, b) for a in (0, 4) for b in (12, 14, 16)]
        + [("disk (meters)", disk_meters, r, None) for r in (120, 140, 160)]
        + [("Gaussian", gaussian, s, None) for s in (6, 7, 8, 9)]
    )
    model_scores = pd.DataFrame(
        [{"model": name, "a / r / σ": a, "b": b, "log-likelihood": round(score(f, a, b), 1)}
         for name, f, a, b in _grid]
    )
    _best = model_scores.loc[model_scores.groupby("model")["log-likelihood"].idxmax()]
    _best = _best.sort_values("log-likelihood", ascending=False).reset_index(drop=True)
    _best["behind best"] = (_best["log-likelihood"].iloc[0] - _best["log-likelihood"]).round(1)
    _best
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    The best of each family is shown. Per-axis beats the square ring, which
    has the same outer box but no minimum on each axis, by about 80
    log-likelihood units, and disks and Gaussians by 200 or more.

    ### The bounds, axis by axis

    For per-axis jitter, each axis can be fit on its own. The density of an
    observed offset is ±U(a, b) convolved with that axis's geocoder error,
    smoothed with a 0.5 × 0.0001° kernel. a and b are found by grid search at
    0.25 × 0.0001° steps.
    """)
    return


@app.cell
def _(noise, np):
    _grid = np.arange(-30, 30.001, 0.1)

    def _error_pdf(e, bandwidth=0.5):
        e = np.r_[e, -e]
        k = np.exp(-0.5 * ((_grid[:, None] - e[None, :]) / bandwidth) ** 2).sum(axis=1)
        return k / (k.sum() * 0.1)

    _error = {"lat": _error_pdf(noise[:, 0]), "lng": _error_pdf(noise[:, 1])}

    def axis_loglik(x, axis, a, b):
        u = ((np.abs(_grid) >= a) & (np.abs(_grid) <= b)).astype(float)
        u /= u.sum() * 0.1
        f = np.maximum(np.convolve(u, _error[axis], "same") * 0.1, 1e-6)
        return float(np.log(np.interp(x, _grid, f)).sum())

    def fit_axis(x, axis):
        return max(
            (axis_loglik(x, axis, a, b), a, b)
            for a in np.arange(0, 5.01, 0.25)
            for b in np.arange(8, 16.01, 0.25)
        )[1:]

    return (fit_axis,)


@app.cell
def _(U, fit_axis, jittered, pd):
    def fit_group(name, g):
        lat = fit_axis(g.dlat.to_numpy() * U, "lat")
        lng = fit_axis(g.dlng.to_numpy() * U, "lng")
        return {"group": name, "listings": len(g),
                "lat a": lat[0], "lat b": lat[1], "lng a": lng[0], "lng b": lng[1]}

    pd.DataFrame([fit_group("all jittered", jittered[jittered.meters < 300])])
    return (fit_group,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    Both axes give a ≈ 2 and b ≈ 12 (latitude 12.25, longitude 11.5; the
    longitude fit is looser because geocoder error in degrees of longitude is
    twice as large). The flip pairs agree. The rounded values, **0.0002° and
    0.0012°**, are the model.

    ## 6. Does the jitter depend on density?

    Airbnb's patent US 11,774,260, "Dynamic obfuscation of a mapped point of
    interest", sizes the obfuscation by population density: "larger visual
    representations of accommodations in less densely populated areas". But
    the patent describes the two circles drawn on the guest-facing map, not
    the coordinate the page and search API return. Szanto and Mehta measured
    those map circles on Wisconsin listings and found their radius
    uncorrelated with the density of the locality.

    To check the coordinate, fit the bounds separately by area (Girdwood, the
    sparsest settled area, is south of 61.05°; Eagle River and Chugiak are
    north of 61.27°) and by quartile of parcels within 500 m of the
    registration.
    """)
    return


@app.cell
def _(fit_group, jittered, np, pd):
    _j = jittered[jittered.meters < 300].copy()
    _j["area"] = np.where(_j.geocoded_lat < 61.05, "Girdwood",
                          np.where(_j.geocoded_lat > 61.27, "Eagle River / Chugiak", "Anchorage bowl"))
    _j["density"] = pd.qcut(_j.parcels_within_500m, 4)
    pd.DataFrame(
        [fit_group(a, g) for a, g in _j.groupby("area")]
        + [fit_group(f"{q} parcels within 500 m", g) for q, g in _j.groupby("density", observed=True)]
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    Every group gives the same bounds within the grid's resolution, and
    Girdwood's are not wider. Within the Municipality, the coordinate's jitter
    does not vary with density. This data cannot rule out a different range in
    places far less dense than Girdwood.

    ## 7. Encoding and stability

    Jittered coordinates come in two encodings: 5 decimal places, or full
    float precision. Exact coordinates are mostly at 4 decimal places
    ([airbnb-pdp-location-payload](../airbnb-pdp-location-payload.md)). Both
    jittered encodings fit the same bounds. A jittered coordinate stays the
    same from one daily scrape to the next and changes only when the listing
    changes, so the offset is stored, not redrawn per request. Listings at the
    same address get different offsets.
    """)
    return


@app.cell
def _(fit_group, jittered, pd):
    def _decimals(x):
        s = repr(float(x))
        return len(s.split(".")[1]) if "." in s else 0

    _j = jittered[jittered.meters < 300].copy()
    _j["encoding"] = [
        "≤ 5 dp" if max(_decimals(a), _decimals(b)) <= 5 else "full precision"
        for a, b in zip(_j.pin_lat, _j.pin_lng)
    ]
    pd.DataFrame([fit_group(e, g) for e, g in _j.groupby("encoding")])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 8. Using the model to find candidates

    For a jittered pin, the true location is a point whose offset from the
    pin is between 0.0002° and 0.0012° on both axes. Comparing with a geocoded
    point needs a tolerance for geocoder error, applied in meters on each
    edge. Below, for every jittered listing whose own registration is within
    500 m, the share whose own registration passes, and how many active
    registrations pass in all, compared with the 150 m and 200 m circles used
    in earlier research.
    """)
    return


@app.cell
def _(METERS_PER_DEGREE, jittered, np, pd, registrations):
    _rlat = registrations.geocoded_lat.to_numpy()
    _rlng = registrations.geocoded_lng.to_numpy()
    _own = registrations.reset_index().set_index("registration_id")["index"]
    _j = jittered[jittered.registration_id.isin(_own.index)]
    _own_idx = _own.loc[_j.registration_id].to_numpy()
    _rows = np.arange(len(_j))

    _dlat = np.abs(_rlat[None, :] - _j.pin_lat.to_numpy()[:, None])
    _dlng = np.abs(_rlng[None, :] - _j.pin_lng.to_numpy()[:, None])
    _cos = np.cos(np.radians(_j.pin_lat.to_numpy()))[:, None]
    _dist = np.hypot(_dlat * METERS_PER_DEGREE, _dlng * METERS_PER_DEGREE * _cos)

    def _summary(name, passes):
        return {"rule": name,
                "own registration passes": f"{passes[_rows, _own_idx].mean():.1%}",
                "candidates (median)": int(np.median(passes.sum(axis=1))),
                "candidates (mean)": round(float(passes.sum(axis=1).mean()), 1)}

    _out = []
    for _tol in (0, 10, 20, 30, 40):
        _tlat = _tol / METERS_PER_DEGREE
        _tlng = _tlat / _cos
        _passes = ((_dlat >= 0.0002 - _tlat) & (_dlat <= 0.0012 + _tlat)
                   & (_dlng >= 0.0002 - _tlng) & (_dlng <= 0.0012 + _tlng))
        _out.append(_summary(f"jitter model, {_tol} m tolerance", _passes))
    for _r in (150, 200):
        _out.append(_summary(f"circle, {_r} m", _dist <= _r))
    pd.DataFrame(_out)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    With a 30 m tolerance the model passes the listing's own registration
    more often than a 150 m circle and admits fewer other registrations. That
    tolerance is `GEOCODE_TOLERANCE_METERS` in `utils/src/jitter.ts`. In
    SQL, against the published database:

    ```sql
    SELECT l.listing_id, r.registration_id
    FROM listings_active l
    JOIN registrations_active r
      ON jitter_fits(l.location_lat, l.location_lng,
                     r.geocoded_lat, r.geocoded_lng, tolerance_m := 30)
    WHERE NOT l.location_is_exact;
    ```

    ## Limits

    - Reference points are geocoded addresses, not the host's pin. The fit
      accounts for geocoder error measured on exact listings, which assumes
      that error is the same for exact and jittered listings.
    - The bounds are fit on a 0.25 × 0.0001° grid. Edges sharper than about
      ±0.25 × 0.0001° (±3 m north–south) cannot be resolved.
    - Whether the offset is derived from the listing id, seeded or random
      is not tested. Only whether it is stable is.
    - One snapshot (listings 2026-11-16), one region. Airbnb could change the
      method or use other bounds elsewhere.

    ## Reproducing

    Download the published database, regenerate the CSVs, and run this
    notebook:

    ```sh
    gh release download latest-data --repo NickCrews/anchorage-str-db -O anchorage_str.duckdb
    duckdb anchorage_str.duckdb -c ".read docs/research/airbnb-jitter/extract.sql"
    uvx marimo edit --sandbox docs/research/airbnb-jitter/notebook.py
    ```

    Simulations use fixed seeds, so the tables reproduce exactly from the same
    CSVs.

    ## Sources

    - Airbnb, US 11,774,260 B2, "Dynamic obfuscation of a mapped point of
      interest": https://patents.google.com/patent/US11774260
    - Szanto and Mehta, "A Host of Troubles: Re-Identifying Airbnb Hosts Using
      Public Data", *Technology Science*, 2018:
      https://techscience.org/a/2018100902/
    - Inside Airbnb, data assumptions: https://insideairbnb.com/data-assumptions/
    """)
    return


if __name__ == "__main__":
    app.run()
