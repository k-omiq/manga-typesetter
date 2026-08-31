import { describe, it, expect, beforeEach } from 'vitest';
import { liquifyGesture, sameStrokes, frameScaleFor, FRAME_MS } from './liquify-gesture.js';
import { brushTool, defaultBrushToolSettings } from './brush-tool.svelte.js';
import { defaultStyle, normalizeInkStroke } from './data.js';
import { loadProjectPages, byId } from './store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack } from './editor/history.svelte.js';

// ===========================================================================
// The two pure helpers
// ===========================================================================

describe('sameStrokes', () => {
  it('reads the engine’s own signal: element-wise identity is "nothing moved"', () => {
    const a = { pts: [[0, 0, 1]] };
    const b = { pts: [[9, 9, 1]] };
    expect(sameStrokes([a, b], [a, b])).toBe(true);
    // A stroke the tool touched is a NEW object, even with the same numbers.
    expect(sameStrokes([a, b], [a, { ...b }])).toBe(false);
    expect(sameStrokes([a, b], [a])).toBe(false);
    const list = [a];
    expect(sameStrokes(list, list)).toBe(true);
  });

  it('is false for anything that is not two arrays', () => {
    expect(sameStrokes(null, [])).toBe(false);
    expect(sameStrokes([], undefined)).toBe(false);
  });
});

describe('frameScaleFor', () => {
  it('is the engine’s contract: dt / one 60 Hz frame', () => {
    expect(frameScaleFor(FRAME_MS)).toBeCloseTo(1, 10);
    expect(frameScaleFor(FRAME_MS * 2)).toBeCloseTo(2, 10);
    expect(frameScaleFor(FRAME_MS / 2)).toBeCloseTo(0.5, 10);
  });

  it('reads no clock at all as one frame, and no elapsed time as no step', () => {
    expect(frameScaleFor(undefined)).toBe(1);
    expect(frameScaleFor(NaN)).toBe(1);
    // Two events sharing a timestamp must not each apply a whole frame.
    expect(frameScaleFor(0)).toBe(0);
    expect(frameScaleFor(-8)).toBe(0);
  });
});

// ===========================================================================
// The gesture, against a real document
// ===========================================================================

const W = 200;
const H = 100;

// A horizontal stroke across the middle of the box, a point every 10 px. Wide
// enough that a 40 px tool at its centre cannot reach either end.
const bar = () =>
  normalizeInkStroke({
    brush: 'round',
    size: 8,
    seed: 1,
    pts: Array.from({ length: 21 }, (_, i) => [i * 10, 50, 1]),
  });

// A second stroke far below, which no tool in these tests ever reaches.
const faraway = () => normalizeInkStroke({ brush: 'round', size: 8, seed: 2, pts: [[0, 400, 1], [200, 400, 1]] });

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
        style: { ...defaultStyle(), autoHeight: false, ink: { on: true, strokes: [bar(), faraway()] } },
      },
      {
        id: 'b2',
        lineN: null,
        text: 'NO INK',
        x: 400,
        y: 60,
        w: W,
        h: H,
        style: { ...defaultStyle(), autoHeight: false },
      },
    ],
  },
];

const tool = (over = {}) => ({ ...defaultBrushToolSettings(), liquifyStrength: 100, ...over });
const pts = (b, i = 0) => b.style.ink.strokes[i].pts.map((p) => [...p]);
const at = (list, x) => list.find((p) => Math.abs(p[0] - x) < 0.001);

// One whole drag the way TextBox runs it: down at the first point, then an
// application per move, then the pointer up.
function drag(box, settings, moves, { cancel = false } = {}) {
  const g = liquifyGesture(box, 1, settings);
  const push = (settings.liquifyMode ?? 'push') === 'push';
  let [lx, ly] = moves[0];
  for (const [x, y] of moves.slice(1)) {
    g.step({ cx: x, cy: y, dx: push ? x - lx : 0, dy: push ? y - ly : 0, scale: 1 });
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
    brushTool.settings = defaultBrushToolSettings();
  });

  it('moves the points inside the circle and leaves the ones outside it exactly alone', () => {
    const b = byId('b1');
    const was = pts(b);
    // A 40 px tool dragged 12 px down through the middle of the bar.
    drag(b, tool({ liquifyRadius: 40 }), [[100, 50], [100, 62]]);
    const now = pts(byId('b1'));

    // The tool is centred where the pointer IS - at (100, 62) after the move -
    // so the point below it took the delta weighted by the falloff at 12 px:
    // (1 - (12/40)^2)^2 = 0.8281, and 12 * 0.8281 = 9.937.
    expect(at(now, 100)[1]).toBeCloseTo(50 + 12 * (1 - (12 / 40) ** 2) ** 2, 6);
    expect(at(now, 100)[1]).toBeGreaterThan(at(now, 110)[1]);
    // Points inside the circle moved, and less the further out they are.
    expect(at(now, 110)[1]).toBeGreaterThan(50);
    expect(at(now, 110)[1]).toBeLessThan(at(now, 100)[1]);
    expect(at(now, 130)[1]).toBeGreaterThan(50);
    // At the rim and beyond, nothing at all - the falloff meets zero flat.
    expect(at(now, 140)[1]).toBe(50);
    expect(at(now, 0)).toEqual(at(was, 0));
    expect(at(now, 200)).toEqual(at(was, 200));
    // Only the x column moved is the y one: push takes the pointer's delta,
    // which had no x in it.
    for (const p of now) expect(p[0]).toBeCloseTo(Math.round(p[0]), 6);
  });

  it('records exactly ONE history entry for a drag, however many applications it took', () => {
    const b = byId('b1');
    const was = pts(b);
    expect(peekStack().undo).toHaveLength(0);

    expect(
      drag(b, tool({ liquifyRadius: 40 }), [[100, 50], [100, 54], [100, 58], [100, 62], [100, 66]]),
    ).toBe(true);

    expect(peekStack().undo).toHaveLength(1);
    const e = peekStack().undo[0];
    expect(e.t).toBe('style');
    expect(e.boxId).toBe('b1');
    expect(e.before.ink.strokes[0].pts).toEqual(was);
    expect(at(e.after.ink.strokes[0].pts, 100)[1]).toBeGreaterThan(60);
  });

  it('undo puts every point back exactly, and redo bends them again', () => {
    const b = byId('b1');
    const was = pts(b);
    drag(b, tool({ liquifyRadius: 40 }), [[100, 50], [100, 62]]);
    const bent = pts(byId('b1'));
    expect(bent).not.toEqual(was);

    expect(undo()).toBe(true);
    expect(pts(byId('b1'))).toEqual(was);

    expect(redo()).toBe(true);
    expect(pts(byId('b1'))).toEqual(bent);
  });

  it('leaves a stroke the tool could not reach in the array BY REFERENCE', () => {
    // The engine's identity contract, read back through the document: a page of
    // ink is not rewritten because one stroke was bent.
    const b = byId('b1');
    const other = b.style.ink.strokes[1];
    drag(b, tool({ liquifyRadius: 40 }), [[100, 50], [100, 62]]);
    expect(byId('b1').style.ink.strokes[1]).toBe(other);
  });

  it('records nothing for a drag that never reached the ink', () => {
    const b = byId('b1');
    const was = pts(b);
    // Along the top of the box, 40 px above a 20 px tool's reach.
    expect(drag(b, tool({ liquifyRadius: 20 }), [[20, 5], [60, 5], [120, 5]])).toBe(false);
    expect(pts(byId('b1'))).toEqual(was);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('records nothing for a press and release that never moved', () => {
    const b = byId('b1');
    expect(drag(b, tool(), [[100, 50]])).toBe(false);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('records nothing on a box with no ink at all', () => {
    const b = byId('b2');
    const g = liquifyGesture(b, 1, tool());
    expect(g.step({ cx: 100, cy: 50, dx: 5, dy: 5, scale: 1 })).toBe(false);
    expect(g.commit()).toBe(false);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('Escape restores the ink the pointer found, and puts nothing on the stack', () => {
    const b = byId('b1');
    // A committed drag first, so the cancel has something other than the
    // original to go back to - the case that would break if cancel simply
    // restored the strokes as they were drawn.
    drag(b, tool({ liquifyRadius: 40 }), [[100, 50], [100, 62]]);
    const settled = pts(byId('b1'));
    expect(peekStack().undo).toHaveLength(1);

    expect(drag(byId('b1'), tool({ liquifyRadius: 40 }), [[60, 50], [60, 20]], { cancel: true })).toBe(true);

    expect(pts(byId('b1'))).toEqual(settled);
    expect(peekStack().undo).toHaveLength(1);
  });

  it('cancel restores the whole style, not the ink alone', () => {
    const b = byId('b1');
    const g = liquifyGesture(b, 1, tool({ liquifyRadius: 40 }));
    g.step({ cx: 100, cy: 50, dx: 0, dy: 12, scale: 1 });
    // Something else changed mid-gesture, as an autosave or a stray write
    // could: cancel is "the style as the pointer found it", so it goes too.
    b.style.color = '#123456';
    expect(g.cancel()).toBe(true);
    expect(byId('b1').style.color).toBe(defaultStyle().color);
  });

  it('commits once and then refuses everything, so a gesture is one history step', () => {
    const b = byId('b1');
    const g = liquifyGesture(b, 1, tool({ liquifyRadius: 40 }));
    expect(g.step({ cx: 100, cy: 50, dx: 0, dy: 12, scale: 1 })).toBe(true);
    expect(g.settled).toBe(false);
    expect(g.commit()).toBe(true);
    expect(g.settled).toBe(true);
    // Every later ending is refused - the double-commit and the commit-then-
    // cancel a pointer-up racing a teardown would otherwise produce.
    expect(g.commit()).toBe(false);
    expect(g.cancel()).toBe(false);
    expect(g.step({ cx: 100, cy: 50, dx: 0, dy: 40, scale: 1 })).toBe(false);
    expect(peekStack().undo).toHaveLength(1);
  });

  // The 4.3 teardown case: the capture surface is unmounted mid-drag (the brush
  // is disarmed, another box is selected, the warp is switched on) and no
  // pointer event ever arrives.
  it('a gesture ended by a teardown rather than by a pointer restores the ink', () => {
    const b = byId('b1');
    const was = pts(b);
    const g = liquifyGesture(b, 1, tool({ liquifyRadius: 40 }));
    g.step({ cx: 100, cy: 50, dx: 0, dy: 12, scale: 1 });
    expect(pts(byId('b1'))).not.toEqual(was);

    expect(g.cancel()).toBe(true); // what the component's teardown calls

    expect(pts(byId('b1'))).toEqual(was);
    expect(peekStack().undo).toHaveLength(0);
  });

  it('reads its settings once, so the panel cannot change the tool mid-drag', () => {
    const b = byId('b1');
    const g = liquifyGesture(b, 1, tool({ liquifyRadius: 40, liquifyMode: 'push' }));
    expect(g.tool).toEqual({ mode: 'push', radius: 40, strength: 100 });
    brushTool.settings.liquifyRadius = 200;
    brushTool.settings.liquifyMode = 'twirl';
    expect(g.tool).toEqual({ mode: 'push', radius: 40, strength: 100 });
    g.step({ cx: 100, cy: 50, dx: 0, dy: 10, scale: 1 });
    // Still a 40 px tool: the point at 140 is on its rim and did not move.
    expect(at(pts(byId('b1')), 140)[1]).toBe(50);
  });
});

describe('the fields a drag applies', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
  });

  const dist = (p, cx, cy) => Math.hypot(p[0] - cx, p[1] - cy);

  it('expand moves the ink radially away from where the pointer is', () => {
    const b = byId('b1');
    const was = pts(b);
    // The centre sits above the bar, so "outward" is a direction with a y in it
    // as well as an x. The hold modes take their step from `scale` rather than
    // from a delta, so one application at one place is the whole test.
    const g = liquifyGesture(b, 1, tool({ liquifyMode: 'expand', liquifyRadius: 60 }));
    expect(g.step({ cx: 100, cy: 30, scale: 1 })).toBe(true);
    g.commit();

    const now = pts(byId('b1'));
    for (let i = 0; i < was.length; i++) {
      const d0 = dist(was[i], 100, 30);
      const d1 = dist(now[i], 100, 30);
      if (d0 < 60) expect(d1).toBeGreaterThan(d0);
      else expect(now[i]).toEqual(was[i]);
    }
  });

  it('pinch pulls it the other way', () => {
    const b = byId('b1');
    const was = pts(b);
    const g = liquifyGesture(b, 1, tool({ liquifyMode: 'pinch', liquifyRadius: 60 }));
    expect(g.step({ cx: 100, cy: 30, scale: 1 })).toBe(true);
    g.commit();
    const now = pts(byId('b1'));
    for (let i = 0; i < was.length; i++) {
      const d0 = dist(was[i], 100, 30);
      if (d0 < 60 && d0 > 0) expect(dist(now[i], 100, 30)).toBeLessThan(d0);
    }
  });

  it('twirl turns the ink about the centre and conserves its distance', () => {
    const b = byId('b1');
    const was = pts(b);
    const g = liquifyGesture(b, 1, tool({ liquifyMode: 'twirl', liquifyRadius: 60 }));
    expect(g.step({ cx: 100, cy: 50, scale: 1 })).toBe(true);
    g.commit();
    const now = pts(byId('b1'));
    let turned = 0;
    for (let i = 0; i < was.length; i++) {
      const d0 = dist(was[i], 100, 50);
      expect(dist(now[i], 100, 50)).toBeCloseTo(d0, 8);
      if (now[i][1] !== was[i][1]) turned++;
    }
    expect(turned).toBeGreaterThan(0);
  });

  it('the hold modes ignore the pointer’s delta - only push reads it', () => {
    const a = byId('b1');
    const g1 = liquifyGesture(a, 1, tool({ liquifyMode: 'twirl', liquifyRadius: 60 }));
    g1.step({ cx: 100, cy: 50, dx: 999, dy: -999, scale: 1 });
    const withDelta = pts(byId('b1'));
    g1.cancel();

    const g2 = liquifyGesture(byId('b1'), 1, tool({ liquifyMode: 'twirl', liquifyRadius: 60 }));
    g2.step({ cx: 100, cy: 50, dx: 0, dy: 0, scale: 1 });
    const without = pts(byId('b1'));
    g2.cancel();

    expect(withDelta).toEqual(without);
  });

  it('a hold mode given no elapsed time does nothing at all', () => {
    const b = byId('b1');
    const g = liquifyGesture(b, 1, tool({ liquifyMode: 'expand', liquifyRadius: 60 }));
    expect(g.step({ cx: 100, cy: 50, scale: frameScaleFor(0) })).toBe(false);
    expect(g.commit()).toBe(false);
    expect(peekStack().undo).toHaveLength(0);
  });
});
