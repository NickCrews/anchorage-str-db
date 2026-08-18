"""Data-quality gate. Mirrors the anchorage-property project's audit: a list
of checks, each error- or warn-severity, that runs after ingest and exits
non-zero on any error so a bad scrape never gets published quietly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

import duckdb

from girdwood_str import config

log = logging.getLogger(__name__)


@dataclass
class CheckResult:
    name: str
    severity: str  # "error" | "warn"
    passed: bool
    detail: str


def run_checks(con: duckdb.DuckDBPyConnection, scrape_date: date) -> list[CheckResult]:
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
        "(lat IS NULL OR lng IS NULL OR lat < ? OR lat > ? OR lng < ? OR lng > ?)",
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
        f"{out_of_bbox} current listings outside the Girdwood bbox (+buffer)",
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
