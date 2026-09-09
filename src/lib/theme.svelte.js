// ===== Light / dark =====
// Three states, not two: 'system' follows the OS appearance and is what an app
// with no stored preference starts in; 'light' and 'dark' are an explicit choice
// and outrank the system for good, until the user picks 'system' again.
//
// This reverses the earlier decision, which was explicit-only with deliberately
// no prefers-color-scheme fallback so the app could never change appearance
// underfoot. In review that read as the app ignoring the machine it runs on -
// a desktop window that stays light while everything around it goes dark at
// sunset looks broken, not stable - and the two explicit modes are still there
// for anyone who wants it pinned. `mode` is what the user chose; `resolved` is
// what is actually on screen, which is what the Settings control needs to show
// both of at once.

// Mirrored, along with the light/dark/system resolution below, by the inline
// pre-paint script in index.html - which puts [data-theme] on the root before
// the first frame, because this module cannot run until the bundle has loaded
// and by then the wrong theme has already been painted. Change either the key
// or the rule and the other has to move with it, or the app flashes again.
const KEY = 'mt.theme';

export const theme = $state({ mode: 'system', resolved: 'light' });

// One query for the lifetime of the module. The listener on it is the whole of
// "no restart": a mid-session switch in System Settings re-runs `apply` and the
// app follows within the frame. Creating the query per call would leak a
// listener per theme change, and dropping the listener would mean the app only
// picked the system up at launch - which is the behaviour being replaced.
const mq =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function apply() {
  theme.resolved = theme.mode === 'system' ? (mq?.matches ? 'dark' : 'light') : theme.mode;
  // Always an explicit value on the root, even when following the system: the
  // stylesheet themes off [data-theme] alone, so nothing has to be duplicated
  // into a media query, and an explicit choice cannot be second-guessed by one.
  document.documentElement.dataset.theme = theme.resolved;
}

export function setTheme(mode) {
  theme.mode = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'system';
  apply();
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* ignore - a missing preference just means following the system next launch */
  }
}

export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  // Only 'light' and 'dark' are choices someone made; anything else - including
  // no stored value at all, and including a value written by an older build -
  // falls through to the system.
  setTheme(saved);
  // Fires only while the preference is 'system'; `apply` reads `theme.mode`
  // first, so an explicit choice ignores the event rather than needing the
  // listener removed and re-added around every setting change.
  mq?.addEventListener('change', apply);
}
