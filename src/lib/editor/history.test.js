import { describe, it, expect, beforeEach } from 'vitest';
import { app, loadProjectPages, deleteBox, placeActiveAt, page } from '../store.svelte.js';
import {
  history,
  record,
  undo,
  redo,
  resetHistory,
  initHistory,
  MAX_STEPS,
  takeStack,
  loadStack,
} from './history.svelte.js';

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }],
    boxes: [
      { id: 'b1', lineN: null, text: 'one', x: 10, y: 10, w: 100, h: 40, style: null },
      { id: 'b2', lineN: null, text: 'two', x: 50, y: 50, w: 100, h: 40, style: null },
    ],
  },
];

beforeEach(() => {
  initHistory();
  resetHistory();
  loadProjectPages(doc());
});

describe('command records', () => {
  it('undoes a move and redoes it', () => {
    const b = page().boxes[0];
    b.x = 200;
    b.y = 300;
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 10, y: 10 }, after: { x: 200, y: 300 } });
    undo();
    expect(page().boxes[0].x).toBe(10);
    redo();
    expect(page().boxes[0].x).toBe(200);
  });

  it('undoes a resize', () => {
    record({
      t: 'resize',
      pageId: 1,
      boxId: 'b1',
      before: { x: 10, y: 10, w: 100, h: 40, size: 20 },
      after: { x: 12, y: 12, w: 260, h: 90, size: 40 },
    });
    undo();
    const b = page().boxes[0];
    expect([b.w, b.h]).toEqual([100, 40]);
  });

  it('undoes a delete back into its old position in the stack', () => {
    deleteBox('b1');
    expect(page().boxes.map((b) => b.id)).toEqual(['b2']);
    undo();
    expect(page().boxes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('undoes a place by removing the box', () => {
    page().activeLineN = 1;
    placeActiveAt(400, 400);
    expect(page().boxes.length).toBe(3);
    undo();
    expect(page().boxes.length).toBe(2);
  });

  it('undoes a bulk apply as one step', () => {
    record({
      t: 'bulk',
      pageId: 1,
      items: [
        { boxId: 'b1', before: { size: 10 }, after: { size: 30 } },
        { boxId: 'b2', before: { size: 12 }, after: { size: 30 } },
      ],
    });
    undo();
    expect(page().boxes[0].style.size).toBe(10);
    expect(page().boxes[1].style.size).toBe(12);
    expect(history.canUndo).toBe(false);
  });

  it('undoes a text edit', () => {
    page().boxes[0].text = 'changed';
    record({ t: 'text', pageId: 1, boxId: 'b1', before: 'one', after: 'changed' });
    undo();
    expect(page().boxes[0].text).toBe('one');
  });
});

describe('bounds', () => {
  const move = (n) =>
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: n, y: 0 }, after: { x: n + 1, y: 0 } });

  it('holds five and drops the oldest at six', () => {
    for (let i = 0; i < MAX_STEPS + 1; i++) move(i);
    let count = 0;
    while (history.canUndo) {
      undo();
      count++;
    }
    expect(count).toBe(MAX_STEPS);
    // the oldest was dropped, so the earliest state reachable is the second move's
    expect(page().boxes[0].x).toBe(1);
  });

  it('a new record clears redo', () => {
    move(0);
    undo();
    expect(history.canRedo).toBe(true);
    move(9);
    expect(history.canRedo).toBe(false);
  });
});

describe('failure', () => {
  it('refuses an entry whose box is gone, drops it, and carries on', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    record({ t: 'move', pageId: 1, boxId: 'ghost', before: { x: 0, y: 0 }, after: { x: 9, y: 9 } });
    undo(); // the ghost — refused and dropped
    expect(app.toast.msg).toMatch(/gone/i);
    expect(history.canUndo).toBe(true);
    undo(); // the real one still works
    expect(page().boxes[0].x).toBe(0);
  });

  it('refuses an entry for a page that is gone', () => {
    record({ t: 'move', pageId: 99, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    undo();
    expect(history.canUndo).toBe(false);
    expect(app.toast.msg).toMatch(/gone/i);
  });
});

describe('per-page stacks', () => {
  it('hands its stack over and takes another back', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    const out = takeStack();
    expect(out.undo.length).toBe(1);
    expect(history.canUndo).toBe(false);
    loadStack(1, out);
    expect(history.canUndo).toBe(true);
  });
});

// The next task writes these entries to a file as JSON, so anything a mutation
// site records has to survive the round trip unchanged — no proxies, no
// functions, no class instances hiding in a record.
describe('plain data', () => {
  it('keeps every recorded entry JSON-clean', () => {
    page().activeLineN = 1;
    placeActiveAt(400, 400);
    deleteBox('b1');
    record({ t: 'text', pageId: 1, boxId: 'b2', before: 'two', after: 'three' });
    const out = takeStack();
    expect(out.undo.length).toBe(3);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('copies what it is handed, so a later mutation cannot rewrite history', () => {
    const before = { x: 1, y: 2 };
    record({ t: 'move', pageId: 1, boxId: 'b1', before, after: { x: 9, y: 9 } });
    before.x = 999;
    undo();
    expect(page().boxes[0].x).toBe(1);
  });
});
