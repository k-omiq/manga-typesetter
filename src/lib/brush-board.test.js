import { describe, it, expect, beforeEach } from 'vitest';
import {
  board,
  BOARD_SIZE,
  BOARD_UNDO_MAX,
  PLACE_PAD,
  addBoardStroke,
  beginBoardGesture,
  endBoardGesture,
  inBoardGesture,
  eraseBoardAt,
  undoBoard,
  redoBoard,
  clearBoard,
  resetBoard,
  loadBoardFromBox,
  cancelBoardEdit,
  boardEditStrokes,
  boardPlacement,
  translateStrokes,
  strokesBounds,
  widthBoardAt,
  liquifyBoard,
} from './brush-board.svelte.js';

const stroke = (pts, over = {}) => ({ brush: 'round', size: 10, pts, ...over });
const line = (x0, x1, y = 100) => stroke([[x0, y, 1], [x1, y, 1]]);

beforeEach(() => resetBoard());

describe('adding strokes', () => {
  it('normalises at the door and bumps the revision', () => {
    const rev = board.rev;
    expect(addBoardStroke(stroke([[1, 2], [3, 4]]))).toBe(true);
    expect(board.strokes).toHaveLength(1);
    expect(board.strokes[0].pts).toEqual([[1, 2, 1], [3, 4, 1]]);
    expect(board.strokes[0].color).toBe('#000000');
    expect(board.rev).toBe(rev + 1);
    expect(board.canUndo).toBe(true);
    expect(board.canRedo).toBe(false);
  });

  it('refuses a stroke with nothing in it', () => {
    expect(addBoardStroke(stroke([]))).toBe(false);
    expect(addBoardStroke(null)).toBe(false);
    expect(board.strokes).toHaveLength(0);
    expect(board.canUndo).toBe(false);
  });
});

describe('undo and redo', () => {
  it('steps back one stroke at a time and forward again', () => {
    addBoardStroke(line(0, 10));
    addBoardStroke(line(0, 20));
    expect(undoBoard()).toBe(true);
    expect(board.strokes).toHaveLength(1);
    expect(board.canRedo).toBe(true);
    expect(redoBoard()).toBe(true);
    expect(board.strokes).toHaveLength(2);
    expect(board.canRedo).toBe(false);
  });

  it('a new stroke after an undo drops the redo branch', () => {
    addBoardStroke(line(0, 10));
    undoBoard();
    addBoardStroke(line(0, 30));
    expect(board.canRedo).toBe(false);
    expect(redoBoard()).toBe(false);
  });

  it('is bounded', () => {
    for (let i = 0; i < BOARD_UNDO_MAX + 10; i++) addBoardStroke(line(0, 10 + i));
    let n = 0;
    while (undoBoard()) n++;
    expect(n).toBe(BOARD_UNDO_MAX);
    expect(board.strokes).toHaveLength(10);
  });

  it('undo with nothing to undo says so', () => {
    expect(undoBoard()).toBe(false);
    expect(redoBoard()).toBe(false);
  });

  it('clear is one step', () => {
    addBoardStroke(line(0, 10));
    addBoardStroke(line(0, 20));
    expect(clearBoard()).toBe(true);
    expect(board.strokes).toHaveLength(0);
    undoBoard();
    expect(board.strokes).toHaveLength(2);
    expect(clearBoard()).toBe(true);
    resetBoard();
    expect(clearBoard()).toBe(false);
  });
});

describe('erase', () => {
  it('takes whole strokes the circle touches, one step per gesture', () => {
    addBoardStroke(line(0, 10, 100));
    addBoardStroke(line(0, 10, 300));
    beginBoardGesture();
    expect(inBoardGesture()).toBe(true);
    expect(eraseBoardAt(5, 100, 2)).toBe(1);
    expect(eraseBoardAt(5, 100, 2)).toBe(0);
    expect(endBoardGesture(true)).toBe(true);
    expect(inBoardGesture()).toBe(false);
    expect(board.strokes).toHaveLength(1);
    expect(board.strokes[0].pts[0][1]).toBe(300);
    undoBoard();
    expect(board.strokes).toHaveLength(2);
  });

  it('a rub that hit nothing records no step', () => {
    addBoardStroke(line(0, 10, 100));
    const rev = board.rev;
    beginBoardGesture();
    expect(eraseBoardAt(500, 500, 2)).toBe(0);
    expect(endBoardGesture(true)).toBe(false);
    expect(board.rev).toBe(rev);
    undoBoard();
    expect(board.strokes).toHaveLength(0);
  });

  it('a cancelled gesture puts the strokes back', () => {
    addBoardStroke(line(0, 10, 100));
    beginBoardGesture();
    eraseBoardAt(5, 100, 2);
    expect(board.strokes).toHaveLength(0);
    expect(endBoardGesture(false)).toBe(true);
    expect(board.strokes).toHaveLength(1);
    expect(board.canRedo).toBe(false);
  });

  it('a second begin cancels the first', () => {
    addBoardStroke(line(0, 10, 100));
    beginBoardGesture();
    eraseBoardAt(5, 100, 2);
    beginBoardGesture();
    expect(board.strokes).toHaveLength(1);
    endBoardGesture(true);
  });

  it('a stroke arriving inside a gesture cancels the gesture first', () => {
    addBoardStroke(line(0, 10, 100));
    beginBoardGesture();
    eraseBoardAt(5, 100, 2);
    addBoardStroke(line(0, 10, 300));
    expect(inBoardGesture()).toBe(false);
    // The erase was cancelled, so both lines stand.
    expect(board.strokes).toHaveLength(2);
    expect(endBoardGesture(true)).toBe(false);
  });

  it('outside a gesture, each rub is its own step', () => {
    addBoardStroke(line(0, 10, 100));
    expect(eraseBoardAt(5, 100, 2)).toBe(1);
    expect(board.strokes).toHaveLength(0);
    undoBoard();
    expect(board.strokes).toHaveLength(1);
  });
});

describe('to and from a box', () => {
  it('loads a box\'s strokes centred on the board and remembers where they came from', () => {
    const src = [line(0, 20, 0)];
    loadBoardFromBox(7, 'b3', src);
    expect(board.editing).toMatchObject({ pageId: 7, boxId: 'b3' });
    const b = strokesBounds(board.strokes);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(BOARD_SIZE / 2, 0);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(BOARD_SIZE / 2, 0);
    // A copy, not the box's own strokes.
    expect(board.strokes[0]).not.toBe(src[0]);
    expect(board.canUndo).toBe(false);
  });

  it('hands the strokes back in the box\'s own frame', () => {
    loadBoardFromBox(7, 'b3', [line(0, 20, 0)]);
    addBoardStroke(line(BOARD_SIZE / 2, BOARD_SIZE / 2 + 10, BOARD_SIZE / 2));
    const back = boardEditStrokes();
    expect(back[0].pts[0].slice(0, 2)).toEqual([0, 0]);
    expect(back[0].pts[1].slice(0, 2)).toEqual([20, 0]);
    // The new stroke came back through the same translation: the board's
    // centre is the source ink's centre, x = 10 for a 0..20 line 10 px wide.
    expect(back[1].pts[0][0]).toBeCloseTo(10, 5);
  });

  it('has nothing to hand back when not editing', () => {
    expect(boardEditStrokes()).toBeNull();
    loadBoardFromBox(1, 'b1', [line(0, 1)]);
    cancelBoardEdit();
    expect(board.editing).toBeNull();
    expect(boardEditStrokes()).toBeNull();
  });

  it('a placement pads the ink by the tip and translates it to the origin', () => {
    addBoardStroke(stroke([[100, 100, 1], [200, 100, 1]], { size: 10 }));
    const pl = boardPlacement();
    // 100 px of path plus a 5 px radius each side plus the pad each side.
    expect(pl.w).toBe(100 + 10 + PLACE_PAD * 2);
    expect(pl.h).toBe(10 + PLACE_PAD * 2);
    const b = strokesBounds(pl.strokes);
    expect(b.minX).toBeCloseTo(PLACE_PAD, 5);
    expect(b.minY).toBeCloseTo(PLACE_PAD, 5);
    // The board is untouched by asking.
    expect(board.strokes[0].pts[0][0]).toBe(100);
  });

  it('an empty board places nothing', () => {
    expect(boardPlacement()).toBeNull();
    expect(boardPlacement([])).toBeNull();
  });

  it('translateStrokes copies', () => {
    const k = line(0, 10);
    const [t] = translateStrokes([k], 5, 6);
    expect(t).not.toBe(k);
    expect(t.pts).toEqual([[5, 106, 1], [15, 106, 1]]);
    expect(k.pts[0]).toEqual([0, 100, 1]);
  });
});

describe('a box\'s finish on the board', () => {
  it('rides beside the strokes it is editing, normalised, and is empty when none came', () => {
    loadBoardFromBox(7, 'b3', [line(0, 20, 0)], {
      strokes: [{ color: '#ff0000', width: 5 }, { width: 0 }],
      shadows: [{ x: 1 }],
    });
    expect(board.editing.finish.strokes).toEqual([{ color: '#ff0000', width: 5, opacity: 1 }]);
    expect(board.editing.finish.shadows).toHaveLength(1);
    expect(board.editing.finish.shadows[0]).toMatchObject({ x: 1, y: 2 });
    loadBoardFromBox(7, 'b3', [line(0, 20, 0)]);
    expect(board.editing.finish).toEqual({ strokes: [], shadows: [] });
  });
});

describe('the point factors', () => {
  it('ride through a translation', () => {
    const [k] = translateStrokes([stroke([[1, 2, 0.5, 0.25, 0.75], [3, 4, 1]])], 10, 20);
    expect(k.pts).toEqual([[11, 22, 0.5, 0.25, 0.75], [13, 24, 1]]);
  });
});

describe('the vector edits', () => {
  it('erase in part cuts the touched run out and leaves two strokes, one step', () => {
    addBoardStroke(line(0, 200));
    expect(eraseBoardAt(100, 100, 10, 'part')).toBe(1);
    expect(board.strokes).toHaveLength(2);
    expect(board.strokes[0].pts.at(-1)[0]).toBeCloseTo(90);
    expect(board.strokes[1].pts[0][0]).toBeCloseTo(110);
    expect(board.canUndo).toBe(true);
    undoBoard();
    expect(board.strokes).toHaveLength(1);
  });

  it('erase to crossing runs from the crossing to the end', () => {
    addBoardStroke(line(0, 200));
    addBoardStroke(stroke([[100, 0, 1], [100, 200, 1]]));
    expect(eraseBoardAt(180, 100, 10, 'cross')).toBe(1);
    expect(board.strokes).toHaveLength(2);
    expect(board.strokes[0].pts.at(-1)[0]).toBeCloseTo(100);
    expect(board.strokes[1].pts).toHaveLength(2);
  });

  it('a rub that reaches no stroke records nothing in every mode', () => {
    addBoardStroke(line(0, 200));
    for (const how of ['whole', 'part', 'cross']) {
      expect(eraseBoardAt(100, 500, 10, how)).toBe(0);
    }
    expect(widthBoardAt(100, 500, 10, 1.5)).toBe(false);
    expect(liquifyBoard({ mode: 'push', cx: 100, cy: 500, radius: 10, strength: 100, dx: 5, dy: 5 })).toBe(false);
    expect(board.canUndo).toBe(true); // the add only
    undoBoard();
    expect(board.canUndo).toBe(false);
  });

  it('width thickens under the circle and is one step per gesture', () => {
    addBoardStroke(stroke([[0, 100, 0.5], [100, 100, 0.5], [200, 100, 0.5]]));
    beginBoardGesture();
    expect(widthBoardAt(100, 100, 30, 1.5)).toBe(true);
    expect(widthBoardAt(100, 100, 30, 1.5)).toBe(true);
    endBoardGesture(true);
    const k = board.strokes[0];
    // The pass subdivides the stroke, so the points are found by position.
    const at = (x) => k.pts.reduce((m, p) => (Math.abs(p[0] - x) < Math.abs(m[0] - x) ? p : m));
    expect(at(100)[2]).toBeGreaterThan(at(0)[2]);
    // The untouched ends keep their width in px even when the size grew to
    // hold the thickened middle.
    expect(k.size * at(0)[2]).toBeCloseTo(5);
    expect(k.size * at(100)[2]).toBeCloseTo(5 * 1.5 * 1.5);
    undoBoard();
    expect(board.strokes[0].pts).toHaveLength(3);
    expect(board.strokes[0].pts[1][2]).toBeCloseTo(0.5);
  });

  it('width reaches a sparse stroke between its points, and leaves an untouched one alone', () => {
    addBoardStroke(stroke([[0, 100, 0.5], [400, 100, 0.5]]));
    const before = board.strokes[0];
    expect(widthBoardAt(200, 100, 10, 1.5)).toBe(true);
    const k = board.strokes[0];
    expect(k.pts.length).toBeGreaterThan(2);
    expect(Math.max(...k.pts.map((p) => p[2]))).toBeGreaterThan(0.5);
    // A pass that reaches nothing must not leave the subdivision behind.
    addBoardStroke(stroke([[0, 300, 0.5], [400, 300, 0.5]]));
    const far = board.strokes[1];
    expect(widthBoardAt(200, 600, 10, 1.5)).toBe(false);
    expect(board.strokes[1]).toBe(far);
    expect(far.pts).toHaveLength(2);
    void before;
  });

  it('liquify moves the points and keeps the stroke a stroke', () => {
    addBoardStroke(line(0, 200));
    expect(liquifyBoard({ mode: 'push', cx: 100, cy: 100, radius: 40, strength: 100, dx: 0, dy: 20 })).toBe(true);
    const k = board.strokes[0];
    expect(k.pts.some((p) => p[1] > 105)).toBe(true);
    expect(k.pts[0][1]).toBe(100);
    expect(board.strokes).toHaveLength(1);
  });
});
