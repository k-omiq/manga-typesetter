import { describe, it, expect, beforeEach } from 'vitest';
import {
  app,
  loadProjectPages,
  deleteBox,
  duplicateBox,
  placeActiveAt,
  addEmptyBox,
  beginEdit,
  endEdit,
  selectBox,
  deselect,
  page,
  gotoPage,
  setEditSettleHook,
  boxText,
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
  setOffscreenSink,
  setHistorySink,
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

  it('undoes and redoes a resize that changed autoHeight, updating style.autoHeight directly', () => {
    const b = page().boxes[0];
    b.style.autoHeight = false;
    record({
      t: 'resize',
      pageId: 1,
      boxId: 'b1',
      before: { x: 10, y: 10, w: 100, h: 40, size: 20, autoHeight: true },
      after: { x: 10, y: 10, w: 100, h: 80, size: 20, autoHeight: false },
    });
    undo();
    expect(b.style.autoHeight).toBe(true);
    expect(b.autoHeight).toBeUndefined();
    expect(b.h).toBe(40);
    redo();
    expect(b.style.autoHeight).toBe(false);
    expect(b.autoHeight).toBeUndefined();
    expect(b.h).toBe(80);
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

  // An entry belongs to one page, and a bulk entry is no exception. It used to
  // resolve each item through the item's own page id so that a chapter-wide tag
  // apply could be undone from wherever it was pressed - which meant an entry on
  // page A's stack mutating boxes on page B while B kept a stack of its own
  // whose before/after still described the world before the apply. B's next undo
  // then restored a style it had not been in since. The writer splits such an
  // apply into one entry per page now, so the reader can hold the line.
  const twoPageDoc = () => {
    const pages = doc();
    pages.push({
      id: 2,
      w: 800,
      h: 1200,
      lines: [],
      boxes: [{ id: 'b3', lineN: null, text: 'three', x: 10, y: 10, w: 100, h: 40, style: null }],
    });
    return pages;
  };

  it('walks only the boxes on the page the entry names', () => {
    loadProjectPages(twoPageDoc());
    app.pages[1].boxes[0].style.size = 30;
    record({
      t: 'bulk',
      pageId: 1,
      items: [
        { boxId: 'b1', pageId: 1, before: { size: 10 }, after: { size: 30 } },
        // A writer that has regressed. Skipped rather than applied: page 2 keeps
        // its own stack, and reaching into it from here is the desync.
        { boxId: 'b3', pageId: 2, before: { size: 14 }, after: { size: 30 } },
      ],
    });
    undo();
    expect(app.pages[0].boxes[0].style.size).toBe(10);
    expect(app.pages[1].boxes[0].style.size).toBe(30);
  });

  // And the page being gone is a different failure from the boxes being gone -
  // the user is told which.
  it('says the page is gone rather than blaming the boxes', () => {
    loadProjectPages(twoPageDoc());
    record({
      t: 'bulk',
      pageId: 99,
      items: [{ boxId: 'b1', pageId: 99, before: { size: 10 }, after: { size: 30 } }],
    });
    undo();
    expect(app.toast.msg).toMatch(/the page is gone/i);
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

  it('keeps queue position when a delete is undone', () => {
    placeActiveAt(400, 400);
    const id = page().boxes[2].id;
    deleteBox(id);
    expect(page().activeLineN).toBe(2); // the line did not return to the queue
    undo();
    expect(page().activeLineN).toBe(2); // box restored, queue remains on 2
    redo();
    expect(page().activeLineN).toBe(2);
  });

  it('marks line unplaced when a place is undone, and placed again on redo', () => {
    placeActiveAt(400, 400);
    expect(page().lines.find((l) => l.n === 1).placed).toBe(true);
    undo();
    expect(page().lines.find((l) => l.n === 1).placed).toBe(false);
    redo();
    expect(page().lines.find((l) => l.n === 1).placed).toBe(true);
  });
});

// A new free-typed box is one gesture - created, typed into, committed. It
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
    // The text is on the box's queue line, not on the box - a free-typed box is
    // line-backed like any other now (see `setBoxText`), and the redo has to
    // bring the line back with it or the box returns rendering nothing.
    const back = page().boxes.find((b) => b.id === id);
    expect(back.text).toBe(null);
    expect(boxText(back)).toBe('hi');
  });

  it('leaves the history untouched when a new box is abandoned empty', () => {
    addEmptyBox(300, 300);
    endEdit('', '');
    expect(page().boxes.length).toBe(2);
    expect(history.canUndo).toBe(false);
  });

  // The ordinary way to leave a box: click another one, or the canvas. Both
  // null `editingId` on pointerdown, so the blur that follows reaches `endEdit`
  // with nothing to end - the gesture has to be settled from those paths too,
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
    endEdit('real', '');
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
    endEdit('  ', 'hi'); // whitespace only - the store drops the box
    expect(page().boxes.length).toBe(2);
    expect(history.canUndo).toBe(true);
    undo();
    expect(page().boxes.map((b) => b.id)).toContain(id);
  });
});

// A free-typed box and its queue line are one thing: the box brings the line
// into existence and takes it away again. The history has to move both or the
// user is left with a box rendering nothing (its text lives on that line) or an
// unplaceable blank row nothing can remove.
describe('a free-typed box and its line move together', () => {
  const freeLines = () => page().lines.filter((l) => l.n < 0);

  it('takes the line back out when the placement is undone, and brings it back on redo', () => {
    const id = addEmptyBox(300, 300);
    endEdit('BOOM');
    expect(freeLines()).toHaveLength(1);
    undo();
    expect(freeLines()).toHaveLength(0);
    redo();
    expect(freeLines()).toHaveLength(1);
    // Brought back with its text, which is the only place that text ever was.
    expect(boxText(page().boxes.find((b) => b.id === id))).toBe('BOOM');
  });

  it('brings the line back when the deletion is undone, where it sat', () => {
    const id = addEmptyBox(300, 300);
    endEdit('BOOM');
    resetHistory();
    deleteBox(id);
    expect(freeLines()).toHaveLength(0);
    undo();
    expect(page().lines.map((l) => l.n)).toEqual([1, 2, -1]);
    expect(boxText(page().boxes.find((b) => b.id === id))).toBe('BOOM');
    redo();
    expect(freeLines()).toHaveLength(0);
  });

  // A duplicate is the same gesture by another route: one box, one free line,
  // one press of undo taking both.
  it('takes a duplicate and its line back in one step', () => {
    const id = addEmptyBox(300, 300);
    endEdit('BOOM');
    resetHistory();
    const copy = duplicateBox(id);
    expect(page().boxes).toHaveLength(4);
    expect(freeLines()).toHaveLength(2);
    undo();
    expect(page().boxes.some((b) => b.id === copy)).toBe(false);
    expect(freeLines()).toHaveLength(1);
    // The original is untouched, text and all.
    expect(boxText(page().boxes.find((b) => b.id === id))).toBe('BOOM');
    redo();
    expect(boxText(page().boxes.find((b) => b.id === copy))).toBe('BOOM');
  });

  // An entry about a queue-placed box carries no line at all, so the ordinary
  // path is untouched - an imported line must survive its box either way.
  it('leaves an imported line alone', () => {
    placeActiveAt(400, 400);
    const id = page().boxes.at(-1).id;
    deleteBox(id);
    undo();
    expect(page().lines.map((l) => l.n)).toEqual([1, 2]);
  });

  // The text of a free box lives on its line. Rewound onto `box.text` instead,
  // the undo would leave the old text as a box-level override sitting over the
  // new text still standing on the line, with no gesture that could put the two
  // back in step.
  it('rewinds a text edit into the line, not onto the box', () => {
    const id = addEmptyBox(300, 300);
    endEdit('first');
    resetHistory();
    beginEdit(id);
    endEdit('second');
    undo();
    const b = page().boxes.find((x) => x.id === id);
    expect(b.text).toBe(null);
    expect(boxText(b)).toBe('first');
    redo();
    expect(boxText(page().boxes.find((x) => x.id === id))).toBe('second');
  });
});

// Two edits, one click: the click that places a queued box is also what ends the
// free-typed box the user was still in. The pair has to land in the order the
// user made them. The settle used to ride on the `selectBox` at the bottom of
// `placeActiveAt`, which put the older edit onto the stack on top of the newer
// one - so the first press of undo rewound the box the user had finished with
// while the one the click had just placed stayed put.
describe('a placement that ends another edit records the pair in order', () => {
  it('records the edit it ended before the placement it made', () => {
    const typed = addEmptyBox(300, 300);
    page().boxes.find((b) => b.id === typed).text = 'typed';
    placeActiveAt(400, 400);
    const placed = page().boxes.find((b) => b.lineN === 1).id;
    // Newest first: the box this click placed is what the first press takes.
    undo();
    expect(page().boxes.map((b) => b.id)).not.toContain(placed);
    expect(page().boxes.map((b) => b.id)).toContain(typed);
    undo();
    expect(page().boxes.map((b) => b.id)).not.toContain(typed);
  });
});

// The page turn used to run `clearPending`, which threw the gesture away: the
// box stayed on the page and the `place` record standing for it was never
// written, so turning the page mid-typing cost the user one undo step and left
// them a box that could not be rewound.
describe('a page turn mid-gesture keeps its step', () => {
  const twoPages = () => [
    { id: 1, w: 800, h: 1200, lines: [], boxes: [] },
    { id: 2, w: 800, h: 1200, lines: [], boxes: [] },
  ];

  it('records the free-typed box rather than dropping it', () => {
    loadProjectPages(twoPages());
    const id = addEmptyBox(300, 300);
    page().boxes.find((b) => b.id === id).text = 'typed';
    gotoPage(1);
    expect(history.canUndo).toBe(true);
    gotoPage(0);
    undo();
    expect(page().boxes.map((b) => b.id)).not.toContain(id);
  });

  // And it leaves nothing behind to settle twice: a second turn with the gesture
  // already recorded must not write the same entry again.
  it('settles the gesture once, not once per page turn', () => {
    loadProjectPages(twoPages());
    const id = addEmptyBox(300, 300);
    page().boxes.find((b) => b.id === id).text = 'typed';
    gotoPage(1);
    gotoPage(0);
    gotoPage(1);
    undo();
    expect(history.canUndo).toBe(false);
  });
});

// The editable writes `box.text` on every keystroke, so what the history needs
// from an inline edit is not the text - the document already has it - but one
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
  // Two things have to hold at once here, and they pull in opposite directions.
  // The gesture still in progress has to be settled BEFORE the step, or the
  // press rewinds the move underneath it while the box the user was still typing
  // into stands - the newest edit is the one they meant, which is the whole
  // reason `undo` settles first. And the record must not reach the stack DURING
  // the step, where it would clear the redo entry the step had just pushed and
  // leave the press with no way back; `applying` is what covers that, and it has
  // to stay raised for the whole of `step` because the step selects, selecting
  // ends an inline edit, and ending one settles a placement.
  it('settles the gesture in progress and steps that, keeping the redo', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    const id = addEmptyBox(300, 300); // a gesture in progress on another box
    undo();
    expect(page().boxes.map((b) => b.id)).not.toContain(id); // the newest edit went
    expect(page().boxes[0].x).toBe(10); // …and the move beneath it was not touched
    expect(history.canRedo).toBe(true);
    expect(history.canUndo).toBe(true); // the move is still there for the next press
    redo();
    expect(page().boxes.map((b) => b.id)).toContain(id);
    undo();
    undo();
    expect(page().boxes[0].x).toBe(0); // now the move, one press later
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
    undo(); // the ghost - refused and dropped
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

  // The seam that stops an entry crossing a page boundary. Pushing an entry that
  // names another page onto the live stack is the desync: it would rewind boxes
  // on a page keeping its own stack, whose before/after still describe the world
  // before this entry. The history file takes such an entry instead and merges
  // it under its own page's key, without ever touching the live stack.
  describe('an entry naming a page that is not the live one', () => {
    const other = () => ({ t: 'move', pageId: 2, boxId: 'b9', before: { x: 0 }, after: { x: 1 } });

    // Every entry with a page id is offered, because this module cannot tell
    // which page is live - the history file can, and answering is its whole job.
    it('goes to the sink instead of the live stack', () => {
      const taken = [];
      const off = setOffscreenSink((pageId, entry) => {
        if (pageId === 1) return false; // stands in for "that is the live page"
        taken.push([pageId, entry.t]);
        return true;
      });
      try {
        record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0 }, after: { x: 5 } });
        record(other());
        expect(taken).toEqual([[2, 'move']]);
        // Only the page-1 entry. The stack the user is standing on is untouched
        // by an edit that did not happen on their page.
        expect(peekStack().undo).toHaveLength(1);
        expect(peekStack().undo[0].pageId).toBe(1);
      } finally {
        off();
      }
    });

    it('is detached before the sink ever sees it', () => {
      let held = null;
      const off = setOffscreenSink((_pageId, entry) => {
        held = entry;
        return true;
      });
      const before = { x: 0 };
      try {
        record({ t: 'move', pageId: 2, boxId: 'b9', before, after: { x: 1 } });
        before.x = 999;
        expect(held.before.x).toBe(0);
      } finally {
        off();
      }
    });

    it('stays on the live stack when the sink refuses it', () => {
      // What a build with no history file does, and what the file itself answers
      // for a chapter it has no document for: nobody else can keep this, so the
      // live stack does - which is what it did before the seam existed.
      const off = setOffscreenSink(() => false);
      try {
        record(other());
        expect(peekStack().undo).toHaveLength(1);
      } finally {
        off();
      }
    });
  });
});

// The next task writes these entries to a file as JSON, so anything a mutation
// site records has to survive the round trip unchanged - no proxies, no
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

// A step moves the stack, and the stack is what the history file writes. The
// document's own autosave runs for the same press, so a step that told the file
// nothing left the two to reach disk 800ms apart describing different numbers of
// edits - chapter.json past the undo, history.json still before it. A crash in
// between and the next press replays an entry against a document it was never
// recorded against.
describe('a step schedules the journal', () => {
  const seen = [];
  const move = (n) =>
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: n, y: 0 }, after: { x: n + 1, y: 0 } });

  const withSink = (fn) => {
    seen.length = 0;
    const off = setHistorySink((pageId) => seen.push(pageId));
    try {
      fn();
    } finally {
      off();
    }
  };

  it('tells the file on undo, and again on redo', () => {
    withSink(() => {
      move(0);
      seen.length = 0; // the record's own notification is not what this is about
      undo();
      expect(seen).toEqual([1]);
      redo();
      expect(seen).toEqual([1, 1]);
    });
  });

  // A step that cannot apply drops its entry, so the stack has changed there
  // too - left unwritten, the file would keep offering an entry this build has
  // already refused once.
  it('tells it about an entry it had to drop as well', () => {
    withSink(() => {
      record({ t: 'move', pageId: 1, boxId: 'ghost', before: { x: 0 }, after: { x: 9 } });
      seen.length = 0;
      expect(undo()).toBe(false);
      expect(seen).toEqual([1]);
    });
  });

  // Nothing moved, nothing to write.
  it('says nothing when there was no step to take', () => {
    withSink(() => {
      expect(undo()).toBe(false);
      expect(redo()).toBe(false);
      expect(seen).toEqual([]);
    });
  });

  // The page whose stack this is, not the page the entry names. They are the
  // same for every entry the live stack should be holding, and when they are
  // not - an entry for a page that has since gone, which is exactly the kind
  // that lands in the failure branch - handing the file that dead page's id
  // would file the live page's whole stack under it.
  it('names the live page even when the entry names one that is gone', () => {
    withSink(() => {
      loadStack(1, {
        undo: [{ t: 'move', pageId: 99, boxId: 'b1', before: { x: 0 }, after: { x: 9 } }],
        redo: [],
      });
      undo();
      expect(seen).toEqual([1]);
    });
  });
});

// Dragging a slider and pressing undo is how anyone rejects a change, and it
// lands inside the window in which the change has been applied and not yet
// recorded. Stepping over it would rewind the entry beneath it, leave the
// unwanted change standing, and then let the settle clear the redo the step had
// just pushed - no way forward and no way back.
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
