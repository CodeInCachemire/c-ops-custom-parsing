#!/usr/bin/env node

import { chromium } from 'playwright';

const SECONDS_PER_DAY = 86_400;
const WORKPLACE_MAP = { onsite: '1', remote: '2', hybrid: '3' };
const EXPERIENCE_MAP = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};
const JOB_TYPE_MAP = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  temporary: 'T',
  volunteer: 'V',
  internship: 'I',
  other: 'O',
};

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

function buildSearchUrl({ keyword, location, days, workplaceType, experience, jobType }) {
  const params = new URLSearchParams({
    keywords: keyword,
    location,
    f_TPR: `r${days * SECONDS_PER_DAY}`,
    sortBy: 'DD',
  });
  if (workplaceType && WORKPLACE_MAP[workplaceType]) params.set('f_WT', WORKPLACE_MAP[workplaceType]);
  if (experience && EXPERIENCE_MAP[experience]) params.set('f_E', EXPERIENCE_MAP[experience]);
  if (jobType && JOB_TYPE_MAP[jobType]) params.set('f_JT', JOB_TYPE_MAP[jobType]);
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function canonicalizeJobUrl(url) {
  if (!url) return '';
  const match = String(url).match(/\/jobs\/view\/(?:[^/?#]*-at-[^/?#]*-)?(\d+)/i)
    || String(url).match(/[?&](?:currentJobId|jobId)=(\d+)/i);
  return match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : '';
}

function parseRelativePostedAt(text, datetimeValue) {
  if (datetimeValue) {
    const ts = Date.parse(datetimeValue);
    if (Number.isFinite(ts)) return ts;
  }

  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return undefined;
  const now = Date.now();
  if (raw === 'just now' || raw === 'today' || raw === 'heute') return now;
  if (raw === 'yesterday' || raw === 'gestern') return now - SECONDS_PER_DAY * 1000;

  const patterns = [
    [/(\d+)\s*(minute|minutes|min|mins|m)\s+ago/, 60 * 1000],
    [/(\d+)\s*(hour|hours|hr|hrs|h)\s+ago/, 60 * 60 * 1000],
    [/(\d+)\s*(day|days|d)\s+ago/, 24 * 60 * 60 * 1000],
    [/(\d+)\s*(week|weeks|w)\s+ago/, 7 * 24 * 60 * 60 * 1000],
    [/vor\s+(\d+)\s+minuten/, 60 * 1000],
    [/vor\s+(\d+)\s+stunden?/, 60 * 60 * 1000],
    [/vor\s+(\d+)\s+tagen?/, 24 * 60 * 60 * 1000],
    [/vor\s+(\d+)\s+wochen?/, 7 * 24 * 60 * 60 * 1000],
  ];
  for (const [pattern, unitMs] of patterns) {
    const match = raw.match(pattern);
    if (match) return now - Number(match[1]) * unitMs;
  }

  const iso = Date.parse(raw);
  return Number.isFinite(iso) ? iso : undefined;
}

async function dismissCookieBanner(page) {
  const labels = ['Reject', 'Decline', 'Accept', 'Ablehnen'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    try {
      if (await button.count()) {
        await button.first().click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {}
  }
}

async function clickShowMore(page) {
  const selectors = [
    'button.infinite-scroller__show-more-button',
    'button[aria-label*="See more jobs" i]',
    'button[aria-label*="Show more jobs" i]',
  ];
  for (const selector of selectors) {
    try {
      const button = page.locator(selector);
      if (await button.count()) {
        await button.first().click({ timeout: 2000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }
  return false;
}

async function extractCards(page) {
  return page.evaluate(() => {
    const text = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const value = node?.textContent?.replace(/\s+/g, ' ').trim();
        if (value) return value;
      }
      return '';
    };

    const nodes = [...document.querySelectorAll('li, div.base-card, div.job-search-card')];
    const rows = [];
    for (const node of nodes) {
      const link = node.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]');
      if (!link) continue;
      const url = link.href || '';
      const title = text(node, ['.base-search-card__title', '.base-card__title', 'h3', 'h2']) || link.textContent?.trim() || '';
      if (!title) continue;
      rows.push({
        title,
        company: text(node, ['.base-search-card__subtitle', '.base-card__subtitle', 'h4 a', 'h4']),
        location: text(node, ['.job-search-card__location', '.base-search-card__metadata', '.job-search-card__location span']),
        postedText: text(node, ['time', '.job-search-card__listdate', '.job-search-card__listdate--new']),
        postedDate: node.querySelector('time')?.getAttribute('datetime') || '',
        url,
      });
    }
    return rows;
  });
}

async function scrapeKeyword(browser, config, keyword) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });

  const url = buildSearchUrl({ keyword, ...config });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(config.pauseMs);
    await dismissCookieBanner(page);

    let previousCount = 0;
    let stagnant = 0;
    for (let i = 0; i < config.maxScrolls; i += 1) {
      await page.mouse.wheel(0, 2400);
      await page.waitForTimeout(config.pauseMs);
      await clickShowMore(page);
      const count = await page.locator('a.base-card__full-link, a[href*="/jobs/view/"]').count();
      if (count <= previousCount) stagnant += 1;
      else stagnant = 0;
      previousCount = count;
      if (stagnant >= 2) break;
    }

    return await extractCards(page);
  } finally {
    await page.close();
  }
}

function normalizeJobs(cards, keyword, config) {
  const maxAgeMs = config.days * SECONDS_PER_DAY * 1000;
  const now = Date.now();
  const jobs = [];
  const seen = new Set();

  for (const card of cards) {
    const url = canonicalizeJobUrl(card.url);
    if (!url) continue;
    const postedAt = parseRelativePostedAt(card.postedText, card.postedDate);
    if (postedAt === undefined && !config.keepUnknownDates) continue;
    if (postedAt !== undefined && now - postedAt > maxAgeMs) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    jobs.push({
      source: 'linkedin',
      title: card.title,
      url,
      company: card.company || '',
      location: card.location || '',
      postedAt,
      description: `LinkedIn search keyword: ${keyword}`,
    });
  }

  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['entry-json']) throw new Error('missing --entry-json');
  const entry = JSON.parse(args['entry-json']);
  const raw = entry.linkedin || {};
  const config = {
    location: typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : 'Germany',
    days: intOr(raw.days, 10) || 10,
    workplaceType: typeof raw.workplace_type === 'string' ? raw.workplace_type : undefined,
    experience: typeof raw.experience === 'string' ? raw.experience : undefined,
    jobType: typeof raw.job_type === 'string' ? raw.job_type : undefined,
    maxScrolls: intOr(raw.max_scrolls, 6) || 6,
    pauseMs: intOr(raw.pause_ms, 1200) || 1200,
    keepUnknownDates: raw.keep_unknown_dates === true,
  };
  const keywords = normalizeKeywords(raw.keywords);
  if (keywords.length === 0) throw new Error('linkedin.keywords must be a non-empty list');

  const browser = await chromium.launch({ headless: true });
  try {
    const all = [];
    for (const keyword of keywords) {
      try {
        const cards = await scrapeKeyword(browser, config, keyword);
        all.push(...normalizeJobs(cards, keyword, config));
      } catch (err) {
        console.error(`[linkedin] ${keyword}: ${err.message}`);
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const job of all) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      deduped.push(job);
    }
    process.stdout.write(JSON.stringify(deduped));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[linkedin] fatal: ${err.message}`);
  process.exit(1);
});
