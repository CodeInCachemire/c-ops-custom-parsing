#!/usr/bin/env python3
"""
StepStone.de parser for career-ops style job collection.

Two URL modes are supported:

1) ui mode, default
   Generates StepStone URLs in the same style as URLs produced by the website UI,
   for example:

   https://www.stepstone.de/jobs/financial-analyst/in-germany?radius=30&action=facet_selected%3Bage%3Bage_1&ag=age_1&searchOrigin=Resultlist_top-search

   This is what you normally want for Career Ops if you want the same style as
   Indeed/Glassdoor-style parameterized searches.

2) strict mode
   Generates only q-only URLs, matching the narrowest robots-friendly shape:

   https://www.stepstone.de/jobs/financial-analyst/in-germany?q=financial+analyst

The parser does not use login, cookies, proxies, browser automation, CAPTCHA
handling, or anti-bot bypass. It only requests public HTML and parses visible
result-card text.

Example:
    python stepstone_parser.py \
      --keyword "financial analyst" \
      --location Germany \
      --days 1 \
      --radius 30 \
      --fulltime \
      --output stepstone_jobs.csv
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Literal, Optional
from urllib.parse import parse_qs, quote_plus, urlencode, urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag

BASE_URL = "https://www.stepstone.de"
DEFAULT_USER_AGENT = "career-ops-stepstone-provider/0.2 (+https://github.com/your-org/career-ops)"

URLMode = Literal["ui", "strict"]

# Confirmed from StepStone-style URLs: age_1 is the website facet for jobs from
# the last 24 hours. age_7 appears in public StepStone result URLs as well.
# Keep unsupported day values as local filters instead of guessing too much.
AGE_FACET_BY_DAYS: dict[int, str] = {
    1: "age_1",
    7: "age_7",
}

# StepStone worktype facet observed in public URLs for Vollzeit.
FULLTIME_WORKTYPE = "80001"

POSTED_PATTERNS = [
    re.compile(r"\bin\s+\d+\s+Minuten\b", re.I),
    re.compile(r"\bvor\s+\d+\s+Minuten\b", re.I),
    re.compile(r"\bvor\s+\d+\s+Stunden\b", re.I),
    re.compile(r"\bvor\s+\d+\s+Tagen\b", re.I),
    re.compile(r"\bvor\s+\d+\s+Wochen\b", re.I),
    re.compile(r"\bgestern\b", re.I),
    re.compile(r"\bheute\b", re.I),
    re.compile(r"\bNEU\b"),
    re.compile(r"\bSei einer der ersten Bewerber\b", re.I),
]

NOISE_LINES = {
    "gehalt anzeigen",
    "mehr",
    "neu",
    "schnelle bewerbung",
    "anschreiben nicht erforderlich",
    "bewerben",
    "jobs finden",
}


@dataclass(slots=True)
class JobRecord:
    source: str
    title: str
    company: str
    location: str
    posted_text: str
    posted_days_ago: Optional[float]
    employment_type: str
    remote: str
    job_url: str
    description_snippet: str
    keyword: str
    query_url: str
    scraped_at: str

    def as_dict(self) -> dict[str, object]:
        return dataclasses.asdict(self)


def slugify_stepstone(value: str) -> str:
    """Create StepStone-ish path slugs.

    Examples:
    - "financial analyst" -> "financial-analyst"
    - "München" -> "muenchen"
    """
    value = value.strip().lower()
    replacements = {
        "ä": "ae",
        "ö": "oe",
        "ü": "ue",
        "ß": "ss",
        "&": " and ",
    }
    for src, dst in replacements.items():
        value = value.replace(src, dst)
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or "germany"


def location_to_path(location: str) -> str:
    normalized = location.strip().lower()
    if normalized in {"", "germany", "deutschland", "de", "anywhere"}:
        return "in-germany"
    return f"in-{slugify_stepstone(location)}"


def age_facet_for_days(days: Optional[int]) -> Optional[str]:
    """Return StepStone's age facet for supported day values.

    Supported by this provider:
    - 1 -> age_1, StepStone UI's last-24-hours facet
    - 7 -> age_7, observed in public StepStone URLs

    For other values, the parser still applies local filtering after parsing.
    """
    if days is None:
        return None
    return AGE_FACET_BY_DAYS.get(days)


def build_search_url(
    keyword: str,
    location: str = "Germany",
    *,
    max_age_days: Optional[int] = None,
    radius: Optional[int] = 30,
    fulltime_only: bool = False,
    page: Optional[int] = None,
    sort_date: bool = False,
    mode: URLMode = "ui",
) -> str:
    """Build a parameterized StepStone search URL.

    ui mode intentionally mirrors StepStone's own search-result URLs. For the
    user example:

        keyword="financial analyst", location="Germany", max_age_days=1,
        radius=30

    it returns:

        https://www.stepstone.de/jobs/financial-analyst/in-germany?radius=30&action=facet_selected%3Bage%3Bage_1&ag=age_1&searchOrigin=Resultlist_top-search

    strict mode returns a q-only URL:

        https://www.stepstone.de/jobs/financial-analyst/in-germany?q=financial+analyst
    """
    keyword_slug = slugify_stepstone(keyword)
    location_path = location_to_path(location)
    base = f"{BASE_URL}/jobs/{keyword_slug}/{location_path}"

    if mode == "strict":
        return f"{base}?q={quote_plus(keyword)}"
    if mode != "ui":
        raise ValueError(f"unknown StepStone URL mode: {mode!r}")

    params: dict[str, str] = {}

    if radius is not None:
        params["radius"] = str(radius)

    age_facet = age_facet_for_days(max_age_days)
    if age_facet:
        params["action"] = f"facet_selected;age;{age_facet}"
        params["ag"] = age_facet

    if fulltime_only:
        # If age is already the last clicked facet, keep action as age and only
        # add wt. If fulltime is the only facet, make action reflect worktypes.
        params.setdefault("action", f"facet_selected;worktypes;{FULLTIME_WORKTYPE}")
        params["wt"] = FULLTIME_WORKTYPE

    if page is not None:
        if page < 1:
            raise ValueError("page must be >= 1")
        params["page"] = str(page)

    if sort_date:
        # Public StepStone result URLs commonly use sort=2 when the UI shows
        # date sorting. Keep this optional because age_1 already narrows results.
        params["sort"] = "2"

    params["searchOrigin"] = "Resultlist_top-search"

    return f"{base}?{urlencode(params)}"


def is_allowed_stepstone_jobs_url(url: str, *, mode: URLMode = "ui") -> tuple[bool, str]:
    """Local sanity guardrail.

    This is not a full robots parser. It prevents obviously wrong/off-domain URLs
    and keeps strict mode inside the q-only URL shape.

    In ui mode, it allows StepStone's own public search-result parameter shapes,
    including radius/action/ag/wt/page/sort/searchOrigin, because that is the URL
    style requested for Career Ops parity with Indeed/Glassdoor/LinkedIn flows.
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc not in {"www.stepstone.de", "stepstone.de"}:
        return False, "not a StepStone.de URL"

    path = parsed.path.rstrip("/") + "/"
    if not path.startswith("/jobs/") and path != "/jobs/":
        return False, "only /jobs paths are supported"

    blocked_prefixes = (
        "/search-results/",
        "/listing/",
    )
    if any(path.startswith(prefix) for prefix in blocked_prefixes):
        return False, "blocked StepStone search-results/listing path"

    query = parse_qs(parsed.query, keep_blank_values=True)
    if mode == "strict":
        if not query:
            return True, "queryless /jobs URL"
        if set(query.keys()) == {"q"} and query.get("q", [""])[0].strip():
            return True, "single q= keyword query"
        return False, "strict mode allows only a single q= query parameter"

    allowed_keys = {"radius", "action", "ag", "wt", "page", "sort", "searchOrigin", "q"}
    unknown = set(query) - allowed_keys
    if unknown:
        return False, f"unsupported StepStone query params: {sorted(unknown)}"
    return True, "public StepStone jobs URL shape"


def fetch_html(
    url: str,
    *,
    timeout: int = 25,
    user_agent: str = DEFAULT_USER_AGENT,
    mode: URLMode = "ui",
) -> str:
    allowed, reason = is_allowed_stepstone_jobs_url(url, mode=mode)
    if not allowed:
        raise ValueError(f"Refusing StepStone URL: {url} ({reason})")

    response = requests.get(
        url,
        timeout=timeout,
        headers={"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"},
    )
    response.raise_for_status()
    return response.text


def compact_lines(text: str) -> list[str]:
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        if line.lower() in NOISE_LINES:
            continue
        # Skip large CSS/JS blobs if they leak into visible text extraction.
        if "{box-sizing" in line or line.startswith(".") and "{" in line:
            continue
        lines.append(line)
    return lines


def find_posted_text(text: str) -> str:
    for pattern in POSTED_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return ""


def posted_text_to_days(posted_text: str) -> Optional[float]:
    if not posted_text:
        return None
    t = posted_text.lower()
    if "sei einer der ersten bewerber" in t:
        return 0.0
    if "neu" in t or "heute" in t or "minuten" in t or "stunde" in t:
        return 0.0
    if "gestern" in t:
        return 1.0
    m = re.search(r"vor\s+(\d+)\s+tagen", t)
    if m:
        return float(m.group(1))
    m = re.search(r"vor\s+(\d+)\s+wochen", t)
    if m:
        return float(m.group(1)) * 7.0
    return None


def infer_employment_type(text: str) -> str:
    found = []
    if re.search(r"\bVollzeit\b", text, re.I):
        found.append("Vollzeit")
    if re.search(r"\bTeilzeit\b", text, re.I):
        found.append("Teilzeit")
    if re.search(r"\bPraktikum\b", text, re.I):
        found.append("Praktikum")
    if re.search(r"\bWerkstudent", text, re.I):
        found.append("Werkstudent")
    if re.search(r"\bFeste Anstellung\b", text, re.I):
        found.append("Feste Anstellung")
    if re.search(r"\bBerufseinstieg/Trainee\b", text, re.I):
        found.append("Berufseinstieg/Trainee")
    return ", ".join(dict.fromkeys(found))


def infer_remote(text: str) -> str:
    if re.search(r"\bNur Home-Office\b|\bRemote\b|\b100%\s*remote\b", text, re.I):
        return "remote"
    if re.search(r"Homeoffice|Home-Office|hybrid|Teilweise Home", text, re.I):
        return "hybrid_or_homeoffice_possible"
    return ""


def nearest_card(anchor: Tag) -> Optional[Tag]:
    """Walk upward until we find a container that looks like one result card."""
    node: Optional[Tag] = anchor
    for _ in range(8):
        if node is None or not isinstance(node, Tag):
            break
        text = node.get_text("\n", strip=True)
        if len(text) > 15 and (find_posted_text(text) or infer_employment_type(text)):
            return node
        node = node.parent if isinstance(node.parent, Tag) else None
    return None


def looks_like_job_link(href: str, title: str) -> bool:
    if not href or href.startswith("#"):
        return False
    low = href.lower()
    bad = ["/cmp/", "/unternehmen/", "/gehalt/", "/jobs?", "page=", "savedjobs", "jobagent"]
    if any(b in low for b in bad):
        return False
    if len(title.strip()) < 1:
        return False
    if low.startswith("/stellenangebote") or "stellenangebote" in low:
        return True
    if low.startswith("/jobs/") and title.lower() not in {"1", "2", "3", "vollzeit", "teilzeit", "home office"}:
        return True
    return False


def parse_card(anchor: Tag, card: Tag, *, keyword: str, query_url: str, scraped_at: str) -> Optional[JobRecord]:
    title = re.sub(r"\s+", " ", anchor.get_text(" ", strip=True)).strip()
    if not title:
        return None

    href = anchor.get("href", "")
    job_url = urljoin(BASE_URL, href)
    raw_text = card.get_text("\n", strip=True)
    lines = compact_lines(raw_text)
    if not lines:
        return None

    cleaned = [line for line in lines if line != title]

    posted_text = find_posted_text(raw_text)
    posted_days_ago = posted_text_to_days(posted_text)
    employment_type = infer_employment_type(raw_text)
    remote = infer_remote(raw_text)

    company = ""
    location = ""
    for line in cleaned[:10]:
        if find_posted_text(line):
            continue
        if line.lower() in NOISE_LINES:
            continue
        if re.search(r"Vollzeit|Teilzeit|Praktikum|Werkstudent|Homeoffice|Home-Office|Feste Anstellung", line, re.I):
            continue
        if not company:
            company = line
            continue
        if not location:
            location = line
            break

    description_lines = []
    for line in cleaned:
        if line in {company, location}:
            continue
        if find_posted_text(line):
            continue
        if line.lower() in NOISE_LINES:
            continue
        description_lines.append(line)
    snippet = re.sub(r"\s+", " ", " ".join(description_lines)).strip()[:1200]

    return JobRecord(
        source="stepstone",
        title=title,
        company=company,
        location=location,
        posted_text=posted_text,
        posted_days_ago=posted_days_ago,
        employment_type=employment_type,
        remote=remote,
        job_url=job_url,
        description_snippet=snippet,
        keyword=keyword,
        query_url=query_url,
        scraped_at=scraped_at,
    )


def parse_stepstone_html(html: str, *, keyword: str, query_url: str) -> list[JobRecord]:
    soup = BeautifulSoup(html, "html.parser")
    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    records: list[JobRecord] = []
    seen_urls: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        title = re.sub(r"\s+", " ", anchor.get_text(" ", strip=True)).strip()
        href = str(anchor.get("href", ""))
        if not looks_like_job_link(href, title):
            continue
        card = nearest_card(anchor)
        if card is None:
            continue
        record = parse_card(anchor, card, keyword=keyword, query_url=query_url, scraped_at=scraped_at)
        if record and record.job_url not in seen_urls:
            seen_urls.add(record.job_url)
            records.append(record)

    if not records:
        records.extend(parse_embedded_json_fallback(soup, keyword=keyword, query_url=query_url, scraped_at=scraped_at))

    return records


def parse_embedded_json_fallback(
    soup: BeautifulSoup, *, keyword: str, query_url: str, scraped_at: str
) -> list[JobRecord]:
    records: list[JobRecord] = []
    seen = set()
    for script in soup.find_all("script"):
        text = script.string or script.get_text(" ", strip=True)
        if not text or not any(k in text.lower() for k in ["job", "company", "location"]):
            continue
        for m in re.finditer(r'\{[^{}]{0,4000}(?:title|jobTitle|name)[^{}]{0,4000}\}', text, re.I):
            blob = m.group(0)
            try:
                data = json.loads(blob)
            except Exception:
                continue
            title = str(data.get("title") or data.get("jobTitle") or data.get("name") or "").strip()
            if not title:
                continue
            url = str(data.get("url") or data.get("jobUrl") or data.get("link") or "").strip()
            job_url = urljoin(BASE_URL, url) if url else ""
            if not job_url or job_url in seen:
                continue
            seen.add(job_url)
            company = ""
            org = data.get("hiringOrganization") or data.get("company") or data.get("companyName")
            if isinstance(org, dict):
                company = str(org.get("name") or "")
            elif org:
                company = str(org)
            loc = data.get("jobLocation") or data.get("location") or data.get("city") or ""
            if isinstance(loc, dict):
                location = str(loc.get("name") or loc.get("addressLocality") or loc.get("address") or "")
            else:
                location = str(loc)
            desc = str(data.get("description") or data.get("text") or "")
            posted = str(data.get("datePosted") or data.get("postedAt") or "")
            records.append(
                JobRecord(
                    source="stepstone",
                    title=title,
                    company=company,
                    location=location,
                    posted_text=posted,
                    posted_days_ago=None,
                    employment_type=infer_employment_type(desc),
                    remote=infer_remote(desc + " " + location),
                    job_url=job_url,
                    description_snippet=re.sub(r"\s+", " ", BeautifulSoup(desc, "html.parser").get_text(" ")).strip()[:1200],
                    keyword=keyword,
                    query_url=query_url,
                    scraped_at=scraped_at,
                )
            )
    return records


def filter_records(
    records: Iterable[JobRecord],
    *,
    max_age_days: Optional[int] = None,
    fulltime_only: bool = False,
    include_unknown_age: bool = False,
) -> list[JobRecord]:
    filtered = []
    for record in records:
        if max_age_days is not None:
            if record.posted_days_ago is None:
                if not include_unknown_age:
                    continue
            elif record.posted_days_ago > max_age_days:
                continue
        if fulltime_only and "vollzeit" not in record.employment_type.lower() and "vollzeit" not in record.description_snippet.lower():
            continue
        filtered.append(record)
    return filtered


def search_stepstone(
    *,
    keyword: str,
    location: str = "Germany",
    max_age_days: Optional[int] = None,
    radius: Optional[int] = 30,
    fulltime_only: bool = False,
    include_unknown_age: bool = False,
    page: Optional[int] = None,
    sort_date: bool = False,
    url_mode: URLMode = "ui",
    sleep_seconds: float = 1.5,
) -> list[JobRecord]:
    url = build_search_url(
        keyword,
        location,
        max_age_days=max_age_days,
        radius=radius,
        fulltime_only=fulltime_only,
        page=page,
        sort_date=sort_date,
        mode=url_mode,
    )
    html = fetch_html(url, mode=url_mode)
    if sleep_seconds > 0:
        time.sleep(sleep_seconds)
    records = parse_stepstone_html(html, keyword=keyword, query_url=url)

    # Keep local filtering as a second safety net. If the UI URL facet works,
    # this will be a no-op for most rows. If StepStone changes the facet, the
    # output stays clean instead of silently returning older jobs.
    return filter_records(
        records,
        max_age_days=max_age_days,
        fulltime_only=fulltime_only,
        include_unknown_age=include_unknown_age,
    )


def write_csv(path: str, records: Iterable[JobRecord]) -> None:
    rows = [record.as_dict() for record in records]
    fieldnames = [field.name for field in dataclasses.fields(JobRecord)]
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="StepStone.de job parser")
    parser.add_argument("--keyword", action="append", required=True, help="Keyword/search phrase. Repeat for multiple searches.")
    parser.add_argument("--location", default="Germany", help="Germany, Deutschland, Berlin, München, etc.")
    parser.add_argument("--days", type=int, default=None, help="Keep jobs posted within this many days. days=1 generates ag=age_1 in ui mode.")
    parser.add_argument("--radius", type=int, default=30, help="StepStone radius in km for ui URLs. Use --no-radius to omit.")
    parser.add_argument("--no-radius", action="store_true", help="Do not include radius in the generated URL.")
    parser.add_argument("--fulltime", action="store_true", help="Use StepStone Vollzeit facet wt=80001 and keep visible Vollzeit records.")
    parser.add_argument("--page", type=int, default=None, help="Generate a specific StepStone result page, e.g. --page 2.")
    parser.add_argument("--pages", type=int, default=1, help="Fetch result pages from 1..N. Default: 1.")
    parser.add_argument("--sort-date", action="store_true", help="Add sort=2, the StepStone date-sort parameter observed in public URLs.")
    parser.add_argument("--url-mode", choices=["ui", "strict"], default="ui", help="ui=StepStone UI-style params; strict=q-only URL.")
    parser.add_argument("--include-unknown-age", action="store_true", help="Keep records when posted age could not be parsed.")
    parser.add_argument("--output", default="stepstone_jobs.csv", help="CSV output path.")
    parser.add_argument("--sleep", type=float, default=1.5, help="Delay between requests.")
    parser.add_argument("--print-url-only", action="store_true", help="Print generated URLs and exit without fetching.")
    return parser.parse_args(argv)


def iter_pages(page: Optional[int], pages: int) -> list[Optional[int]]:
    if page is not None:
        return [page]
    if pages <= 1:
        return [None]
    return list(range(1, pages + 1))


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    all_records: list[JobRecord] = []
    seen_keys: set[tuple[str, str, str]] = set()
    radius = None if args.no_radius else args.radius

    for keyword in args.keyword:
        for page in iter_pages(args.page, args.pages):
            generated_url = build_search_url(
                keyword,
                args.location,
                max_age_days=args.days,
                radius=radius,
                fulltime_only=args.fulltime,
                page=page,
                sort_date=args.sort_date,
                mode=args.url_mode,
            )

            if args.print_url_only:
                print(generated_url)
                continue

            try:
                records = search_stepstone(
                    keyword=keyword,
                    location=args.location,
                    max_age_days=args.days,
                    radius=radius,
                    fulltime_only=args.fulltime,
                    include_unknown_age=args.include_unknown_age,
                    page=page,
                    sort_date=args.sort_date,
                    url_mode=args.url_mode,
                    sleep_seconds=args.sleep,
                )
            except Exception as exc:
                print(f"[stepstone] failed keyword={keyword!r} page={page!r}: {exc}", file=sys.stderr)
                continue

            for record in records:
                key = (record.job_url, record.title.lower(), record.company.lower())
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                all_records.append(record)

    if args.print_url_only:
        return 0

    write_csv(args.output, all_records)
    print(f"wrote {len(all_records)} rows to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
