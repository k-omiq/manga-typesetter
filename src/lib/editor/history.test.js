import { describe, it, expect, beforeEach } from 'vitest';
import {
  app,
  loadProjectPages,
  deleteBox,
  placeActiveAt,
  addEmptyBox,
  beginEdit,
  endEdit,
  selectBox,
  deselect,
  page,
  setEditSettleHook,
} from '../store.svelte.js';
import {
  history,
  record,
  undo,
  redo,
  resetHistory,
  initHistory,
  MAX_STEPS,
  takeStack,
  peekStack,
  loadStack,
} from './history.svelte.js';

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [
      { n: 1, type: 'dialogue', jp: 'あ', en: 'ah' },
      { n: 2, type: 'dialogue', jp: 'い', en: 'ee' },
    ],
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

// The queue's active line is part of the edit, not a view of it: a place
// advances it and a delete hands the line back, so an undo that ignored it
// would leave the queue disagreeing with the canvas.
describe('the queue moves with the record', () => {
  it('rewinds the queue when a place is undone, and forwards it on redo', () => {
    expect(page().activeLineN).toBe(1);
    placeActiveAt(400, 400);
    expect(page().activeLineN).toBe(2);
    undo();
    expect(page().activeLineN).toBe(1);
    redo();
    expect(page().activeLineN).toBe(2);
  });

  it('takes the line back out of the queue when a delete is undone', () => {
    placeActiveAt(400, 400);
    const id = page().boxes[2].id;
    deleteBox(id);
    expect(page().activeLineN).toBe(1); // the line returned to the queue
    undo();
    expect(page().activeLineN).toBe(2); // and is placed again
    redo();
    expect(page().activeLineN).toBe(1);
  });
});

// A new free-typed box is one gesture — created, typed into, committed. It
// costs one undo press, or none at all when the user types nothing.
describe('one gesture, one step', () => {
  it('undoes a typed-into new box, text and all, in one press', () => {
    const id = addEmptyBox(300, 300);
    endEdit('hi', '');
    expect(page().boxes.length).toBe(3);
    undo();
    expect(page().boxes.length).toBe(2);
    expect(history.canUndo).toBe(false);
    redo();
    expect(page().boxes.map((b) => b.id)).toContain(id);
    expect(page().boxes[2].text).toBe('hi');
  });

  it('leaves the history untouched when a new box is abandoned empty', () => {
    addEmptyBox(300, 300);
    endEdit('', '');
    expect(page().boxes.length).toBe(2);
    expect(history.canUndo).toBe(false);
  });

  // The ordinary way to leave a box: click another one, or the canvas. Both
  // null `editingId` on pointerdown, so the blur that follows reaches `endEdit`
  // with nothing to end — the gesture has to be settled from those paths too,
  // or the box stays pending forever and its eventual delete goes unrecorded.
  it('records a new box left by clicking another one', () => {
    const id = addEmptyBox(300, 300);
    page().boxes[2].text = 'real';
    selectBox('b1'); // pointerdown elsewhere
    endEdit('real', ''); // the late blur, with editingId already null
    expect(history.canUndo).toBe(true);
    resetHistory();
    deleteBox(id);
    expect(history.canUndo).toBe(true);
    undo();
    const back = page().boxes.find((b) => b.id === id);
    expect(back?.text).toBe('real');
  });

  it('records a new box left by clicking the canvas', () => {
    const id = addEmptyBox(300, 300);
    page().boxes[2].text = 'real';
    deselect();
    resetHistory();
    deleteBox(id);
    undo();
    expect(page().boxes.map((b) => b.id)).toContain(id);
  });

  it('still records the removal of an existing box emptied out', () => {
    const id = addEmptyBox(300, 300);
    endEdit('hi', '');
    resetHistory();
    beginEdit(id);
    endEdit('  ', 'hi'); // whitespace only — the store drops the box
    expect(page().boxes.length).toBe(2);
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes.map((b) => b.id)).toContain(id);
  });
});

// The editable writes `box.text` on every keystroke, so what the history needs
// from an inline edit is not the text — the document already has it — but one
// entry per session, written by whatever ends the session.
describe('one inline edit, one step', () => {
  it('records an edit ended by clicking another box, where the blur is too late', () => {
    beginEdit('b1');
    page().boxes[0].text = 'changed';
    selectBox('b2'); // pointerdown elsewhere nulls editingId…
    endEdit('changed'); // …so the blur that follows has nothing left to end
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes[0].text).toBe('one');
    redo();
    expect(page().boxes[0].text).toBe('changed');
  });

  it('records it once for the session, not once per keystroke', () => {
    beginEdit('b1');
    for (const t of ['o', 'on', 'once']) page().boxes[0].text = t;
    deselect();
    undo();
    expect(page().boxes[0].text).toBe('one');
    expect(history.canUndo).toBe(false);
  });

  // The box carries the double-click that opens the edit and the editable
  // inside it has no handler of its own, so double-clicking a word to select it
  // re-enters `beginEdit` on the box already being edited.
  it('keeps the text the session began with when the box is double-clicked again', () => {
    beginEdit('b1');
    page().boxes[0].text = 'half';
    beginEdit('b1');
    page().boxes[0].text = 'whole';
    deselect();
    undo();
    expect(page().boxes[0].text).toBe('one');
  });

  it('leaves the history alone when the box was opened and nothing typed', () => {
    beginEdit('b1');
    deselect();
    expect(history.canUndo).toBe(false);
  });

  // The other half of the same gesture: a box created and typed into is one
  // press, and the text must not be counted a second time beside the placement.
  it('does not count a new box and its first text as two steps', () => {
    const id = addEmptyBox(300, 300);
    page().boxes[2].text = 'real';
    deselect();
    undo();
    expect(page().boxes.map((b) => b.id)).not.toContain(id);
    expect(history.canUndo).toBe(false);
  });
});

describe('selection follows the step', () => {
  // The step selects, selecting ends an inline edit, and ending one settles a
  // placement — which records. If that record reached the stack mid-step it
  // would clear the redo entry the step had just pushed, and the undo the user
  // just pressed could not be redone.
  it('leaves the redo stack alone when a step fires mid-edit', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    addEmptyBox(300, 300); // a gesture in progress on another box
    undo();
    expect(history.canRedo).toBe(true);
    expect(history.canUndo).toBe(false);
    redo();
    expect(page().boxes[0].x).toBe(5);
  });

  it('drops the selection with the box, and takes it back on redo', () => {
    placeActiveAt(400, 400);
    const id = page().boxes[2].id;
    expect(app.selectedId).toBe(id);
    undo();
    expect(app.selectedId).toBe(null);
    redo();
    expect(app.selectedId).toBe(id);
  });

  it('selects the box an undone delete brings back', () => {
    deleteBox('b1');
    expect(app.selectedId).toBe(null);
    undo();
    expect(app.selectedId).toBe('b1');
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
    // Strict: `toEqual` would call a property whose value is `undefined` equal
    // to no property at all, which is the one shape that does not survive.
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });

  it('detaches a store-produced record from the box it describes', () => {
    placeActiveAt(400, 400);
    const b = page().boxes[2];
    b.x = 777;
    b.style.size = 99;
    const rec = peekStack().undo[0];
    expect(rec.box.x).toBe(400 - 110); // where it was placed, not where it now is
    expect(rec.box.style.size).not.toBe(99);
  });

  it('copies what it is handed, so a later mutation cannot rewrite history', () => {
    const before = { x: 1, y: 2 };
    record({ t: 'move', pageId: 1, boxId: 'b1', before, after: { x: 9, y: 9 } });
    before.x = 999;
    undo();
    expect(page().boxes[0].x).toBe(1);
  });
});

// Dragging a slider and pressing undo is how anyone rejects a change, and it
// lands inside the window in which the change has been applied and not yet
// recorded. Stepping over it would rewind the entry beneath it, leave the
// unwanted change standing, and then let the settle clear the redo the step had
// just pushed — no way forward and no way back.
describe('a step closes an open settle window first', () => {
  const settlesTo99 = () =>
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 10, y: 10 }, after: { x: 99, y: 99 } });

  it('records what is still settling, then steps that very entry', () => {
    setEditSettleHook(settlesTo99);
    try {
      page().boxes[0].x = 99; // applied to the document, not yet recorded
      undo();
      expect(page().boxes[0].x).toBe(10);
      expect(history.canRedo).toBe(true);
    } finally {
      setEditSettleHook(null);
    }
  });

  it('settles before a redo too, so a change made since cannot be stepped past', () => {
    page().boxes[1].x = 60;
    record({ t: 'move', pageId: 1, boxId: 'b2', before: { x: 50, y: 50 }, after: { x: 60, y: 60 } });
    undo();
    expect(page().boxes[1].x).toBe(50);
    expect(history.canRedo).toBe(true);
    setEditSettleHook(settlesTo99);
    try {
      page().boxes[0].x = 99; // a new edit, still settling
      redo();
      // Recording that edit is what clears the redo stack; settling first is
      // what makes it happen before the redo rather than on top of one already
      // taken, where it would have left the user with neither direction.
      expect(page().boxes[1].x).toBe(50);
      expect(history.canRedo).toBe(false);
      expect(history.canUndo).toBe(true);
    } finally {
      setEditSettleHook(null);
    }
  });
});
