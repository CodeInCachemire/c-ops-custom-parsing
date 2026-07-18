#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INTEGRATION_ROOT = ROOT / "parsers_scan_integrations" / "stepstone_provider" / "stepstone_provider"
if str(INTEGRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(INTEGRATION_ROOT))

from stepstone_parser import search_stepstone  # type: ignore


def parse_args(argv: list[str]) -> dict[str, str]:
    args: dict[str, str] = {}
    idx = 0
    while idx < len(argv):
        key = argv[idx]
        if key.startswith("--") and idx + 1 < len(argv):
            args[key[2:]] = argv[idx + 1]
            idx += 2
        else:
            idx += 1
    return args


def normalize_keywords(value) -> list[str]:
    if isinstance(value, list):
        items = value
    else:
        items = [value]
    return [str(item).strip() for item in items if str(item).strip()]


def posted_at_from_days(days_ago: float | None) -> int | None:
    if days_ago is None:
        return None
    ts = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return int(ts.timestamp() * 1000)


def main() -> int:
    args = parse_args(sys.argv[1:])
    if "entry-json" not in args:
        raise SystemExit("missing --entry-json")

    entry = json.loads(args["entry-json"])
    cfg = entry.get("stepstone") or {}
    keywords = normalize_keywords(cfg.get("keywords"))
    if not keywords:
        raise SystemExit("stepstone.keywords must be a non-empty list")

    location = str(cfg.get("location") or "Germany").strip()
    days = int(cfg.get("days") or 10)
    pages = int(cfg.get("pages") or 1)
    radius = cfg.get("radius")
    radius_value = int(radius) if radius is not None else 30
    fulltime_only = cfg.get("fulltime_only") is not False
    url_mode = str(cfg.get("url_mode") or "ui").strip()
    include_unknown_age = cfg.get("keep_unknown_dates") is True
    sleep_seconds = float(cfg.get("sleep_seconds") or 1.0)

    rows: list[dict[str, object]] = []
    seen: set[str] = set()

    for keyword in keywords:
        for page in range(1, max(1, pages) + 1):
            try:
                records = search_stepstone(
                    keyword=keyword,
                    location=location,
                    max_age_days=days,
                    radius=radius_value,
                    fulltime_only=fulltime_only,
                    include_unknown_age=include_unknown_age,
                    page=page if pages > 1 else None,
                    sort_date=True,
                    url_mode=url_mode,
                    sleep_seconds=sleep_seconds,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[stepstone] {keyword} page={page}: {type(exc).__name__}: {exc}", file=sys.stderr)
                continue

            for record in records:
                if not record.job_url or record.job_url in seen:
                    continue
                seen.add(record.job_url)
                rows.append({
                    "source": "stepstone",
                    "title": record.title,
                    "url": record.job_url,
                    "company": record.company,
                    "location": record.location,
                    "postedAt": posted_at_from_days(record.posted_days_ago),
                    "description": record.description_snippet,
                    "employment_type": record.employment_type,
                    "remote": record.remote,
                })

    print(json.dumps(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
