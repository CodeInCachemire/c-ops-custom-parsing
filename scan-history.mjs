#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';

export const SCAN_HISTORY_COLUMNS = ['url', 'seen_on', 'posted_on', 'source', 'company', 'title', 'location', 'status'];
export const SCAN_HISTORY_HEADER = `${SCAN_HISTORY_COLUMNS.join('\t')}\n`;

const LEGACY_SCAN_HISTORY_COLUMNS = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location'];
const COLUMN_ALIASES = new Map([
  ['first_seen', 'seen_on'],
  ['portal', 'source'],
]);

function canonicalColumnName(value) {
  const raw = String(value || '').trim().toLowerCase();
  return COLUMN_ALIASES.get(raw) || raw;
}

function normalizeCell(value) {
  return String(value ?? '').trim();
}

function looksLikeStatus(value) {
  return /^(added|skipped_|cooldown:)/.test(normalizeCell(value).toLowerCase());
}

function splitMergedHeaderLine(line) {
  const fields = String(line || '').split('\t');
  const patterns = [
    LEGACY_SCAN_HISTORY_COLUMNS.slice(0, 6),
    LEGACY_SCAN_HISTORY_COLUMNS,
    SCAN_HISTORY_COLUMNS,
  ];

  for (const pattern of patterns) {
    if (fields.length <= pattern.length) continue;
    const matches = pattern.every((name, idx) => canonicalColumnName(fields[idx]) === canonicalColumnName(name));
    if (!matches) continue;
    const next = fields[pattern.length] || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(next) || fields.length >= pattern.length + 5) {
      return [pattern.join('\t'), fields.slice(pattern.length).join('\t')];
    }
  }

  return [line];
}

function buildHeaderIndex(fields) {
  const index = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const canonical = canonicalColumnName(fields[i]);
    if (canonical) index.set(canonical, i);
  }

  if (!index.has('url') || !index.has('seen_on')) return null;
  return index;
}

function rowFromIndexedFields(fields, index) {
  return {
    url: normalizeCell(fields[index.get('url')]),
    seen_on: normalizeCell(fields[index.get('seen_on')]),
    posted_on: normalizeCell(index.has('posted_on') ? fields[index.get('posted_on')] : ''),
    source: normalizeCell(fields[index.get('source')]),
    company: normalizeCell(fields[index.get('company')]),
    title: normalizeCell(fields[index.get('title')]),
    location: normalizeCell(fields[index.get('location')]),
    status: normalizeCell(fields[index.get('status')]) || 'added',
  };
}

function rowFromLegacyFields(fields) {
  if (fields.length >= 8) {
    const [
      url = '',
      seen_on = '',
      posted_on = '',
      source = '',
      company = '',
      title = '',
      location = '',
      status = 'added',
    ] = fields;

    return {
      url: normalizeCell(url),
      seen_on: normalizeCell(seen_on),
      posted_on: normalizeCell(posted_on),
      source: normalizeCell(source),
      company: normalizeCell(company),
      title: normalizeCell(title),
      location: normalizeCell(location),
      status: normalizeCell(status) || 'added',
    };
  }

  if (fields.length >= 7 && looksLikeStatus(fields[6])) {
    const [
      url = '',
      seen_on = '',
      source = '',
      company = '',
      title = '',
      location = '',
      status = 'added',
    ] = fields;

    return {
      url: normalizeCell(url),
      seen_on: normalizeCell(seen_on),
      posted_on: '',
      source: normalizeCell(source),
      company: normalizeCell(company),
      title: normalizeCell(title),
      location: normalizeCell(location),
      status: normalizeCell(status) || 'added',
    };
  }

  const [
    url = '',
    seen_on = '',
    source = '',
    title = '',
    company = '',
    status = 'added',
    location = '',
  ] = fields;

  return {
    url: normalizeCell(url),
    seen_on: normalizeCell(seen_on),
    posted_on: '',
    source: normalizeCell(source),
    company: normalizeCell(company),
    title: normalizeCell(title),
    location: normalizeCell(location),
    status: normalizeCell(status) || 'added',
  };
}

export function parseScanHistoryRows(content) {
  let lines = String(content || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\r/g, ''))
    .filter(line => line.trim());

  if (lines.length === 0) return [];
  if (lines.length === 1) lines = splitMergedHeaderLine(lines[0]);

  const headerFields = lines[0].split('\t');
  const headerIndex = buildHeaderIndex(headerFields);
  const dataLines = headerIndex ? lines.slice(1) : lines;
  const rows = [];

  for (const line of dataLines) {
    const fields = line.split('\t');
    const row = headerIndex
      ? rowFromIndexedFields(fields, headerIndex)
      : rowFromLegacyFields(fields);
    if (!row.url || !row.seen_on) continue;
    if (!row.company && !row.title) continue;
    rows.push(row);
  }

  return rows;
}

export function serializeScanHistoryRows(rows) {
  const body = rows.map((row) => SCAN_HISTORY_COLUMNS.map((column) => normalizeCell(row?.[column])).join('\t'));
  return SCAN_HISTORY_HEADER + (body.length > 0 ? `${body.join('\n')}\n` : '');
}

export function ensureScanHistoryFile(path) {
  if (!existsSync(path)) {
    writeFileSync(path, SCAN_HISTORY_HEADER, 'utf-8');
    return [];
  }

  const raw = readFileSync(path, 'utf-8');
  const rows = parseScanHistoryRows(raw);
  const normalized = serializeScanHistoryRows(rows);
  if (raw !== normalized) {
    writeFileSync(path, normalized, 'utf-8');
  }
  return rows;
}
