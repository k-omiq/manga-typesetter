// Human-readable counts and times for the library screens. Both the project
// card and the chapter table need both, and neither should be the one that
// owns them.
//
// Pure: `now` is a parameter, so the whole thing is testable without touching
// the clock, and nothing here reads the DOM or the filesystem.

// "1 page", "12 pages". Not decoration: "1 pages" is the kind of thing that
// makes an app look unfinished, and it appears on the first screen.
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Calendar-inexact on purpose. This is a glance-value under a project name, not
// an accounting figure — "3 months ago" only has to be true enough to orient.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const ago = (n, unit) => `${plural(n, unit)} ago`;

// Returns '' for anything it cannot read — a missing or malformed timestamp is
// a blank column, never the string "Invalid Date" or "NaN days ago".
export function relativeTime(when, now = Date.now()) {
  if (when == null || when === '') return '';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';

  // A timestamp in the future is a clock that moved, not a prediction.
  const d = now - t;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return ago(Math.floor(d / MINUTE), 'minute');
  if (d < DAY) return ago(Math.floor(d / HOUR), 'hour');
  if (d < 2 * DAY) return 'yesterday';
  if (d < WEEK) return ago(Math.floor(d / DAY), 'day');
  if (d < MONTH) return ago(Math.floor(d / WEEK), 'week');
  if (d < YEAR) return ago(Math.floor(d / MONTH), 'month');
  return ago(Math.floor(d / YEAR), 'year');
}
