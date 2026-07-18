#!/usr/bin/env node

import { chromium } from 'playwright';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOST = 'de.indeed.com';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function intOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : fallback;
}

function normalizeKeywords(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSearchUrls({ keyword, location, days, jobType, host, pages, jobTypeEncoding }) {
  const urls = [];
  const variants = jobType && jobTypeEncoding === 'both'
    ? ['jt', 'sc']
    : [jobTypeEncoding === 'sc' ? 'sc' : 'jt'];

  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const start = pageIndex * 10;
    for (const variant of variants) {
      const params = new URLSearchParams({
        q: keyword,
        l: location,
        fromage: String(days),
        sort: 'date',
      });
      if (start > 0) params.set('start', String(start));
      if (jobType) {
        if (variant === 'sc') params.set('sc', `0kf:jt(${jobType});`);
        else params.set('jt', jobType);
      }
      urls.push(`https://${host}/jobs?${params.toString()}`);
    }
  }

  return [...new Set(urls)];
}

function canonicalizeIndeedUrl(host, href, jobKey) {
  if (jobKey) return `https://${host}/viewjob?jk=${jobKey}`;
  if (!href) return '';
  try {
    const parsed = new URL(href, `https://${host}`);
    const jk = parsed.searchParams.get('jk') || parsed.searchParams.get('vjk') || '';
    if (jk) return `https://${host}/viewjob?jk=${jk}`;
    return parsed.toString();
  } catch {
    return '';
  }
}

function parsePostedAt(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!raw) return undefined;

  const now = Date.now();
  if (['neu', 'new', 'just posted', 'heute', 'today', 'gerade geschaltet'].includes(raw)) {
    return now;
  }
  if (['gestern', 'yesterday'].includes(raw)) return now - DAY_MS;

  const patterns = [
    [/vor\s+(\d+)\s+minuten?/, 60 * 1000],
    [/vor\s+(\d+)\s+stunden?/, 60 * 60 * 1000],
    [/vor\s+(\d+)\s+tagen?/, DAY_MS],
    [/(\d+)\s*(?:minute|minutes|min|mins)\s+ago/, 60 * 1000],
    [/(\d+)\s*(?:hour|hours|hr|hrs|h)\s+ago/, 60 * 60 * 1000],
    [/(\d+)\s*(?:day|days|d)\s+ago/, DAY_MS],
    [/(\d+)\s*h\b/, 60 * 60 * 1000],
    [/(\d+)\s*d\b/, DAY_MS],
  ];
  for (const [pattern, unitMs] of patterns) {
    const match = raw.match(pattern);
    if (match) return now - Number(match[1]) * unitMs;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function looksLikeEmploymentType(text) {
  return /vollzeit|teilzeit|full.?time|part.?time|contract|befristet|unbefristet|praktikum|internship/i.test(text);
}

function looksLikeSalary(text) {
  return /(?:€|\$|£|eur|usd|chf)/i.test(text) && /\d/.test(text);
}

function inferRemote(location, title, snippet) {
  const joined = `${location} ${title} ${snippet}`.toLowerCase();
  if (/remote|homeoffice|hybrid/.test(joined)) return 'true';
  return '';
}

async function dismissCookieBanner(page) {
  const labels = [
    'Alle Cookies akzeptieren',
    'Alle akzeptieren',
    'Accept All',
    'Accept',
    'Alle ablehnen',
    'Reject All',
  ];
  for (const label of labels) {
    try {
      const button = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
      if (await button.count()) {
        await button.first().click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {}
  }
}

async function extractCards(page, host) {
  return page.evaluate((pageHost) => {
    const text = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const value = node?.textContent?.replace(/\s+/g, ' ').trim();
        if (value) return value;
      }
      return '';
    };

    const attr = (root, selectors, name) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const value = node?.getAttribute?.(name)?.trim?.() || '';
        if (value) return value;
      }
      return '';
    };

    const cards = [];
    const seen = new Set();
    const selectors = [
      'div.job_seen_beacon',
      'div[data-testid="slider_item"]',
      'td.resultContent',
      'div.result',
      'li.css-5lfssm',
    ];
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        if (seen.has(card)) continue;
        seen.add(card);
        cards.push(card);
      }
    }

    const results = [];
    for (const card of cards) {
      const title = text(card, [
        'h2.jobTitle a span[title]',
        'h2.jobTitle span[title]',
        'h2.jobTitle a',
        'a[data-jk] span',
        'a.jcs-JobTitle span[title]',
        'a.jcs-JobTitle',
        'span[id^="jobTitle"]',
        '[data-testid="job-title"]',
        'h2',
      ]);
      if (!title) continue;

      const company = text(card, [
        'span[data-testid="company-name"]',
        'span.companyName',
        '[data-testid="company-name"]',
        '.companyName',
      ]);
      const location = text(card, [
        'div[data-testid="text-location"]',
        'div.companyLocation',
        '[data-testid="text-location"]',
        '.companyLocation',
      ]);
      const postedText = text(card, [
        'span[data-testid="myJobsStateDate"]',
        '[data-testid="job-age"]',
        'span.date',
        '.date',
      ]);
      const snippet = text(card, [
        'div.job-snippet',
        '.job-snippet',
        '[data-testid="job-snippet"]',
      ]);

      const meta = [...card.querySelectorAll(
        '.metadataContainer li, .jobMetaDataGroup li, [data-testid="attribute_snippet_testid"], .salary-snippet-container, .estimated-salary-container'
      )]
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
        .filter(Boolean);
      const salaryRaw = meta.find((value) => /(?:€|\$|£|eur|usd|chf)/i.test(value) && /\d/.test(value)) || '';
      const employmentType = meta.find((value) => /vollzeit|teilzeit|full.?time|part.?time|contract|befristet|unbefristet|praktikum|internship/i.test(value)) || '';
      const postedFallback = meta.find((value) => /(?:neu|new|today|heute|yesterday|gestern|just posted|gerade geschaltet|vor\s+\d+\s+(?:minuten?|stunden?|tagen?)|\d+\s*(?:h|d)\b|\d+\s*(?:day|days|hour|hours)\s+ago)/i.test(value)) || '';

      let jobKey = '';
      if (card.getAttribute('data-jk')) jobKey = card.getAttribute('data-jk').trim();
      if (!jobKey) jobKey = attr(card, ['a[data-jk]', 'a.jcs-JobTitle'], 'data-jk');

      const href = attr(card, ['a[data-jk]', 'a.jcs-JobTitle', 'h2.jobTitle a'], 'href');
      let url = '';
      try {
        const parsed = new URL(href || '', `https://${pageHost}`);
        const jk = jobKey || parsed.searchParams.get('jk') || parsed.searchParams.get('vjk') || '';
        url = jk ? `https://${pageHost}/viewjob?jk=${jk}` : parsed.toString();
      } catch {}

      results.push({
        title,
        company,
        location,
        postedText: postedText || postedFallback,
        description: snippet,
        salaryRaw,
        employmentType,
        url,
      });
    }
    return results;
  }, host);
}

async function scrapeUrl(browser, url, host, pauseMs) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(pauseMs);
    await dismissCookieBanner(page);
    await page.waitForTimeout(500);

    const title = await page.title();
    const body = await page.locator('body').innerText().catch(() => '');
    if (/403 forbidden|access denied|robot|captcha|challenge/i.test(`${title}\n${body}`)) {
      throw new Error(`blocked by anti-bot challenge: ${url}`);
    }

    return await extractCards(page, host);
  } finally {
    await page.close();
  }
}

function normalizeJobs(cards, keyword, config) {
  const seen = new Set();
  const jobs = [];
  const maxAgeMs = config.days * DAY_MS;
  const now = Date.now();

  for (const card of cards) {
    const jobKey = '';
    const url = canonicalizeIndeedUrl(config.host, card.url, jobKey);
    if (!url || seen.has(url)) continue;

    const postedAt = parsePostedAt(card.postedText);
    if (postedAt === undefined && !config.keepUnknownDates) continue;
    if (postedAt !== undefined && now - postedAt > maxAgeMs) continue;

    seen.add(url);
    jobs.push({
      source: 'indeed',
      title: card.title,
      url,
      company: card.company || '',
      location: card.location || '',
      postedAt,
      description: card.description || `Indeed search keyword: ${keyword}`,
      employmentType: card.employmentType || '',
      remote: inferRemote(card.location, card.title, card.description),
      ...(card.salaryRaw ? { salaryRaw: card.salaryRaw } : {}),
    });
  }

  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['entry-json']) throw new Error('missing --entry-json');

  const entry = JSON.parse(args['entry-json']);
  const raw = entry.indeed || {};
  const config = {
    location: typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : 'Germany',
    days: intOr(raw.days, 10) || 10,
    pages: Math.max(1, intOr(raw.pages, 1) || 1),
    jobType: typeof raw.job_type === 'string' && raw.job_type.trim() ? raw.job_type.trim() : '',
    host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : DEFAULT_HOST,
    jobTypeEncoding: typeof raw.job_type_encoding === 'string' && raw.job_type_encoding.trim()
      ? raw.job_type_encoding.trim().toLowerCase()
      : 'both',
    pauseMs: intOr(raw.pause_ms, 1200) || 1200,
    keepUnknownDates: raw.keep_unknown_dates === true,
  };

  const keywords = normalizeKeywords(raw.keywords);
  if (keywords.length === 0) throw new Error('indeed.keywords must be a non-empty list');

  const browser = await chromium.launch({ headless: true });
  try {
    const all = [];
    for (const keyword of keywords) {
      const urls = buildSearchUrls({ keyword, ...config });
      for (const url of urls) {
        try {
          const cards = await scrapeUrl(browser, url, config.host, config.pauseMs);
          all.push(...normalizeJobs(cards, keyword, config));
        } catch (err) {
          console.error(`[indeed] ${keyword}: ${err.message}`);
        }
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const job of all) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      deduped.push(job);
    }

    process.stdout.write(`${JSON.stringify(deduped)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
