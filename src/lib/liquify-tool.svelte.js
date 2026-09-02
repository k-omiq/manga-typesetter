// ===== The liquify tool's session state =====
//
// Liquify is an EFFECT, not a brush mode: it bends the selected box's mesh, and
// the mesh carries the type and the ink together (see warp.js), so one tool
// reshapes a hand-lettered sound effect and a set line the same way. Its
// controls sit under the Inspector's Effects tab; what a drag does is
// `liquify-mesh.js`. This module holds only the three numbers the panel edits.
//
// Session state, not saved, for the reason the brush tool's is: a letterer
// reshaping a page of effects wants the same tool for the next one.
import { LIQUIFY_MODES } from './liquify.js';

// The radius is PAGE px - the unit the mesh is stored in - so the tool covers
// the same ink at every zoom. 5 is about the smallest circle worth aiming, 300
// covers a whole sound effect. Strength is the panel's 0..100, which is what
// the engine takes.
export const LIQUIFY_RADIUS_MIN = 5;
export const LIQUIFY_RADIUS_MAX = 300;
export const LIQUIFY_STRENGTH_MIN = 0;
export const LIQUIFY_STRENGTH_MAX = 100;
export const LIQUIFY_DEFAULTS = {
  // Push is the mode a letterer reaches for first: it is the one that does what
  // the hand does, and the other three are variations on standing still.
  mode: 'push',
  radius: 40,
  strength: 50,
};

export const liquifyTool = $state({ ...LIQUIFY_DEFAULTS });

export function setLiquifyMode(mode) {
  if (!LIQUIFY_MODES.includes(mode)) return false;
  liquifyTool.mode = mode;
  return true;
}

const clamp = (v, lo, hi, d) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// What a gesture starts with: the three settings, clamped to the ranges the
// panel offers and with anything unreadable back at its default.
export function liquifySettings(from = liquifyTool) {
  const s = from && typeof from === 'object' ? from : {};
  return {
    mode: LIQUIFY_MODES.includes(s.mode) ? s.mode : LIQUIFY_DEFAULTS.mode,
    radius: clamp(s.radius, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX, LIQUIFY_DEFAULTS.radius),
    strength: clamp(
      s.strength,
      LIQUIFY_STRENGTH_MIN,
      LIQUIFY_STRENGTH_MAX,
      LIQUIFY_DEFAULTS.strength,
    ),
  };
}
