"""Data-quality gate. Mirrors the anchorage-property project's audit: a list
of checks, each error- or warn-severity, that runs after ingest and exits
non-zero on any error so a bad scrape never gets published quietly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

import duckdb
from anchorage_str import config
from anchorage_str.store import PageFetchStats

log = logging.getLogger(__name__)


@dataclass
class CheckResult:
    name: str
    severity: str  # "error" | "warn"
    passed: bool
    detail: str


def run_checks(
    con: duckdb.DuckDBPyConnection,
    scrape_date: date,
    page_stats: PageFetchStats | None = None,
) -> list[CheckResult]:
    """`page_stats` is this run's listing-page pass, when `--pages` ran —
    parse provenance isn't persisted, so its health checks read the run's
    in-memory stats rather than the database."""
    results: list[CheckResult] = []

    def check(name, severity, passed, detail):
        results.append(CheckResult(name, severity, passed, detail))

    current_count = con.execute("SELECT count(*) FROM listings WHERE is_current").fetchone()[0]
    lo, hi = config.PLAUSIBLE_LISTING_COUNT
    check(
        "listing_count_plausible",
        "error",
        lo <= current_count <= hi,
        f"{current_count} current listings, expected [{lo}, {hi}]",
    )

    dupes = con.execute(
        "SELECT count(*) FROM (SELECT listing_id FROM listings WHERE is_current "
        "GROUP BY listing_id HAVING count(*) > 1)"
    ).fetchone()[0]
    check(
        "no_duplicate_current_listings",
        "error",
        dupes == 0,
        f"{dupes} listing_ids with >1 current row",
    )

    overlap = con.execute(
        """
        SELECT count(*) FROM listings a JOIN listings b
          ON a.listing_id = b.listing_id AND a.valid_from < b.valid_from
        WHERE a.valid_to IS NULL OR a.valid_to > b.valid_from
        """
    ).fetchone()[0]
    check(
        "no_overlapping_listing_versions",
        "error",
        overlap == 0,
        f"{overlap} overlapping SCD2 intervals",
    )

    bbox = config.BBOX
    out_of_bbox = con.execute(
        "SELECT count(*) FROM listings WHERE is_current AND "
        "(location_lat IS NULL OR location_lng IS NULL OR location_lat < ? "
        "OR location_lat > ? OR location_lng < ? OR location_lng > ?)",
        [
            bbox["sw_lat"] - 0.05,
            bbox["ne_lat"] + 0.05,
            bbox["sw_long"] - 0.05,
            bbox["ne_long"] + 0.05,
        ],
    ).fetchone()[0]
    check(
        "coords_within_bbox",
        "warn",
        out_of_bbox == 0,
        f"{out_of_bbox} current listings outside the Anchorage bbox (+buffer)",
    )

    run = con.execute(
        "SELECT calendar_fetch_attempted, calendar_fetch_failed FROM scrape_runs "
        "WHERE scrape_date = ? ORDER BY run_started_at DESC LIMIT 1",
        [scrape_date],
    ).fetchone()
    if run:
        attempted, failed = run
        rate = (failed / attempted) if attempted else 0
        check(
            "calendar_failure_rate",
            "error",
            rate <= config.MAX_CALENDAR_FAILURE_RATE,
            f"{failed}/{attempted} calendar fetches failed ({rate:.0%})",
        )
    else:
        check(
            "calendar_failure_rate", "error", False, "no scrape_runs row found for this scrape_date"
        )

    freshness = con.execute(
        "SELECT count(*) FROM listing_observations WHERE scrape_date = ?", [scrape_date]
    ).fetchone()[0]
    check(
        "observations_written_today",
        "error",
        freshness > 0,
        f"{freshness} listing_observations rows for {scrape_date}",
    )

    # The listing-page pass is opt-in (`daily --pages`), so only gate on it
    # when this run actually attempted it.
    if page_stats and page_stats.attempted:
        rate = page_stats.failed / page_stats.attempted
        check(
            "listing_page_failure_rate",
            "error",
            rate <= config.MAX_PAGE_FAILURE_RATE,
            f"{page_stats.failed}/{page_stats.attempted} listing-page fetches failed ({rate:.0%})",
        )

    fetched = page_stats.attempted - page_stats.failed if page_stats else 0
    if page_stats and fetched:
        # `isExactLocation` is the whole point of the listing-page pass, and
        # it comes from the one layer that reads Airbnb's private JSON. If a
        # run reads pages but none of them yield the flag, that layer has
        # broken and the parse is degrading silently to the coordinate-only
        # fallback.
        check(
            "exact_location_flag_present",
            "error",
            page_stats.with_exact_flag > 0,
            f"{page_stats.with_exact_flag}/{fetched} pages read this run carried isExactLocation",
        )

        # Which extraction layers are still working. `state` is the only
        # one that can produce the flag, so losing it is the failure above;
        # losing `json-ld` is a quieter warning that the standards-based
        # cross-check on the coordinate is gone. See listing_page.py.
        for layer in ("json-ld", "state"):
            live = page_stats.layer_used.get(layer, 0)
            check(
                f"extraction_layer_{layer.replace('-', '_')}_alive",
                "warn",
                live > 0,
                f"{live}/{fetched} pages read this run used the {layer} layer",
            )

    # Cross-check the flag against an independent signal: Airbnb emits an
    # exact coordinate rounded to 4 decimal places and a jittered one at 5+
    # (41/41 when measured — see docs/research/airbnb-pdp-location-payload.md).
    # That's an undocumented artifact, so a mismatch doesn't mean the flag
    # is wrong — it means one of the two stopped meaning what it did, which
    # is worth a look either way.
    mismatched = con.execute(
        """
        SELECT count(*) FROM listings
        WHERE is_current AND location_is_exact IS NOT NULL AND location_lat IS NOT NULL
          AND location_is_exact != (
              length(split_part(abs(location_lat)::VARCHAR, '.', 2)) <= 4
              AND length(split_part(abs(location_lng)::VARCHAR, '.', 2)) <= 4
          )
        """
    ).fetchone()[0]
    located = con.execute(
        "SELECT count(*) FROM listings WHERE is_current AND location_is_exact IS NOT NULL"
    ).fetchone()[0]
    if located:
        check(
            "exact_flag_matches_coordinate_precision",
            "warn",
            mismatched / located <= 0.05,
            f"{mismatched}/{located} listings where isExactLocation disagrees with "
            "the 4-vs-5-decimal-place signal",
        )

    # A row's night_date should never be earlier than the scrape_date
    # (valid_from) that first observed it — if it is, that's the
    # elapsed-current-month artifact described in airbnb_client.py, not a
    # real calendar entry. Catches a regression of that fix, or any other
    # bug producing backdated rows.
    backdated = con.execute(
        "SELECT count(*) FROM calendar_status WHERE night_date < valid_from"
    ).fetchone()[0]
    check(
        "no_backdated_calendar_rows",
        "error",
        backdated == 0,
        f"{backdated} calendar_status rows with night_date before their own valid_from",
    )

    return results


def report(results: list[CheckResult]) -> bool:
    """Log every check; return True iff no error-severity check failed."""
    ok = True
    for r in results:
        status = "PASS" if r.passed else f"FAIL ({r.severity})"
        log.log(
            logging.INFO if r.passed else logging.WARNING, "[%s] %s: %s", status, r.name, r.detail
        )
        if not r.passed and r.severity == "error":
            ok = False
    return ok
