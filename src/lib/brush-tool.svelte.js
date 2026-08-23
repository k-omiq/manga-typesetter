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

export const BRUSH_MODES = ['draw', 'erase'];

export const brushTool = $state({ mode: null, settings: defaultBrushSettings() });

export function setBrushMode(mode) {
  if (mode !== null && !BRUSH_MODES.includes(mode)) return false;
  brushTool.mode = mode;
  return true;
}

export function brushArmed() {
  return brushTool.mode !== null;
}
