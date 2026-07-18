from stepstone_parser import (
    build_search_url,
    filter_records,
    is_allowed_stepstone_jobs_url,
    parse_stepstone_html,
    posted_text_to_days,
)


def test_build_search_url_ui_age_1_matches_stepstone_style():
    url = build_search_url("financial analyst", "Germany", max_age_days=1, radius=30, mode="ui")
    assert url == (
        "https://www.stepstone.de/jobs/financial-analyst/in-germany?"
        "radius=30&action=facet_selected%3Bage%3Bage_1&ag=age_1&searchOrigin=Resultlist_top-search"
    )
    allowed, _ = is_allowed_stepstone_jobs_url(url, mode="ui")
    assert allowed


def test_build_search_url_strict_q_only():
    url = build_search_url("financial analyst", "Germany", mode="strict")
    assert url == "https://www.stepstone.de/jobs/financial-analyst/in-germany?q=financial+analyst"
    allowed, _ = is_allowed_stepstone_jobs_url(url, mode="strict")
    assert allowed


def test_strict_mode_disallows_extra_query_params():
    allowed, _ = is_allowed_stepstone_jobs_url(
        "https://www.stepstone.de/jobs/financial-analyst/in-germany?q=financial+analyst&page=2",
        mode="strict",
    )
    assert not allowed


def test_ui_mode_supports_fulltime_and_page():
    url = build_search_url(
        "financial analyst",
        "Germany",
        max_age_days=1,
        radius=30,
        fulltime_only=True,
        page=2,
        mode="ui",
    )
    assert "ag=age_1" in url
    assert "wt=80001" in url
    assert "page=2" in url
    allowed, _ = is_allowed_stepstone_jobs_url(url, mode="ui")
    assert allowed


def test_posted_text_to_days():
    assert posted_text_to_days("NEU") == 0.0
    assert posted_text_to_days("Sei einer der ersten Bewerber") == 0.0
    assert posted_text_to_days("in 23 Minuten") == 0.0
    assert posted_text_to_days("vor 4 Stunden") == 0.0
    assert posted_text_to_days("gestern") == 1.0
    assert posted_text_to_days("vor 3 Tagen") == 3.0
    assert posted_text_to_days("vor 2 Wochen") == 14.0


def test_parse_simple_card():
    html = """
    <html><body>
      <article>
        <h2><a href="/stellenangebote--Financial-Analyst-Berlin-Example-GmbH--123456-inline.html">Financial Analyst</a></h2>
        <div>Example GmbH</div>
        <div>Berlin</div>
        <div>Feste Anstellung, Vollzeit, Homeoffice möglich</div>
        <p>Build dashboards and financial models.</p>
        <span>vor 1 Tagen</span>
      </article>
    </body></html>
    """
    rows = parse_stepstone_html(
        html,
        keyword="financial analyst",
        query_url=build_search_url("financial analyst", "Germany", max_age_days=1),
    )
    assert len(rows) == 1
    assert rows[0].title == "Financial Analyst"
    assert rows[0].company == "Example GmbH"
    assert rows[0].location == "Berlin"
    assert rows[0].posted_days_ago == 1.0
    assert "Vollzeit" in rows[0].employment_type
    assert rows[0].remote == "hybrid_or_homeoffice_possible"


def test_filter_days_and_fulltime():
    html = """
    <html><body>
      <article><h2><a href="/stellenangebote--A--1.html">A</a></h2><div>C</div><div>Berlin</div><div>Vollzeit</div><span>vor 1 Tagen</span></article>
      <article><h2><a href="/stellenangebote--B--2.html">B</a></h2><div>C</div><div>Berlin</div><div>Teilzeit</div><span>vor 5 Tagen</span></article>
    </body></html>
    """
    rows = parse_stepstone_html(html, keyword="x", query_url=build_search_url("x", "Germany", max_age_days=1))
    rows = filter_records(rows, max_age_days=1, fulltime_only=True)
    assert [r.title for r in rows] == ["A"]
