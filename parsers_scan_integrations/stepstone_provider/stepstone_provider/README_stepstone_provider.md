# StepStone Provider for Career Ops

This provider generates StepStone.de search URLs and parses visible public result-card text into the same normalized CSV style as the Indeed / Glassdoor / LinkedIn parser work.

It supports two URL modes:

## 1. `ui` mode — default

This mirrors the URL style StepStone creates when you use the website filters.

For:

```bash
python stepstone_parser.py \
  --keyword "financial analyst" \
  --location Germany \
  --days 1 \
  --radius 30 \
  --print-url-only
```

it generates:

```text
https://www.stepstone.de/jobs/financial-analyst/in-germany?radius=30&action=facet_selected%3Bage%3Bage_1&ag=age_1&searchOrigin=Resultlist_top-search
```

That matches the important structure from the manually searched URL:

```text
/jobs/financial-analyst/in-germany?radius=30&action=facet_selected%3Bage%3Bage_1&ag=age_1&searchOrigin=Resultlist_top-search
```

Mappings used:

- `--days 1` -> `ag=age_1` and `action=facet_selected;age;age_1`
- `--days 7` -> `ag=age_7` and `action=facet_selected;age;age_7`
- `--radius 30` -> `radius=30`
- `--fulltime` -> `wt=80001`
- `--page 2` or `--pages 3` -> `page=2`, etc.
- `--sort-date` -> `sort=2`

The parser still applies local filtering after parsing as a safety net, so `--days 1` and `--fulltime` also clean the output CSV from visible card text.

## 2. `strict` mode

This generates only the narrow q-only URL shape:

```bash
python stepstone_parser.py \
  --keyword "financial analyst" \
  --location Germany \
  --url-mode strict \
  --print-url-only
```

Output:

```text
https://www.stepstone.de/jobs/financial-analyst/in-germany?q=financial+analyst
```

Use this if you want the most conservative mode.

## Install

```bash
pip install requests beautifulsoup4
```

## Run

```bash
python stepstone_parser.py \
  --keyword "financial analyst" \
  --location Germany \
  --days 1 \
  --radius 30 \
  --fulltime \
  --output stepstone_financial_analyst.csv
```

Multiple keywords:

```bash
python stepstone_parser.py \
  --keyword "financial analyst" \
  --keyword "finance intern" \
  --location Germany \
  --days 1 \
  --radius 30 \
  --pages 2 \
  --output stepstone_finance.csv
```

## Output columns

- `source`
- `title`
- `company`
- `location`
- `posted_text`
- `posted_days_ago`
- `employment_type`
- `remote`
- `job_url`
- `description_snippet`
- `keyword`
- `query_url`
- `scraped_at`

## Integration idea

Wire `search_stepstone(...)` into the same provider registry as Indeed/Glassdoor, then normalize `JobRecord.as_dict()` into your shared Career Ops schema.

Recommended provider call:

```python
records = search_stepstone(
    keyword="financial analyst",
    location="Germany",
    max_age_days=1,
    radius=30,
    fulltime_only=True,
    url_mode="ui",
)
```

For Santifer-style provider integration, expose the same knobs as the other parsers:

```text
keyword, location, days, radius, fulltime, pages, output
```
