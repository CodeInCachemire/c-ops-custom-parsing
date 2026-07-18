#!/usr/bin/env node

import { chromium } from 'playwright';

const COUNTRY_SEO = {
  germany: { slug: 'germany', inCode: 'IN96' },
  deutschland: { slug: 'germany', inCode: 'IN96' },
};
const PAGE_TIMEOUT_MS = 30_000;

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

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'jobs';
}

function buildUrls({ keyword, location, days, jobType }) {
  const urls = [];
  const params = new URLSearchParams({
    applicationType: '0',
    cityId: '-1',
    companyId: '-1',
    employerSizes: '0',
    fromAge: String(days),
    includeNoSalaryJobs: 'true',
    industryId: '-1',
    jobType,
    locKeyword: location,
    minRating: '0.0',
    minSalary: '0',
    radius: '-1',
    remoteWorkType: '0',
    'sc.keyword': keyword,
    seniorityType: 'all',
    sgocId: '-1',
  });
  urls.push(`https://www.glassdoor.com/Job/jobs.htm?${params.toString()}`);

  const country = COUNTRY_SEO[String(location || '').trim().toLowerCase()];
  if (country) {
    const keywordSlug = slugify(keyword);
    const locEnd = country.slug.length;
    const keywordStart = locEnd + 1;
    const keywordEnd = keywordStart + keywordSlug.length;
    const seoParams = new URLSearchParams({
      fromAge: String(days),
      includeNoSalaryJobs: 'true',
      jobType,
    });
    urls.push(
      `https://www.glassdoor.com/Job/${country.slug}-${keywordSlug}-jobs-SRCH_IL.0%2C${locEnd}_${country.inCode}_KO${keywordStart}%2C${keywordEnd}.htm?${seoParams.toString()}`,
    );
  }

  return [...new Set(urls)];
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCompanyName(value) {
  return normalizeSpace(value).replace(/\s*\d+[.,]\d+\s*$/, '');
}

function normalizeGlassdoorUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, 'https://www.glassdoor.com');
    const keep = ['jl', 'jobListingId', 'jobId'];
    const next = new URL(`${parsed.origin}${parsed.pathname}`);
    for (const key of keep) {
      const value = parsed.searchParams.get(key);
      if (value) next.searchParams.set(key, value);
    }
    return next.toString();
  } catch {
    return '';
  }
}

function parseAgeToMs(text) {
  const raw = normalizeSpace(text).toLowerCase();
  if (!raw) return undefined;
  const now = Date.now();
  if (['just posted', 'today', 'heute'].includes(raw)) return now;

  const patterns = [
    [/(\d+)\s*h\b/, 60 * 60 * 1000],
    [/(\d+)\s*hours?\b/, 60 * 60 * 1000],
    [/(\d+)\s*d\+?\b/, 24 * 60 * 60 * 1000],
    [/(\d+)\s*t\+?\b/, 24 * 60 * 60 * 1000],
    [/(\d+)\s*days?\b/, 24 * 60 * 60 * 1000],
    [/vor\s+(\d+)\s+stunden?/, 60 * 60 * 1000],
    [/vor\s+(\d+)\s+tagen?/, 24 * 60 * 60 * 1000],
  ];
  for (const [pattern, unitMs] of patterns) {
    const match = raw.match(pattern);
    if (match) return now - Number(match[1]) * unitMs;
  }
  if (raw === '24h') return now - 24 * 60 * 60 * 1000;
  return undefined;
}

async function clickCookies(page) {
  for (const label of ['Accept Cookies', 'Accept', 'Select Cookies', 'Alle Cookies akzeptieren', 'Alle akzeptieren']) {
    try {
      const button = page.getByRole('button', { name: new RegExp(label, 'i') });
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
    'button[data-test*="load-more" i]',
    'button:has-text("Show more jobs")',
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
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const cards = [...document.querySelectorAll('li[data-test="jobListing"], li.JobsList_jobListItem__wjTHv')];
    return cards
      .map((card) => ({
        title: normalize(card.querySelector('a[data-test="job-title"], a.JobCard_jobTitle__GLyJ1')?.textContent),
        url: card.querySelector('a[data-test="job-title"], a.JobCard_jobTitle__GLyJ1')?.href || '',
        company: normalize(
          card.querySelector('.EmployerProfile_compactEmployerName__9MGcV, .EmployerProfile_employerNameContainer__ptolz, [id^="job-employer-"]')?.textContent
        ),
        location: normalize(card.querySelector('.JobCard_location__Ds1fM, [data-test="emp-location"]')?.textContent),
        postedText: normalize(card.querySelector('.JobCard_listingAge__jJsuc, [data-test="job-age"]')?.textContent),
        salaryRaw: normalize(card.querySelector('.JobCard_salaryEstimate__QpbTW, [data-test="detailSalary"]')?.textContent),
        description: normalize(card.querySelector('.JobCard_jobDescriptionSnippet__l1tnl, [data-test="descSnippet"]')?.textContent),
      }))
      .filter((row) => row.title.length >= 3);
  });
}

async function scrapeUrl(browser, url, config) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(config.pauseMs);
    await clickCookies(page);
    await page.waitForTimeout(1200);
    try {
      await page.waitForSelector('li[data-test="jobListing"], li.JobsList_jobListItem__wjTHv', { timeout: 12_000 });
    } catch {}
    const title = await page.title();
    const bodyText = normalizeSpace(await page.locator('body').innerText());
    if (/humans only|just a moment/i.test(title) || /humans only|troubleshooting tips/i.test(bodyText)) {
      throw new Error(`blocked by anti-bot challenge: ${url}`);
    }
    return await extractCards(page);
  } finally {
    await page.close();
  }
}

function normalizeJobs(cards, config) {
  const maxAgeMs = config.days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const jobs = [];
  const seen = new Set();
  for (const card of cards) {
    const url = normalizeGlassdoorUrl(card.url);
    if (!url || seen.has(url)) continue;
    const postedAt = parseAgeToMs(card.postedText);
    if (postedAt === undefined && !config.keepUnknownDates) continue;
    if (postedAt !== undefined && now - postedAt > maxAgeMs) continue;
    seen.add(url);
    jobs.push({
      source: 'glassdoor',
      title: card.title,
      url,
      company: normalizeCompanyName(card.company || ''),
      location: card.location || '',
      postedAt,
      description: card.description || '',
      salaryRaw: card.salaryRaw || '',
    });
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['entry-json']) throw new Error('missing --entry-json');
  const entry = JSON.parse(args['entry-json']);
  const raw = entry.glassdoor || {};
  const config = {
    location: typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : 'Germany',
    days: intOr(raw.days, 10) || 10,
    jobType: typeof raw.job_type === 'string' && raw.job_type.trim() ? raw.job_type.trim() : 'fulltime',
    maxClicks: intOr(raw.max_clicks, 5) || 5,
    pauseMs: intOr(raw.pause_ms, 1400) || 1400,
    keepUnknownDates: raw.keep_unknown_dates === true,
  };
  const keywords = normalizeKeywords(raw.keywords);
  if (keywords.length === 0) throw new Error('glassdoor.keywords must be a non-empty list');

  const browser = await chromium.launch({ headless: true });
  try {
    const all = [];
    let blocked = false;
    for (const keyword of keywords) {
      if (blocked) break;
      for (const url of buildUrls({ keyword, ...config })) {
        try {
          const cards = await scrapeUrl(browser, url, config);
          all.push(...normalizeJobs(cards, config));
        } catch (err) {
          console.error(`[glassdoor] ${keyword}: ${err.message}`);
          if (/anti-bot challenge/i.test(err.message)) {
            blocked = true;
            break;
          }
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
    process.stdout.write(JSON.stringify(deduped));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[glassdoor] fatal: ${err.message}`);
  process.exit(1);
});
