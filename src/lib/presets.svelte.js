// ===== Text Style Presets and Copy/Paste =====
// Presets persisted in localStorage 'mt.presets'.
// Module-level clipboard for style copy/paste across boxes.
import { normalizeStyle } from './data.js';
import {
  app,
  cloneStyle,
  fitGeom,
  autoFitBox,
  markUnsaved,
  page,
} from './store.svelte.js';
import { record } from './editor/history.svelte.js';

const KEY = 'mt.presets';

export const presets = $state({ list: [] });

// Bound by `loadPresets` when a test hands over a fake; otherwise the browser's
// own - the same seam `loadTags` uses, for the same reason: the migration of an
// old stored list has to be testable without a real localStorage underneath.
let store = null;
const storage = () => store ?? globalThis.localStorage ?? null;

function persist() {
  try {
    storage()?.setItem(KEY, JSON.stringify({ list: $state.snapshot(presets.list) }));
  } catch {
    /* ignore - preset persistence is best-effort */
  }
}

// Whatever comes off storage is untrusted: anything that does not parse is
// dropped wholesale, each entry's id and name are coerced to their types, and
// every style goes through `normalizeStyle` - which is also the whole of the
// legacy-schema migration (an `outline`/`outlineWidth`/`shadow`-era preset
// arrives as strokes/shadows like any other old style).
export function loadPresets(s) {
  store = s;
  let raw = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  presets.list = parsePresets(raw);
}

export function parsePresets(raw) {
  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(saved?.list)) return [];
    return saved.list.map((it) => ({
      id: String(it.id || ('pr_' + Math.random().toString(36).slice(2, 9))),
      name: String(it.name || '').trim(),
      style: normalizeStyle(it.style),
    }));
  } catch {
    /* ignore */
    return [];
  }
}

// Load persisted presets on module initialization.
loadPresets();

export function savePreset(name, style) {
  const cleanName = String(name ?? '').trim();
  // An empty or whitespace-only name cannot identify a preset in the UI.
  if (!cleanName) return null;
  const cleanStyle = normalizeStyle($state.snapshot(style));
  const target = cleanName.toLowerCase();
  const existingIdx = presets.list.findIndex(
    (p) => String(p.name ?? '').trim().toLowerCase() === target,
  );

  let item;
  if (existingIdx !== -1) {
    item = {
      id: presets.list[existingIdx].id,
      name: cleanName,
      style: cleanStyle,
    };
    presets.list[existingIdx] = item;
  } else {
    item = {
      id: 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: cleanName,
      style: cleanStyle,
    };
    presets.list.push(item);
  }
  persist();
  return item;
}

export function removePreset(id) {
  const next = presets.list.filter((p) => p.id !== id);
  if (next.length !== presets.list.length) {
    presets.list = next;
    persist();
  }
}

// Module-level clipboard for style copy/paste.
let clipboardStyle = null;

export function copyStyle(box) {
  if (!box?.style) return null;
  clipboardStyle = cloneStyle(box.style);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(JSON.stringify(clipboardStyle));
    }
  } catch {
    /* best effort */
  }
  return clipboardStyle;
}

// What a style PASTE declines to move: a box's transform belongs to where it
// sits on the page, not to how its text looks, and pasting a look should not
// tilt or mirror the target.
const EXCLUDED_KEYS = ['rotation', 'flipH', 'flipV'];

// What remembering the paste declines to carry into `lastStyle`, which is a
// SHORTER list than the one above - see `pasteStyle`.
const NOT_REMEMBERED = ['flipH', 'flipV'];

export function pasteStyle(box) {
  if (!box?.style || !clipboardStyle) return false;

  const before = cloneStyle(box.style);
  const geomBefore = fitGeom(box);

  // Assign every key of the clipboard style except rotation/flipH/flipV.
  for (const [k, v] of Object.entries(clipboardStyle)) {
    if (!EXCLUDED_KEYS.includes(k)) {
      box.style[k] = v && typeof v === 'object' ? structuredClone($state.snapshot(v)) : v;
    }
  }

  autoFitBox(box);
  markUnsaved();
  // Remember the pasted style so the next placed box carries the look, minus
  // the mirror flips. ROTATION IS CARRIED, and it is carried on purpose: the
  // user asked for the next placed box to follow the rotation of the box they
  // last worked on, and the value here is the TARGET box's own angle - the paste
  // did not touch it - so this is the same rule `selectBox` follows, not the
  // clipboard's tilt sneaking in through the side door. The flips stay out: a
  // mirrored box is a one-off, and inheriting it silently mirrors text nobody
  // asked to mirror. Normalised once more on the way in, so `lastStyle` keeps
  // being a whole style rather than one with holes.
  const remembered = cloneStyle(box.style);
  for (const k of NOT_REMEMBERED) delete remembered[k];
  app.lastStyle = cloneStyle(remembered);

  const geomAfter = fitGeom(box);
  const after = cloneStyle(box.style);

  record({
    t: 'style',
    pageId: page().id,
    boxId: box.id,
    before,
    after,
    geomBefore,
    geomAfter,
  });

  return true;
}
