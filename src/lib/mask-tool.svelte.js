// ===== Which mask-drawing tool is armed =====
// Session state, not saved: the Inspector's Mask sub-tab arms a tool, the
// selected TextBox draws with it. It lives out here for the same reason the
// Inspector's tab does - two components far apart in the tree both need it,
// and neither should grow a handle on the other.
//
// `null` means no tool: the box moves and resizes as ever. Arming a tool
// hands the box's pointer to the mask overlay until it is disarmed (clicking
// the same tool again, or picking another box - the Inspector owns that).
export const MASK_TOOLS = ['brush', 'poly', 'ellipse'];

export const maskTool = $state({ id: null });

export function setMaskTool(id) {
  if (id !== null && !MASK_TOOLS.includes(id)) return false;
  // The same tool again disarms - a toggle, so the panel needs no "off" button.
  maskTool.id = maskTool.id === id ? null : id;
  return true;
}
