import { describe, it, expect, beforeEach } from 'vitest';
import {
  HANDLE_R,
  gizmoPts,
  handlePoints,
  meshSegments,
  ghostOutline,
  movedPts,
  regridWarp,
  beginWarpDrag,
  dragWarpTo,
  cancelWarpDrag,
  commitWarpDrag,
  resetWarp,
} from './warp-gizmo.js';
import { identityMesh, isIdentityMesh, warpPoint } from './warp.js';
import { defaultStyle, normalizeWarp, WARP_MAX_GRID } from './data.js';
import { app, loadProjectPages, byId } from './store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack } from './editor/history.svelte.js';

// ===========================================================================
// The pure half: what the gizmo draws and what a gesture makes of the mesh
// ===========================================================================

const W = 200;
const H = 100;
const warp = (over = {}) => ({ on: true, cols: 1, rows: 1, pts: [], ...over });

describe('gizmoPts', () => {
  it('materialises the identity grid for a mesh that has never been dragged', () => {
    // The stored form of "untouched" is the EMPTY array (data.js), and a gizmo
    // cannot put handles on nothing.
    expect(gizmoPts(warp(), W, H)).toEqual(identityMesh(1, 1, W, H));
    expect(gizmoPts(warp({ cols: 3, rows: 2 }), W, H)).toEqual(identityMesh(3, 2, W, H));
  });

  it('hands back the stored mesh when it matches the grid', () => {
    const pts = [
      [5, 5],
      [W, 0],
      [0, H],
      [W, H],
    ];
    expect(gizmoPts(warp({ pts }), W, H)).toEqual(pts);
  });

  it('copies rather than aliases, so a drag cannot edit its own cancel state', () => {
    const pts = identityMesh(1, 1, W, H);
    const out = gizmoPts(warp({ pts }), W, H);
    out[0][0] = -999;
    expect(pts[0][0]).toBe(0);
  });

  it('falls back to the grid for a mesh of the wrong length or with an unreadable point', () => {
    expect(gizmoPts(warp({ pts: [[0, 0]] }), W, H)).toEqual(identityMesh(1, 1, W, H));
    const torn = [
      [0, 0],
      [W, NaN],
      [0, H],
      [W, H],
    ];
    expect(gizmoPts(warp({ pts: torn }), W, H)).toEqual(identityMesh(1, 1, W, H));
  });
});

describe('handlePoints', () => {
  it('gives one handle per grid point, each naming the pts index it writes', () => {
    const hs = handlePoints(warp({ cols: 3, rows: 2 }), W, H);
    expect(hs).toHaveLength((3 + 1) * (2 + 1));
    expect(hs.map((p) => p.i)).toEqual(hs.map((_, k) => k));
  });

  it('puts the four corners of a 1x1 mesh on the box rect, in row-major order', () => {
    const hs = handlePoints(warp(), W, H);
    expect(hs.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ]);
    // The row/col a handle sits at, which is what the markup uses to say a
    // corner handle is a corner handle.
    expect(hs.map((p) => [p.col, p.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
  });

  it('follows a dragged point, so the handle is where the mesh is', () => {
    const pts = movedPts(identityMesh(1, 1, W, H), 0, -30, -40);
    const hs = handlePoints(warp({ pts }), W, H);
    expect([hs[0].x, hs[0].y]).toEqual([-30, -40]);
  });

  it('is a screen-space radius, so a handle is the same target at every zoom', () => {
    expect(HANDLE_R).toBeGreaterThan(2);
  });
});

describe('meshSegments', () => {
  it('draws every grid line of the mesh and nothing else', () => {
    // cols x rows cells: (rows+1) horizontal lines of cols segments each, plus
    // (cols+1) vertical lines of rows segments each.
    const segs = meshSegments(warp({ cols: 3, rows: 2 }), W, H);
    expect(segs).toHaveLength((2 + 1) * 3 + (3 + 1) * 2);
  });

  it('joins the control points themselves, so the wireframe IS the cell edges', () => {
    const pts = movedPts(identityMesh(1, 1, W, H), 1, 400, -50);
    const segs = meshSegments(warp({ pts }), W, H);
    // The top edge runs from the untouched top-left to the dragged top-right.
    expect(segs).toContainEqual([0, 0, 400, -50]);
  });
});

describe('ghostOutline', () => {
  it('is the box rect, which is what the identity mesh is', () => {
    expect(ghostOutline(W, H)).toEqual([
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ]);
  });

  it('never states a negative box', () => {
    expect(ghostOutline(-5, -5)).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('movedPts', () => {
  it('puts one control point where the drag left it and leaves the rest alone', () => {
    const before = identityMesh(1, 1, W, H);
    const after = movedPts(before, 3, W + 20, H + 40);
    expect(after[3]).toEqual([W + 20, H + 40]);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
  });

  it('returns fresh points, so the pre-drag mesh survives as the cancel state', () => {
    const before = identityMesh(1, 1, W, H);
    const after = movedPts(before, 0, 9, 9);
    expect(before[0]).toEqual([0, 0]);
    expect(after[0]).not.toBe(before[0]);
  });

  it('changes nothing for an index outside the mesh or a destination that is not a number', () => {
    const before = identityMesh(1, 1, W, H);
    expect(movedPts(before, 9, 1, 1)).toEqual(before);
    expect(movedPts(before, -1, 1, 1)).toEqual(before);
    expect(movedPts(before, 0, NaN, 1)).toEqual(before);
  });
});

describe('regridWarp', () => {
  it('carries the deformation onto the new grid', () => {
    // A 1x1 mesh with the top-right corner pulled up, stepped to 3x3: every new
    // control point is the old mesh's answer for where that point goes, so the
    // shape the user dragged survives.
    const pts = movedPts(identityMesh(1, 1, W, H), 1, W + 60, -40);
    const next = regridWarp(warp({ pts }), 3, 3, W, H);
    expect(next.cols).toBe(3);
    expect(next.rows).toBe(3);
    expect(next.pts).toHaveLength(16);
    for (const [i, j] of [
      [0, 0],
      [3, 0],
      [1, 2],
      [3, 3],
    ]) {
      const k = j * 4 + i;
      const [x, y] = warpPoint(pts, 1, 1, W, H, (W * i) / 3, (H * j) / 3);
      expect(next.pts[k][0]).toBeCloseTo(x, 9);
      expect(next.pts[k][1]).toBeCloseTo(y, 9);
    }
    // ...and it is still a real deformation on the new grid, not an identity
    // that happens to have more points in it.
    expect(isIdentityMesh(next.pts, 3, 3, W, H)).toBe(false);
  });

  it('keeps an untouched mesh empty rather than writing identity points into the file', () => {
    const next = regridWarp(warp({ cols: 1, rows: 1 }), 4, 4, W, H);
    expect(next).toEqual({ on: true, cols: 4, rows: 4, pts: [] });
  });

  it('drops a deformation that has come back to identity, at any grid size', () => {
    const next = regridWarp(warp({ pts: identityMesh(1, 1, W, H) }), 2, 2, W, H);
    expect(next.pts).toEqual([]);
  });

  it('clamps the grid to what the sanitiser will accept', () => {
    expect(regridWarp(warp(), 0, 99, W, H)).toMatchObject({ cols: 1, rows: WARP_MAX_GRID });
  });

  it('keeps the switch as it found it', () => {
    expect(regridWarp(warp({ on: false }), 2, 2, W, H).on).toBe(false);
  });

  it('produces a block the sanitiser accepts unchanged', () => {
    // The one thing a wrong length costs is the whole mesh: normalizeWarp resets
    // a pts that does not match its grid. A round trip through it is what says
    // a grid change survives a save and a reload.
    const pts = movedPts(identityMesh(2, 1, W, H), 0, -20, -10);
    const next = regridWarp(warp({ cols: 2, rows: 1, pts }), 2, 3, W, H);
    expect(normalizeWarp(next)).toEqual(next);
  });

  it('is a no-op on the mesh when the grid does not actually change', () => {
    const pts = movedPts(identityMesh(1, 1, W, H), 2, -10, H + 10);
    const next = regridWarp(warp({ pts }), 1, 1, W, H);
    expect(next.pts).toEqual(pts);
  });
});

// ===========================================================================
// The gestures: one history step per drag, and none for a drag that did nothing
// ===========================================================================

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [
      {
        id: 'b1',
        lineN: null,
        text: 'SFX',
        x: 40,
        y: 60,
        w: W,
        h: H,
        style: { ...defaultStyle(), autoHeight: false, warp: { on: true, cols: 1, rows: 1, pts: [] } },
      },
    ],
  },
];

// One whole drag, the way WarpGizmo.svelte runs it: down, some moves, up.
const drag = (box, i, moves, { cancel = false } = {}) => {
  const before = beginWarpDrag(box);
  for (const [x, y] of moves) dragWarpTo(box, i, x, y);
  if (cancel) {
    cancelWarpDrag(box, before);
    return false;
  }
  return commitWarpDrag(box, 1, before);
};

describe('a handle drag against the document', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
    app.selectedId = 'b1';
  });

  it('records exactly ONE history entry for a drag, however many moves it took', () => {
    const b = byId('b1');
    expect(peekStack().undo).toHaveLength(0);

    expect(drag(b, 1, [[W + 10, -5], [W + 30, -20], [W + 60, -40]])).toBe(true);

    expect(peekStack().undo).toHaveLength(1);
    const e = peekStack().undo[0];
    expect(e.t).toBe('style');
    expect(e.boxId).toBe('b1');
    expect(e.before.warp.pts).toEqual([]);
    expect(e.after.warp.pts[1]).toEqual([W + 60, -40]);
  });

  it('leaves the mesh where the last move put it', () => {
    const b = byId('b1');
    drag(b, 3, [[W + 25, H + 25]]);
    expect(b.style.warp.pts[3]).toEqual([W + 25, H + 25]);
    expect(b.style.warp.pts).toHaveLength(4);
  });

  it('undo puts the box back to an undeformed mesh, and redo deforms it again', () => {
    const b = byId('b1');
    drag(b, 0, [[-40, -30]]);
    expect(byId('b1').style.warp.pts).toHaveLength(4);

    expect(undo()).toBe(true);
    expect(byId('b1').style.warp.pts).toEqual([]);
    expect(byId('b1').style.warp.on).toBe(true);

    expect(redo()).toBe(true);
    expect(byId('b1').style.warp.pts[0]).toEqual([-40, -30]);
  });

  it('records nothing for a press and release that moved nothing', () => {
    // The press materialises the identity mesh so the drag has an array to
    // write into. Committing that would be a history step for a gesture that
    // changed no pixel, so an identity mesh is normalised back to empty first.
    const b = byId('b1');
    expect(drag(b, 2, [])).toBe(false);
    expect(b.style.warp.pts).toEqual([]);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('records nothing for a drag that came back to where it started', () => {
    const b = byId('b1');
    expect(drag(b, 1, [[W + 50, 5], [W, 0]])).toBe(false);
    expect(b.style.warp.pts).toEqual([]);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('Escape restores the mesh the pointer found, and puts nothing on the stack', () => {
    const b = byId('b1');
    // A committed drag first, so the cancel has something other than identity
    // to go back to - the case that would break if cancel simply cleared pts.
    drag(b, 1, [[W + 60, -40]]);
    const settled = b.style.warp.pts.map((p) => [...p]);
    expect(peekStack().undo).toHaveLength(1);

    drag(byId('b1'), 2, [[-80, H + 80], [-120, H + 120]], { cancel: true });

    expect(byId('b1').style.warp.pts).toEqual(settled);
    expect(peekStack().undo).toHaveLength(1);
  });

  it('cancel restores the whole style, not the mesh alone', () => {
    const b = byId('b1');
    const before = beginWarpDrag(b);
    dragWarpTo(b, 0, -10, -10);
    // Something else changed mid-gesture, as an autosave or a stray write could:
    // cancel is stated as "the style as the pointer found it", so it goes too.
    b.style.color = '#123456';
    cancelWarpDrag(b, before);
    expect(byId('b1').style.color).toBe(defaultStyle().color);
    expect(byId('b1').style.warp.pts).toEqual([]);
  });

  it('the before-snapshot is taken BEFORE the mesh is materialised', () => {
    // The Inspector's own hard-learned rule (see armSnap): a snapshot taken
    // after the mutation diffs as before === after and records nothing.
    const b = byId('b1');
    const before = beginWarpDrag(b);
    expect(before.warp.pts).toEqual([]);
    expect(b.style.warp.pts).toHaveLength(4);
  });
});

describe('resetWarp', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
  });

  it('takes the mesh back to identity in one history step, and undo brings it back', () => {
    const b = byId('b1');
    drag(b, 1, [[W + 60, -40]]);
    expect(peekStack().undo).toHaveLength(1);

    expect(resetWarp(byId('b1'), 1)).toBe(true);
    expect(byId('b1').style.warp.pts).toEqual([]);
    expect(peekStack().undo).toHaveLength(2);

    undo();
    expect(byId('b1').style.warp.pts[1]).toEqual([W + 60, -40]);
  });

  it('leaves the switch alone: Reset is about the mesh, not the effect', () => {
    const b = byId('b1');
    drag(b, 1, [[W + 60, -40]]);
    resetWarp(byId('b1'), 1);
    expect(byId('b1').style.warp.on).toBe(true);
  });

  it('does nothing, and records nothing, when there is no mesh to reset', () => {
    expect(resetWarp(byId('b1'), 1)).toBe(false);
    expect(peekStack().undo).toHaveLength(0);
  });
});
