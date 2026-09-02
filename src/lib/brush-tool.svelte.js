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

// Draw lays ink down and erase takes whole strokes out: two modes of ONE tool,
// the same gesture on the same board. Liquify is not here - it is an effect on
// the box's mesh (see liquify-tool.svelte.js), because it reshapes type as
// readily as ink.
export const BRUSH_MODES = ['draw', 'erase'];

// The tool's settings are a brush's own: what a stroke is drawn with.
export function defaultBrushToolSettings() {
  return defaultBrushSettings();
}

// The panel's tabs. Icon-only in the strip, so there is no label to truncate;
// `board` first because it is what the tool is for, and the default.
export const BRUSH_TABS = ['board', 'brush', 'shape', 'dynamics', 'correction', 'finish'];

// The finish a placed sound effect starts with: an outline around the whole of
// its ink, and shadows under it. In the shape of a box style's `strokes` and
// `shadows`, because that is what it becomes - `addInkBox` writes it onto the
// new box, and from then on the Inspector's Stroke and Shadow tabs own it.
// Beside the settings rather than in them: it is not a brush's own, a library
// brush never carries one, and picking a brush must not touch it.
export function defaultBrushFinish() {
  return { strokes: [], shadows: [] };
}

export const brushTool = $state({
  mode: null,
  settings: defaultBrushToolSettings(),
  finish: defaultBrushFinish(),
  // Which panel tab is showing. Session state, like the Inspector's own tab.
  tab: 'board',
  // The brush manager modal, and the brush whose editor it opens on. `null`
  // opens it on the plain list.
  manager: false,
  editBrushId: null,
  // What the last pointer sample said about itself: the device kind and the
  // pressure it reported. Shown in the panel so a letterer can see at once
  // whether the tablet's pressure is reaching the app - a pen that reads as
  // a mouse reports 0.5 flat, and every pressure brush then draws the same.
  pen: null,
});

export function setBrushTab(id) {
  if (!BRUSH_TABS.includes(id)) return false;
  brushTool.tab = id;
  return true;
}

// Open the manager, optionally straight onto one brush's editor - which is what
// a right-click on a tile asks for.
export function openBrushManager(editId = null) {
  brushTool.editBrushId = typeof editId === 'string' && editId ? editId : null;
  brushTool.manager = true;
}

export function closeBrushManager() {
  brushTool.manager = false;
  brushTool.editBrushId = null;
}

export function setBrushMode(mode) {
  if (mode !== null && !BRUSH_MODES.includes(mode)) return false;
  brushTool.mode = mode;
  return true;
}

export function brushArmed() {
  return brushTool.mode !== null;
}
