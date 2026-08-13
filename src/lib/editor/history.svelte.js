// ===== Bounded undo/redo =====
// Five steps, per page, as command records rather than document snapshots: an
// entry is plain data describing one edit and its inverse, so it costs tens of
// bytes and serialises to JSON without ceremony. Only the page on screen keeps
// its stack in memory; every other page's lives in the chapter's history file.
import {
  page,
  pageById,
  markUnsaved,
  toast,
  selectBox,
  setRecorder,
  cloneStyle,
} from '../store.svelte.js';

export const MAX_STEPS = 5;

export const history = $state({ canUndo: false, canRedo: false, pageId: null });

let undoStack = [];
let redoStack = [];
// While an entry is being applied the store's mutations must not be recorded —
// an undo is not an edit.
let applying = false;

function sync() {
  history.canUndo = undoStack.length > 0;
  history.canRedo = redoStack.length > 0;
}

const boxOf = (entry) => {
  const p = pageById(entry.pageId);
  if (!p) return null;
  return p.boxes.find((b) => b.id === entry.boxId) ?? null;
};

// Why a box can be missing decides what the user is told, so both cases are
// asked about rather than reported as one.
const missing = (e) => new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');

// A place advances the queue and a delete hands the line back, so both records
// carry the queue's position on either side of the edit. A record written
// before the field existed simply leaves the queue alone.
const setActive = (p, n) => {
  if (n !== undefined) p.activeLineN = n;
};

// Geometry entries carry only the fields that changed. `size` lives on the
// style rather than the box, and a resize changes it alongside w/h.
const setFields = (b, from) => {
  for (const k of Object.keys(from)) {
    if (k === 'size') b.style.size = from.size;
    else b[k] = from[k];
  }
};

// Every command type, and how to walk it in each direction. `apply` throws a
// plain Error when the document no longer matches; the caller turns that into
// a message and drops the entry.
const KINDS = {
  place: {
    label: 'that placement',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
        setActive(p, e.activeBefore);
      } else {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
        setActive(p, e.activeAfter);
      }
    },
  },
  delete: {
    label: 'that deletion',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        // `index` is what puts the box back where it sat in the stacking order
        // rather than on top of everything drawn since.
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
        setActive(p, e.activeBefore);
      } else {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
        setActive(p, e.activeAfter);
      }
    },
  },
  move: {
    label: 'that move',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      setFields(b, dir === 'undo' ? e.before : e.after);
    },
  },
  resize: {
    label: 'that resize',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      setFields(b, dir === 'undo' ? e.before : e.after);
    },
  },
  style: {
    label: 'that style change',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      b.style = cloneStyle(dir === 'undo' ? e.before : e.after);
    },
  },
  text: {
    label: 'that text edit',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw missing(e);
      b.text = dir === 'undo' ? e.before : e.after;
    },
  },
  bulk: {
    label: 'that bulk style',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      let hit = 0;
      for (const item of e.items) {
        const b = p.boxes.find((x) => x.id === item.boxId);
        if (!b) continue;
        b.style = cloneStyle(dir === 'undo' ? item.before : item.after);
        hit++;
      }
      // A bulk that touched five boxes is still worth undoing when one has
      // since been deleted; it is only a failure when none of them are left.
      if (!hit) throw new Error('those text boxes are gone');
    },
  },
};

// The history file registers itself here so a new entry can schedule its own
// write. Without it the live page's stack would only reach disk on a page
// switch, and an edit made and then abandoned would be lost on quit.
let sink = null;
export function setHistorySink(fn) {
  sink = fn;
}

export function record(entry) {
  if (applying) return;
  if (!KINDS[entry?.t]) return;
  // Detached at the door rather than trusting every mutation site: a record
  // that still points at something live would be rewritten by the next edit to
  // that box, and a reactive proxy would not survive the trip to disk as JSON.
  // Both halves earn their place — `snapshot` unwraps the proxies, and it hands
  // plain objects straight back, which is exactly the aliasing case.
  const flat = structuredClone($state.snapshot(entry));
  undoStack.push(flat);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack = [];
  history.pageId = flat.pageId;
  sync();
  sink?.(flat.pageId);
}

function step(from, to, dir) {
  const entry = from.pop();
  if (!entry) return false;
  try {
    applying = true;
    KINDS[entry.t].apply(entry, dir);
  } catch (err) {
    // Replay and fail loudly: the entry is dropped, the user is told what it
    // was, and the next press carries on to whatever is still valid beneath it.
    toast(`Could not ${dir} ${KINDS[entry.t].label} — ${err.message}`);
    sync();
    return false;
  } finally {
    applying = false;
  }
  to.push(entry);
  // Show the user what just changed, but only when it is still there to show.
  if (entry.boxId && pageById(entry.pageId)?.boxes.some((b) => b.id === entry.boxId)) {
    selectBox(entry.boxId);
  }
  markUnsaved();
  sync();
  return true;
}

export const undo = () => step(undoStack, redoStack, 'undo');
export const redo = () => step(redoStack, undoStack, 'redo');

// A copy of the live stack, for a write that must not disturb it.
export function peekStack() {
  return { undo: undoStack.slice(), redo: redoStack.slice() };
}

// The live page hands its stack over on a page switch and takes another back.
export function takeStack() {
  const out = { undo: undoStack, redo: redoStack };
  undoStack = [];
  redoStack = [];
  sync();
  return out;
}

// Whatever comes back off disk is untrusted: a record of a kind this build no
// longer knows how to apply is dropped rather than kept to fail on a press.
export function loadStack(pageId, stack) {
  undoStack = Array.isArray(stack?.undo)
    ? stack.undo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS)
    : [];
  redoStack = Array.isArray(stack?.redo)
    ? stack.redo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS)
    : [];
  history.pageId = pageId;
  sync();
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
  history.pageId = null;
  sync();
}

// Registered once, at boot. Idempotent.
export function initHistory() {
  setRecorder(record);
}
