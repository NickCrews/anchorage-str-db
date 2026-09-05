from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

from anchorage_str_db import config
from anchorage_str_db.pipeline import run_daily


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="anchorage-str-db")
    parser.add_argument(
        "--db",
        type=Path,
        default=config.DEFAULT_DB_PATH,
        help=f"path to the DuckDB file (default: {config.DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--date",
        type=date.fromisoformat,
        default=None,
        help="scrape_date to record this run under (default: today, UTC)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    daily = sub.add_parser(
        "daily", help="search Anchorage, fetch calendars, merge, run quality checks"
    )
    daily.add_argument(
        "--pages",
        action="store_true",
        help=(
            "also fetch each listing's own page for its location payload "
            "(Airbnb's isExactLocation flag) and municipal STR registration "
            "number; roughly doubles the run's request count"
        ),
    )

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    args.db.parent.mkdir(parents=True, exist_ok=True)

    if args.command == "daily":
        ok = run_daily(args.db, scrape_date=args.date, fetch_pages=args.pages)
        return 0 if ok else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
