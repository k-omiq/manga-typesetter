// Filesystem-name helpers for the project library. Pure - no fs, no Tauri -
// so the naming rules can be tested on their own.

const MAX_SLUG = 60;

// Lowercase, punctuation collapsed to single hyphens. Letters and digits in any
// script survive, so a Japanese series name stays legible in Finder rather than
// becoming a row of hyphens.
export function slugify(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'untitled').slice(0, MAX_SLUG);
}

// Directory names must be unique within their parent. Identity lives in the
// JSON's `id`, so this only has to be stable enough to avoid a collision.
export function uniqueSlug(name, taken) {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Chapters sort naturally in a file browser when the number leads and is padded.
export function chapterSlug(number, title) {
  const n = String(number).padStart(3, '0');
  const t = title ? slugify(title) : '';
  return t ? `${n}-${t}` : n;
}

// Join path parts using forward slashes and normalize separators so paths
// passed to convertFileSrc or displayed in the UI work across platforms.
export function joinPath(...parts) {
  return parts
    .map((p, i) => {
      const s = String(p ?? '').replace(/\\/g, '/');
      if (i === 0) return s.replace(/\/+$/, '');
      return s.replace(/^\/+|\/+$/g, '');
    })
    .filter((p, i) => i === 0 || p.length > 0)
    .join('/');
}

