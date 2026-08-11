// ===== Light / dark =====
// The preference is explicit and persisted; there is deliberately no
// prefers-color-scheme fallback, so the app never changes appearance underfoot.

const KEY = 'mt.theme';

export const theme = $state({ mode: 'light' });

function apply(mode) {
  document.documentElement.dataset.theme = mode;
}

export function setTheme(mode) {
  theme.mode = mode === 'dark' ? 'dark' : 'light';
  apply(theme.mode);
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* ignore — a missing preference just means the default next launch */
  }
}

export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  setTheme(saved === 'dark' ? 'dark' : 'light');
}
