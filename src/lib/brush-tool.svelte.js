// ===== The brush tool's session state =====
//
// Which brush mode is armed, and the settings it draws with. Out here rather
// than inside a component for the same reason the mask tool's is: the rail arms
// it, the selected box draws with it and the panel edits it, and none of those
// three should grow a handle on the others.
//
// Session state, not saved. A letterer working through a page of sound effects
// wants the same brush for the next one; a letterer who quits and comes back is
// starting a different job. What a finished stroke needs in order to redraw is
// on the stroke itself - see `buildStroke`.
import { defaultBrushSettings } from './brush.js';
import { LIQUIFY_MODES } from './liquify.js';

// Draw lays ink down, erase takes whole strokes out, liquify bends the strokes
// that are already there. Three modes of ONE tool rather than three tools,
// because all three are the same gesture on the same surface, editing the same
// `style.ink` of the same selected box - which is also why the rail has one
// brush button and the panel has a mode control.
export const BRUSH_MODES = ['draw', 'erase', 'liquify'];

// The liquify tool's own numbers, and the range each is offered over.
//
// The radius is PAGE px - the unit strokes are stored in - so the tool covers
// the same ink at every zoom, and a letterer can say "a forty pixel radius" and
// mean it. 5 is about the smallest circle worth aiming, 200 covers a whole
// sound effect. Strength is the panel's 0..100, which is what the engine takes.
export const LIQUIFY_RADIUS_MIN = 5;
export const LIQUIFY_RADIUS_MAX = 200;
export const LIQUIFY_STRENGTH_MIN = 0;
export const LIQUIFY_STRENGTH_MAX = 100;
export const LIQUIFY_DEFAULTS = {
  // Push is the mode a letterer reaches for first: it is the one that does what
  // the hand does, and the other three are variations on standing still.
  liquifyMode: 'push',
  liquifyRadius: 40,
  liquifyStrength: 50,
};

// The tool's settings: a brush's own (what a stroke is drawn with) plus the
// liquify three. One object because it is one tool - the panel edits whichever
// of them the armed mode is about, and `buildStroke` names the keys it wants,
// so the liquify numbers never reach a stored stroke.
export function defaultBrushToolSettings() {
  return { ...defaultBrushSettings(), ...LIQUIFY_DEFAULTS };
}

export const brushTool = $state({ mode: null, settings: defaultBrushToolSettings() });

export function setBrushMode(mode) {
  if (mode !== null && !BRUSH_MODES.includes(mode)) return false;
  brushTool.mode = mode;
  return true;
}

export function setLiquifyMode(mode) {
  if (!LIQUIFY_MODES.includes(mode)) return false;
  brushTool.settings.liquifyMode = mode;
  return true;
}

const clamp = (v, lo, hi, d) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// What the liquify gesture starts with: the three settings, clamped to the
// ranges the panel offers and with anything unreadable back at its default.
// Read through here rather than off the state directly, so a hand-set number, a
// settings object that came from a brush the picker installed, or a slider that
// has not been touched all mean exactly one thing to the gesture.
export function liquifySettings(from = brushTool.settings) {
  const s = from && typeof from === 'object' ? from : {};
  return {
    mode: LIQUIFY_MODES.includes(s.liquifyMode) ? s.liquifyMode : LIQUIFY_DEFAULTS.liquifyMode,
    radius: clamp(s.liquifyRadius, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX, LIQUIFY_DEFAULTS.liquifyRadius),
    strength: clamp(
      s.liquifyStrength,
      LIQUIFY_STRENGTH_MIN,
      LIQUIFY_STRENGTH_MAX,
      LIQUIFY_DEFAULTS.liquifyStrength,
    ),
  };
}

export function brushArmed() {
  return brushTool.mode !== null;
}
