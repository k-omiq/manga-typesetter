// ===== The brush board =====
//
// Where strokes are drawn before they are anything to do with a page. The
// board is a fixed square of page px, session-only, with its own undo stack;
// the document is touched at exactly two points - `boardPlacement` when the
// letterer places the strokes as a new box, and `boardEditStrokes` when they
// apply an edit to a box the strokes came from - and both hand back plain data
// for the store to record.
//
// Strokes here are the same normalised shape `style.ink.strokes` holds, in the
// same unit, so a stroke moves from board to box by a translation and nothing
// else, and the board draws with the page's own painter.
import { strokeBounds, strokeHit, movePoint } from './brush.js';
import { applyLiquify, resampleStroke, defaultMaxSeg } from './liquify.js';
import { cutStroke, cutToIntersection, adjustWidth } from './stroke-edit.js';
import { normalizeInkStroke, normalizeFinish } from './data.js';

// The board's logical size, page px on both axes. A sound effect that needs to
// be larger than this is placed and then scaled through the Transform sub-tab;
// the board is a sheet of paper, not the page.
export const BOARD_SIZE = 1024;

// How many steps the board remembers. Bigger than the document's five because
// these are cheap - a stroke list, no bitmaps - and hand-lettering is a run of
// small tries.
export const BOARD_UNDO_MAX = 50;

// The margin a placed box keeps around its ink, page px each side, past the
// tip's own reach.
export const PLACE_PAD = 4;

export const board = $state({
  strokes: [],
  // Bumped on every change to the list; the canvas repaints off it.
  rev: 0,
  canUndo: false,
  canRedo: false,
  // Set while the strokes on the board came out of a box: which box, and the
  // translation that centred them here, so Apply can put them back where they
  // were.
  editing: null,
});

let undoStack = [];
let redoStack = [];
// The list as it stood when the current gesture began, or null outside one.
let pending = null;

function sync() {
  board.canUndo = undoStack.length > 0;
  board.canRedo = redoStack.length > 0;
}

function set(next) {
  board.strokes = next;
  board.rev++;
}

function pushUndo(before) {
  undoStack.push(before);
  if (undoStack.length > BOARD_UNDO_MAX) undoStack.shift();
  redoStack = [];
  sync();
}

function commit(next) {
  pushUndo(board.strokes);
  set(next);
}

// Every stroke moved by (dx, dy). New objects throughout - the board and a box
// must never share a stroke.
export function translateStrokes(strokes, dx, dy) {
  return (Array.isArray(strokes) ? strokes : []).map((k) => ({
    ...k,
    pts: k.pts.map((p) => movePoint(p, p[0] + dx, p[1] + dy)),
  }));
}

// The rectangle a list of strokes reaches, tip included, or null for no ink.
export function strokesBounds(strokes) {
  let out = null;
  for (const k of Array.isArray(strokes) ? strokes : []) {
    const b = strokeBounds(k);
    if (!b) continue;
    if (!out) out = { ...b };
    else {
      out.minX = Math.min(out.minX, b.minX);
      out.minY = Math.min(out.minY, b.minY);
      out.maxX = Math.max(out.maxX, b.maxX);
      out.maxY = Math.max(out.maxY, b.maxY);
    }
  }
  return out;
}

// ---- drawing ------------------------------------------------------------

// One finished stroke. Normalised at the door, so the board holds what a box
// will hold. False for a stroke that had nothing in it.
export function addBoardStroke(stroke) {
  const norm = normalizeInkStroke(stroke);
  if (!norm) return false;
  // A stroke arriving inside an erase bracket ends it first, as a
  // cancel: two gestures cannot own the list at once.
  if (pending) endBoardGesture(false);
  commit([...board.strokes, norm]);
  return true;
}

// ---- gestures that edit strokes already there --------------------------
//
// Erase changes the list many times over one drag, and a drag is one
// undo step. So a gesture opens with the list as it stands, mutates freely, and
// closes by either keeping the result (one step) or putting the opening list
// back (no step). A second `begin` while one is open ends the first as a
// cancel: a pointer that never came up did not finish.

export function beginBoardGesture() {
  if (pending) endBoardGesture(false);
  pending = board.strokes;
}

export function inBoardGesture() {
  return pending !== null;
}

// Returns whether the gesture changed anything.
export function endBoardGesture(keep = true) {
  const before = pending;
  pending = null;
  if (!before) return false;
  const changed = before !== board.strokes;
  if (!changed) return false;
  if (keep) pushUndo(before);
  else set(before);
  return true;
}

// The eraser, in one of three reaches (`ERASE_MODES` in brush-tool.svelte.js):
// `whole` takes out every stroke whose INK a circle of `radius` at (x, y)
// touches; `part` cuts the run of centreline under the circle out of each
// stroke, leaving the rest as separate strokes; `cross` cuts from the nearest
// crossing before that run to the nearest after it - CSP's vector eraser's
// three options. Returns how many strokes were touched.
export function eraseBoardAt(x, y, radius, how = 'whole') {
  const cur = board.strokes;
  let touched = 0;
  let next;
  if (how === 'part' || how === 'cross') {
    next = [];
    for (const k of cur) {
      const pieces = how === 'cross' ? cutToIntersection(k, cur, x, y, radius) : cutStroke(k, x, y, radius);
      if (pieces.length !== 1 || pieces[0] !== k) touched++;
      next.push(...pieces);
    }
  } else {
    next = cur.filter((k) => !strokeHit(k, x, y, radius));
    touched = cur.length - next.length;
  }
  if (!touched) return 0;
  replaceStrokes(next);
  return touched;
}

// CSP's Adjust line width: every point within `radius` of (x, y) has its
// width scaled by `factor`, eased to nothing at the rim. A stroke whose
// points are sparser than the circle is first subdivided, the way liquify
// subdivides, so the tool cannot fall between two points of a long straight
// segment; the subdivision sticks only when the pass changed something.
// Returns whether any stroke changed.
export function widthBoardAt(x, y, radius, factor) {
  return replaceStrokes(board.strokes.map((k) => {
    const dense = resampleStroke(k, defaultMaxSeg(radius));
    const out = adjustWidth(dense, x, y, radius, factor);
    return out === dense ? k : out;
  }));
}

// A list some strokes of which were replaced, as the next state - or nothing,
// when every stroke is the object it was. The vector edits all follow the
// identity contract (`applyLiquify`'s): an untouched stroke comes back as the
// same object, so a gesture that reached nothing records no step.
function replaceStrokes(next) {
  const cur = board.strokes;
  if (next.length === cur.length && next.every((k, i) => k === cur[i])) return false;
  if (!pending) commit(next);
  else set(next);
  return true;
}

// One application of the liquify field to every stroke on the board. `opts`
// are `applyLiquify`'s: mode, cx, cy, radius, strength, dx, dy, scale.
// Returns whether anything moved.
export function liquifyBoard(opts) {
  return replaceStrokes(applyLiquify(board.strokes, opts));
}

// ---- history ------------------------------------------------------------

export function undoBoard() {
  if (pending) endBoardGesture(false);
  const prev = undoStack.pop();
  if (!prev) return false;
  redoStack.push(board.strokes);
  set(prev);
  sync();
  return true;
}

export function redoBoard() {
  if (pending) endBoardGesture(false);
  const next = redoStack.pop();
  if (!next) return false;
  undoStack.push(board.strokes);
  set(next);
  sync();
  return true;
}

export function clearBoard() {
  if (pending) endBoardGesture(false);
  if (!board.strokes.length) return false;
  commit([]);
  return true;
}

// Everything back to blank, history included. After a place, and for tests.
export function resetBoard() {
  pending = null;
  undoStack = [];
  redoStack = [];
  board.editing = null;
  set([]);
  sync();
}

// ---- to and from a box --------------------------------------------------

// Put a box's strokes on the board, centred, and remember where they came
// from. Replaces whatever was on the board; the board's history starts over,
// because undoing past the load would be undoing into someone else's ink.
// `finish` is the box's own strokes and shadows: the board draws them around
// the ink while it is edited, and Apply leaves them where they are - they are
// the box's, edited in the Inspector.
export function loadBoardFromBox(pageId, boxId, strokes, finish = null) {
  const src = (Array.isArray(strokes) ? strokes : [])
    .map(normalizeInkStroke)
    .filter(Boolean);
  const b = strokesBounds(src);
  const dx = b ? Math.round(BOARD_SIZE / 2 - (b.minX + b.maxX) / 2) : 0;
  const dy = b ? Math.round(BOARD_SIZE / 2 - (b.minY + b.maxY) / 2) : 0;
  resetBoard();
  set(translateStrokes(src, dx, dy));
  board.editing = { pageId, boxId, dx, dy, finish: normalizeFinish(finish) };
}

export function cancelBoardEdit() {
  board.editing = null;
}

// The board's strokes back in the box's own frame, for Apply.
export function boardEditStrokes() {
  const e = board.editing;
  if (!e) return null;
  return translateStrokes(board.strokes, -e.dx, -e.dy);
}

// What a new box needs to hold the board's strokes: its size and the strokes
// in its own frame, the ink's top-left at (PLACE_PAD, PLACE_PAD). Null for an
// empty board.
export function boardPlacement(strokes = board.strokes) {
  const b = strokesBounds(strokes);
  if (!b) return null;
  const w = Math.max(1, Math.ceil(b.maxX - b.minX + PLACE_PAD * 2));
  const h = Math.max(1, Math.ceil(b.maxY - b.minY + PLACE_PAD * 2));
  return {
    w,
    h,
    strokes: translateStrokes(strokes, PLACE_PAD - b.minX, PLACE_PAD - b.minY),
  };
}
