import { describe, it, expect } from 'vitest';
import { relativeTime, plural, modKey } from './format.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const at = (ms) => relativeTime(new Date(NOW - ms).toISOString(), NOW);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(0, 'page')).toBe('0 pages');
    expect(plural(1, 'page')).toBe('1 page');
    expect(plural(2, 'page')).toBe('2 pages');
  });

  it('takes an explicit plural for words that need one', () => {
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('relativeTime', () => {
  it('collapses anything under a minute to "just now"', () => {
    expect(at(0)).toBe('just now');
    expect(at(59 * SECOND)).toBe('just now');
  });

  it('counts minutes, hours and days', () => {
    expect(at(MINUTE)).toBe('1 minute ago');
    expect(at(5 * MINUTE)).toBe('5 minutes ago');
    expect(at(HOUR)).toBe('1 hour ago');
    expect(at(23 * HOUR)).toBe('23 hours ago');
    expect(at(3 * DAY)).toBe('3 days ago');
  });

  it('says "yesterday" for the first day back', () => {
    expect(at(DAY)).toBe('yesterday');
    expect(at(47 * HOUR)).toBe('yesterday');
    expect(at(2 * DAY)).toBe('2 days ago');
  });

  it('steps up through weeks, months and years', () => {
    expect(at(7 * DAY)).toBe('1 week ago');
    expect(at(21 * DAY)).toBe('3 weeks ago');
    expect(at(30 * DAY)).toBe('1 month ago');
    expect(at(200 * DAY)).toBe('6 months ago');
    expect(at(400 * DAY)).toBe('1 year ago');
    expect(at(1000 * DAY)).toBe('2 years ago');
  });

  it('singularises exactly one of each unit', () => {
    expect(at(MINUTE)).toBe('1 minute ago');
    expect(at(HOUR)).toBe('1 hour ago');
    expect(at(7 * DAY)).toBe('1 week ago');
    expect(at(30 * DAY)).toBe('1 month ago');
    expect(at(365 * DAY)).toBe('1 year ago');
  });

  it('treats a future timestamp as now rather than counting backwards', () => {
    expect(relativeTime(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('just now');
  });

  it('returns nothing it would have to guess at', () => {
    expect(relativeTime(undefined, NOW)).toBe('');
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime('', NOW)).toBe('');
    expect(relativeTime('not a date', NOW)).toBe('');
  });

  it('accepts an epoch millisecond value as well as an ISO string', () => {
    expect(relativeTime(NOW - 2 * HOUR, NOW)).toBe('2 hours ago');
  });
});

describe('modKey', () => {
  it('returns a string for the modifier key symbol or prefix', () => {
    const key = modKey();
    expect(key === '⌘' || key === 'Ctrl+').toBe(true);
  });
});

