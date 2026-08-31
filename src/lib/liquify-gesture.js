// ===== One liquify drag, from pointer-down to its one history step =====
//
// The engine (`liquify.js`) is pure geometry: given a tool and a list of
// strokes it hands back a new list. This is the other half - what a GESTURE is:
// the snapshot it can go back to, the applications it makes while the pointer
// moves, and the single commit or cancel it is allowed however it ends.
//
// It lives here rather than in TextBox for the reason `warp-gizmo.js` exists:
// "exactly one history step per drag, and none for a drag that moved nothing"
// is then a claim a node test can make, and the component is left holding only
// pointers and markup.
//
// Every coordinate is BOX-LOCAL page px - the frame `ink.strokes` is stored in,
// and the frame `maskPoint` converts a pointer event into. The zoom and the
// box's rotation are the component's business.

import { applyLiquify } from './liquify.js';
import { liquifySettings } from './brush-tool.svelte.js';
import { cloneStyle, markUnsaved } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

// One frame at 60 Hz, in ms. The engine's `scale` is `dt / FRAME_MS` - see its
// header: without it the hold modes run at the pointer's event rate, so the
// same drag bloats twice as fast on a 120 Hz digitiser as on a 60 Hz one.
export const FRAME_MS = 16.7;

// The frame weight for a gap of `dt` ms. The engine clamps the result to 0..2
// itself; this only has to turn a missing or unreadable timestamp into one
// frame rather than into a NaN that would make the whole application a no-op.
export function frameScaleFor(dt) {
  const n = +dt;
  // No clock at all reads as one frame - the engine's own default. A gap of
  // zero or less is time that did not pass, which is a step of nothing: two
  // events sharing a timestamp must not each apply a whole frame's worth.
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n / FRAME_MS : 0;
}

// Whether two stroke lists are the same list, stroke for stroke, BY REFERENCE.
//
// This is the engine's own signal read back: `applyLiquify` always returns a
// new array, but a stroke it could not reach comes back as the same object. So
// element-wise identity is exactly "the tool did nothing this move" - which is
// what lets a drag that wanders off the ink cost no write, no repaint and, at
// the end, no history entry.
export function sameStrokes(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// One gesture, from the moment it starts to the one commit or cancel it is
// allowed - the shape `warpDragGesture` established, and for the same reason.
// Every ending goes through here: pointer-up, Escape, a pointer the browser
// cancelled, and the capture surface being unmounted mid-drag with no pointer
// event ever arriving (the brush is disarmed, another box is selected, the warp
// is switched on). `settled` is what makes "one history step per gesture" a
// property of the object rather than a discipline the call sites keep.
//
// The tool's settings are read ONCE, here: a drag is one application of one
// tool, and a panel that cannot be reached while the pointer is down should not
// be able to change the radius halfway through a stroke's deformation.
export function liquifyGesture(box, pageId, settings) {
  // The before-snapshot FIRST, before anything is written - the repo's own
  // rule, learned in the Inspector where a snapshot taken after the mutation
  // diffed as before === after and recorded nothing.
  const before = cloneStyle(box.style);
  const tool = liquifySettings(settings);
  let settled = false;
  let changed = false;

  return {
    tool,
    get settled() {
      return settled;
    },
    get changed() {
      return changed;
    },
    // One application of the tool, centred at (cx, cy). `dx`/`dy` are the
    // pointer's own delta since the last application, which is what push drags
    // the ink along; the other three modes hold still at the centre and take
    // their step from `scale` instead, so the delta is not theirs to read and
    // is zeroed here rather than left for the engine to ignore.
    //
    // Returns whether the ink moved.
    step({ cx, cy, dx = 0, dy = 0, scale = 1 } = {}) {
      if (settled) return false;
      const ink = box.style?.ink;
      const list = ink?.strokes;
      // Nothing drawn on this box: liquify reshapes ink, and there is none.
      // Not an error and not an edit - the drag simply has nothing to bend.
      if (!Array.isArray(list) || !list.length) return false;
      const push = tool.mode === 'push';
      const next = applyLiquify(list, {
        mode: tool.mode,
        cx,
        cy,
        radius: tool.radius,
        strength: tool.strength,
        dx: push ? dx : 0,
        dy: push ? dy : 0,
        scale,
      });
      if (sameStrokes(list, next)) return false;
      // Written into the LIVE style, because the box is drawn from it: the ink
      // canvas repaints off `style.ink`, and a draft held to one side would be
      // a second copy of the strokes to keep in step. Deliberately silent - no
      // `markUnsaved`, no record - a drag in progress is not an edit until the
      // pointer comes up, which is what the warp drag does too.
      ink.strokes = next;
      changed = true;
      return true;
    },
    // Pointer-up: ONE history step for the whole drag, or none at all. None is
    // the ordinary case for a click that hit no ink, and for a drag whose
    // circle never reached a stroke.
    commit() {
      if (settled) return false;
      settled = true;
      if (!changed) return false;
      markUnsaved();
      record({ t: 'style', pageId, boxId: box.id, before, after: cloneStyle(box.style) });
      return true;
    },
    // Escape, a cancelled pointer, or a teardown. The whole style goes back,
    // not the ink alone: `before` is a clone of the entire style, which is the
    // same thing the `style` history kind restores, so cancel and undo can
    // never mean two different things.
    cancel() {
      if (settled) return false;
      settled = true;
      if (!changed) return false;
      box.style = cloneStyle(before);
      return true;
    },
  };
}
