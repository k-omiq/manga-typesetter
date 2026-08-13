// ===== Floating panel geometry =====
// The two right-hand editor panels are windows, not columns: the user drags,
// resizes and hides them, and the layout they leave behind is theirs across
// relaunches. This module owns nothing but that geometry — no DOM, no pointer
// handling — so the rules that are easy to get wrong (a window that shrank
// between sessions, a corrupt preference) are testable without a browser.

export const PANEL_IDS = ['options', 'queue'];

export const MIN_W = 220;
export const MIN_H = 160;
const DEF_W = 320;
const GAP = 16;
// However far a panel is dragged, this much of it stays inside the window. It
// is the difference between a layout the user can undo by hand and one that
// needs the reset button.
const KEEP_X = 120;
const KEEP_Y = 32;

const KEY = 'mt.panels';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function defaultGeometry(vw) {
  const x = Math.max(GAP, vw - DEF_W - GAP);
  return {
    options: { x, y: 52, w: DEF_W, h: 420, hidden: false, z: 1 },
    queue: { x, y: 488, w: DEF_W, h: 360, hidden: false, z: 2 },
  };
}

export function clampPanel(g, vw, vh) {
  const w = clamp(num(g.w) ?? DEF_W, MIN_W, Math.max(MIN_W, vw - GAP));
  const h = clamp(num(g.h) ?? MIN_H, MIN_H, Math.max(MIN_H, vh - GAP));
  return {
    x: clamp(num(g.x) ?? 0, 0, Math.max(0, vw - KEEP_X)),
    y: clamp(num(g.y) ?? 0, 0, Math.max(0, vh - KEEP_Y)),
    w,
    h,
    hidden: g.hidden === true,
    z: num(g.z) ?? 1,
  };
}

// A stored layout is user data of the least important kind. Anything that does
// not parse, or does not carry the right types, is replaced by the default for
// that panel alone — a broken half never costs the good half.
export function sanitize(stored, vw, vh) {
  const defs = defaultGeometry(vw);
  let raw = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const out = {};
  for (const id of PANEL_IDS) {
    const g = raw && typeof raw === 'object' ? raw[id] : null;
    const usable =
      g &&
      typeof g === 'object' &&
      num(g.x) !== null &&
      num(g.y) !== null &&
      num(g.w) !== null &&
      num(g.h) !== null &&
      typeof g.hidden === 'boolean';
    // The fallback goes through the clamp too. `defaultGeometry` lays the
    // panels out by width alone, so on a short window an unclamped default
    // parks the queue below the fold — the very thing this module exists to
    // prevent, and it would happen on the first run rather than in some odd
    // corner.
    out[id] = clampPanel(usable ? g : defs[id], vw, vh);
  }
  return out;
}

export const panels = $state(defaultGeometry(1440));

let store = null;
let saveT = null;

function assign(next) {
  for (const id of PANEL_IDS) Object.assign(panels[id], next[id]);
}

export function loadPanels(storage, vw, vh) {
  store = storage;
  let stored = null;
  try {
    stored = storage?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  assign(sanitize(stored, vw, vh));
}

export function serializePanels() {
  const out = {};
  for (const id of PANEL_IDS) out[id] = { ...panels[id] };
  return JSON.stringify(out);
}

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      store?.setItem(KEY, serializePanels());
    } catch {
      /* a layout preference is not worth a message */
    }
  }, 200);
}

// The mutators take whatever the caller hands them, minimum sizes aside: the
// module has no idea how big the window is, and inventing one here would fight
// the drag it is meant to record. Keeping a panel reachable is the caller's
// half of the bargain — call `clampAll` when the drag ends and whenever the
// window resizes.
export function movePanel(id, x, y) {
  panels[id].x = x;
  panels[id].y = y;
  save();
}

export function resizePanel(id, w, h) {
  panels[id].w = Math.max(MIN_W, w);
  panels[id].h = Math.max(MIN_H, h);
  save();
}

export function setHidden(id, hidden) {
  panels[id].hidden = hidden;
  save();
}

// Clicking a panel brings it forward. Two panels only, so the z values stay
// small and never need normalising.
// The test is against the *other* panels, not against the overall top: a
// layout where both carry the same z — which a stored blob written without
// them produces — would otherwise satisfy "I am already the top" forever, and
// the user could never bring either one forward again.
export function raisePanel(id) {
  const rest = PANEL_IDS.filter((p) => p !== id).map((p) => panels[p].z);
  if (!rest.length) return;
  const below = Math.max(...rest);
  if (panels[id].z > below) return;
  panels[id].z = below + 1;
  save();
}

export function clampAll(vw, vh) {
  for (const id of PANEL_IDS) Object.assign(panels[id], clampPanel(panels[id], vw, vh));
  save();
}

export function resetPanels(vw, vh) {
  assign(defaultGeometry(vw));
  clampAll(vw, vh);
}
