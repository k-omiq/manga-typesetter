// ===== Per-field typing undo =====
//
// ⌘Z inside a text field is not something the web view does on its own. On
// macOS there is no standard key binding for it: the key equivalent lives on
// the Edit menu's predefined Undo item, which sends `undo:` down the responder
// chain, and that action is the only route into WebKit's editor. That item is
// exactly what `patchDefaultMenu` deletes so that ⌘Z can reach the DOM at all
// (App.svelte explains why it had to go), so once it was gone nothing was left
// to undo typing — the "falls through to WebKit's own field undo" the removal
// was betting on does not exist.
//
// The Inspector's textarea could not have relied on it anyway: it renders
// `value` from the store, and a programmatic value assignment throws WebKit's
// undo stack away, so its native stack was never more than one keystroke deep.
//
// So each field keeps its own. Whole strings, one per step, with typing
// gathered into runs the way an editor does it: a run ends on a pause, on a
// whitespace boundary, when the next edit is not adjacent to the last one, or
// when something atomic (a paste, a cut, a drop, an autocorrect) lands in the
// middle of it.
//
// Deliberately not `$state`: this is bookkeeping for the component that owns
// the field, and nothing renders from it.

// Long enough that a slow typist's sentence is still one run, short enough that
// coming back to a field after a thought does not merge into the last one.
export const COALESCE_MS = 600;
// Field text is a handful of words, so a step costs bytes rather than the
// document snapshots the editor history deliberately caps at five.
export const MAX_FIELD_STEPS = 50;

// Input types that describe a source other than the keyboard. Each is one edit
// of its own and must never be swallowed into the typing run it interrupts —
// undoing a paste has to give back exactly what was there before it, not the
// half-sentence that was being typed around it.
const ATOMIC_INPUT = /^(insertFrom|deleteBy|insertReplacement|history)/;
export const isAtomicInput = (inputType) => ATOMIC_INPUT.test(inputType ?? '');

export function createFieldUndo(value = '') {
  const u = { stack: [value], i: 0, at: 0, kind: null, tip: value.length, wall: true };
  return u;
}

// The field is showing something this stack did not put there — another box
// selected, an edit made on the canvas, the editor history rewinding the box's
// text. Undoing back through a run that no longer describes the field's content
// would restore text from a different box, so the stack starts again.
export function resyncField(u, value) {
  u.stack = [value];
  u.i = 0;
  u.at = 0;
  u.kind = null;
  u.tip = value.length;
  u.wall = true;
}

// The one contiguous span in which two strings differ: common prefix in, common
// suffix in, whatever is left is the edit. Enough to tell an insert from a
// delete and to say where it happened, which is all the coalescing needs.
export function diffText(prev, next) {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let a = 0;
  while (a < max && prev[a] === next[a]) a++;
  let b = 0;
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  return {
    at: a,
    removed: prev.slice(a, prev.length - b),
    inserted: next.slice(a, next.length - b),
  };
}

// Where the caret belongs after stepping from one value to another. Derived
// from the two strings rather than remembered per step, because that is the one
// measurement both surfaces can make: a contenteditable's node/offset pairs do
// not map onto `innerText` positions across a hard line break, and the point
// where the text diverges is where the user is looking anyway.
export function caretAfter(from, to) {
  const d = diffText(from, to);
  return d ? d.at + d.inserted.length : to.length;
}

// Returns true when the edit opened a new step, false when it joined the run
// already on top (or changed nothing).
//
// Named for the field rather than `recordEdit`, which is what it was: the store
// exports a `recordEdit` of its own — the fan-out to the editor's undo history —
// and the two have nothing to do with each other beyond the word. Both this and
// the store are imported by Inspector.svelte and TextBox.svelte already, so the
// collision was one import line away in either file, and it would have been a
// silent one: same arity at the call site, entirely different meaning. This is
// the half that moved because every one of its call sites is in those two
// components, while the store's name is reached from across the app.
export function recordFieldEdit(u, value, { now = Date.now(), atomic = false } = {}) {
  const cur = u.stack[u.i];
  if (value === cur) return false;
  const d = diffText(cur, value);
  const kind = d.inserted.length ? 'insert' : 'delete';
  // A run is a continuous stroke, so the next edit has to touch where the last
  // one ended. Backspace walks the tip backwards and forward-delete leaves it
  // where it is, hence the two ways a delete can qualify. A caret moved
  // elsewhere and typed into fails both and starts its own step, which is what
  // stops one ⌘Z from wiping two unrelated corrections.
  const adjacent =
    kind === 'insert'
      ? d.at === u.tip
      : d.at + d.removed.length === u.tip || d.at === u.tip;
  const coalesce =
    !atomic && !u.wall && u.i > 0 && u.kind === kind && adjacent && now - u.at <= COALESCE_MS;
  if (coalesce) {
    u.stack[u.i] = value;
  } else {
    // A fresh edit forfeits the redo tail, the same bargain every undo stack
    // makes: the branch the user walked back out of is no longer reachable.
    u.stack.length = u.i + 1;
    u.stack.push(value);
    u.i = u.stack.length - 1;
    if (u.stack.length > MAX_FIELD_STEPS) {
      u.stack.shift();
      u.i--;
    }
  }
  u.at = now;
  u.kind = kind;
  u.tip = d.at + d.inserted.length;
  // Whitespace closes the run it is part of rather than starting one, so ⌘Z
  // gives back "hello " and then "" rather than " " and then "hello".
  u.wall = atomic || /\s/.test(d.inserted) || /\s/.test(d.removed);
  return !coalesce;
}

// Both return the value to put in the field, or null when there is nowhere to
// go. Null rather than false because "" is a perfectly good step.
export function undoField(u) {
  if (u.i === 0) return null;
  u.i--;
  return land(u);
}

export function redoField(u) {
  if (u.i >= u.stack.length - 1) return null;
  u.i++;
  return land(u);
}

// A step across the stack closes the run behind it: typing straight after an
// undo has to open a step of its own, or the very thing that was just undone
// would be rewritten into the entry the user is standing on.
function land(u) {
  u.kind = null;
  u.wall = true;
  u.tip = u.stack[u.i].length;
  return u.stack[u.i];
}
