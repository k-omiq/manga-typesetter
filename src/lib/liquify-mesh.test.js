import { describe, it, expect, beforeEach } from 'vitest';
import {
  liquifyMesh,
  liquifyGrid,
  liquifyMeshGesture,
  frameScaleFor,
  FRAME_MS,
} from './liquify-mesh.js';
import { identityMesh } from './warp.js';
import { defaultStyle, WARP_MAX_GRID, WARP_MIN_GRID } from './data.js';
import { loadProjectPages, byId } from './store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack } from './editor/history.svelte.js';

describe('frameScaleFor', () => {
  it('is the engine’s contract: dt / one 60 Hz frame, no clock is one frame, no time is no step', () => {
    expect(frameScaleFor(FRAME_MS)).toBeCloseTo(1, 10);
    expect(frameScaleFor(FRAME_MS * 2)).toBeCloseTo(2, 10);
    expect(frameScaleFor(undefined)).toBe(1);
    expect(frameScaleFor(NaN)).toBe(1);
    expect(frameScaleFor(0)).toBe(0);
    expect(frameScaleFor(-8)).toBe(0);
  });
});

describe('liquifyGrid', () => {
  it('spaces cells by the tool, never finer than the floor and never past the cap', () => {
    // 200 px across, radius 40: cells of 24 px -> 9 columns.
    expect(liquifyGrid(200, 100, 40)).toEqual({ cols: 9, rows: 5 });
    // A tiny tool bottoms out at the 10 px cell.
    expect(liquifyGrid(200, 100, 5)).toEqual({ cols: 20, rows: 10 });
    // A huge box hits the cap.
    expect(liquifyGrid(5000, 5000, 5)).toEqual({ cols: WARP_MAX_GRID, rows: WARP_MAX_GRID });
    // Nothing goes below one cell.
    expect(liquifyGrid(0, 0, 40)).toEqual({ cols: WARP_MIN_GRID, rows: WARP_MIN_GRID });
  });

  it('never coarsens a mesh the letterer already has', () => {
    expect(liquifyGrid(200, 100, 300, { cols: 6, rows: 7 })).toEqual({ cols: 6, rows: 7 });
    expect(liquifyGrid(200, 100, 40, { cols: 2, rows: 7 })).toEqual({ cols: 9, rows: 7 });
  });
});

describe('liquifyMesh', () => {
  const pts = () => identityMesh(4, 2, 200, 100);
  const push = (cx, cy, dx, dy, radius = 40) => ({ mode: 'push', cx, cy, radius, strength: 100, dx, dy, scale: 1 });

  it('moves the points under the tool and hands back the same array when none were', () => {
    const src = pts();
    const out = liquifyMesh(src, push(100, 50, 0, 12));
    expect(out).not.toBe(src);
    // The centre point took the whole delta; the corners are untouched and are
    // the SAME point objects.
    const centre = out[1 * 5 + 2];
    expect(centre).toEqual([100, 62]);
    expect(out[0]).toBe(src[0]);
    expect(out[out.length - 1]).toBe(src[src.length - 1]);
    const far = liquifyMesh(src, push(1000, 1000, 5, 5));
    expect(far).toBe(src);
    expect(liquifyMesh(src, push(100, 50, 0, 0))).toBe(src);
  });

  it('accepts nothing at all', () => {
    expect(liquifyMesh(null, push(0, 0, 1, 1))).toEqual([]);
    expect(liquifyMesh([[1, 2]], null)).toHaveLength(1);
  });
});

const W = 200;
const H = 100;
const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [
      { id: 'b1', lineN: null, text: 'SFX', x: 40, y: 60, w: W, h: H, style: { ...defaultStyle(), autoHeight: false } },
    ],
  },
];
const tool = (over = {}) => ({ mode: 'push', radius: 40, strength: 100, ...over });

function drag(box, t, moves, { cancel = false } = {}) {
  const g = liquifyMeshGesture(box, 1, t);
  let [lx, ly] = moves[0];
  for (const [x, y] of moves.slice(1)) {
    g.step({ cx: x, cy: y, dx: x - lx, dy: y - ly, scale: 1 });
    lx = x;
    ly = y;
  }
  return cancel ? g.cancel() : g.commit();
}

describe('a liquify drag against the document', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
  });

  it('switches the mesh on at the tool’s density, bends it, and records ONE step', () => {
    const b = byId('b1');
    expect(b.style.warp.pts).toEqual([]);
    expect(drag(b, tool(), [[100, 50], [100, 62], [100, 70]])).toBe(true);
    const w = byId('b1').style.warp;
    expect(w.on).toBe(true);
    expect({ cols: w.cols, rows: w.rows }).toEqual(liquifyGrid(W, H, 40));
    expect(w.pts).toHaveLength((w.cols + 1) * (w.rows + 1));
    // Something near the centre went down; the top-left corner did not.
    expect(w.pts[0]).toEqual([0, 0]);
    expect(w.pts.some(([, y], i) => y > identityMesh(w.cols, w.rows, W, H)[i][1] + 5)).toBe(true);
    expect(peekStack().undo).toHaveLength(1);
    undo();
    expect(byId('b1').style.warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
    redo();
    expect(byId('b1').style.warp.on).toBe(true);
  });

  it('a drag that reached nothing leaves the style byte for byte and records nothing', () => {
    const b = byId('b1');
    const before = JSON.stringify(b.style);
    expect(drag(b, tool(), [[900, 900], [910, 910]])).toBe(false);
    expect(JSON.stringify(byId('b1').style)).toBe(before);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('cancel puts the style back, and a settled gesture answers nothing twice', () => {
    const b = byId('b1');
    const before = JSON.stringify(b.style);
    const g = liquifyMeshGesture(b, 1, tool());
    expect(g.step({ cx: 100, cy: 50, dx: 0, dy: 10 })).toBe(true);
    expect(g.changed).toBe(true);
    expect(g.cancel()).toBe(true);
    expect(JSON.stringify(byId('b1').style)).toBe(before);
    expect(g.commit()).toBe(false);
    expect(g.step({ cx: 100, cy: 50, dx: 0, dy: 10 })).toBe(false);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('keeps a hand-set transform rather than coarsening it', () => {
    const b = byId('b1');
    b.style.warp = { on: true, cols: 1, rows: 1, pts: [[0, 0], [W, 0], [10, H], [W - 10, H]] };
    drag(b, tool({ radius: 300 }), [[100, 50], [100, 60]]);
    const w = byId('b1').style.warp;
    // The perspective the letterer set is still in the mesh: the bottom-left
    // corner stayed pulled in.
    expect(w.pts[w.pts.length - (w.cols + 1)][0]).toBeCloseTo(10, 3);
  });
});
