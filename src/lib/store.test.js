import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app,
  loadProjectPages,
  addEmptyBox,
  beginEdit,
  byId,
  clampSidebarWidth,
  flushSave,
  markUnsaved,
  markSaved,
  sidebarFromJSON,
  saveSidebar,
  flushSidebar,
  endEdit,
  deselect,
  settleEdits,
  recordEdit,
  placeActiveAt,
  activateLine,
  toggleTagOnLine,
  setSaver,
  setRecorder,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  PREF_SAVE_MS,
  DOC_SAVE_MS,
  setPageSwitchHook,
  setEditSettleHook,
  gotoPage,
  page,
  setTool,
  TOOLS,
  setZoom,
  applyFit,
  zoomIn,
  zoomOut,
  zoomReset,
  ZOOM_STOPS,
  ZOOM_MIN,
  ZOOM_MAX,
  BULK_PROPS,
  bulkTicked,
  setBulkProp,
  tickBulkProp,
  mergeMasked,
  openBulk,
  closeBulk,
  applyBulk,
  applyBulkToTag,
  toggleBulkTarget,
  hasPageSpace,
  pageForSrc,
  setPageDims,
  setPageDimsForSrc,
  applyDetection,
  boxText,
  deleteBox,
  isPlaced,
  firstUnplaced,
  visiblePageCenter,
  PAGE_W,
  PAGE_H,
  detectedRectFor,
  placementRect,
  CHAPTER_MODES,
  normalizeChapterMode,
  isTranslateMode,
  isTranslated,
  translatedCount,
  rawZoomBy,
  rawZoomIn,
  rawZoomOut,
  RAW_ZOOM_MAX,
  LAYOUTS,
  normalizeLayout,
  isLongstrip,
  focusPage,
} from './store.svelte.js';
import { defaultStyle } from './data.js';
import { loadTags, lineTags } from './tags.svelte.js';

const pageWith = (boxes) => ({
  id: 1,
  w: 800,
  h: 1200,
  lines: [],
  boxes,
});
const box = (id, extra = {}) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, ...extra });

// Both id counters are module globals that only ever climb and are never reset,
// so a case that needs to know what the next minted id will be has to ask at
// call time. Hard-coding a base passes only while the file happens to run in
// written order, and vitest is free to shuffle it.
const nextBoxSeq = () => {
  loadProjectPages([pageWith([])]);
  return Number(addEmptyBox(0, 0).slice(1)) + 1;
};
const nextPageSeq = () => {
  loadProjectPages([{ ...pageWith([]), id: null }]);
  return app.pages[0].id + 1;
};

describe('loadProjectPages box identity', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('keeps ids that came off disk', () => {
    loadProjectPages([pageWith([box('b7'), box('b9')])]);
    expect(app.pages[0].boxes.map((b) => b.id)).toEqual(['b7', 'b9']);
  });

  it('mints a fresh id for a box that has none', () => {
    loadProjectPages([pageWith([box('b3'), box(undefined)])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b3');
    expect(ids[1]).toMatch(/^b\d+$/);
    expect(ids[1]).not.toBe('b3');
  });

  it('remints a duplicate id rather than loading two boxes that answer to it', () => {
    loadProjectPages([pageWith([box('b4'), box('b4')])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b4');
    expect(ids[1]).not.toBe('b4');
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints an id a kept box already owns, across pages', () => {
    const base = nextBoxSeq() + 40;
    loadProjectPages([
      { ...pageWith([box(undefined)]), id: 1 },
      { ...pageWith([box(`b${base}`)]), id: 2 },
    ]);
    expect(app.pages[0].boxes[0].id).toBe(`b${base + 1}`);
    expect(app.pages[1].boxes[0].id).toBe(`b${base}`);
  });

  it('seeds the counter so a box added after the load cannot collide', () => {
    const base = nextBoxSeq() + 100;
    loadProjectPages([pageWith([box(`b${base}`)])]);
    expect(addEmptyBox(100, 100)).toBe(`b${base + 1}`);
  });
});

describe('loadProjectPages page identity', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('keeps page ids that came off disk', () => {
    loadProjectPages([
      { ...pageWith([]), id: 3 },
      { ...pageWith([]), id: 8 },
    ]);
    expect(app.pages.map((p) => p.id)).toEqual([3, 8]);
  });

  it('remints a duplicate page id rather than loading two pages that answer to it', () => {
    loadProjectPages([
      { ...pageWith([]), id: 3 },
      { ...pageWith([]), id: 3 },
    ]);
    const ids = app.pages.map((p) => p.id);
    expect(ids[0]).toBe(3);
    expect(ids[1]).not.toBe(3);
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints a page id a kept page already owns', () => {
    const base = nextPageSeq() + 40;
    loadProjectPages([
      { ...pageWith([]), id: null },
      { ...pageWith([]), id: base },
    ]);
    expect(app.pages.map((p) => p.id)).toEqual([base + 1, base]);
  });
});

// chapter.json is a file on the user's disk, and `line.tags` used to be copied
// out of it verbatim. Two hand-edited shapes did not merely read oddly: a
// duplicate throws Svelte's `each_key_duplicate` in the queue's keyed `{#each}`
// and the panel stops rendering, and a name in a spelling the app would never
// have written renders a chip whose click adds a second tag rather than removing
// the first.
describe('loadProjectPages tag sanitising', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  const withTags = (tags) =>
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'dialogue', en: 'a', tags }] }]);
  const tagsOf = () => app.pages[0].lines[0].tags;

  it('drops a duplicate rather than letting the queue throw on it', () => {
    withTags(['sfx', 'sfx']);
    expect(tagsOf()).toEqual(['sfx']);
  });

  it('folds a name to the one spelling every other write uses', () => {
    withTags(['SFX', '  Narration  ']);
    expect(tagsOf()).toEqual(['sfx', 'narration']);
  });

  it('counts two spellings of one name as one tag', () => {
    withTags(['sfx', 'SFX']);
    expect(tagsOf()).toEqual(['sfx']);
  });

  it('drops what is not a name at all, and keeps what is', () => {
    withTags([null, 42, '', '   ', { name: 'sfx' }, 'narration']);
    expect(tagsOf()).toEqual(['narration']);
  });

  // The array's *presence* is what tells `lineTags` the user has taken over from
  // the legacy `line.type`. A `tags` that is not an array never said that, so it
  // goes rather than becoming an empty array that silently means "no tags".
  it('drops a tags field that is not an array, leaving the legacy type in charge', () => {
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'sfx', en: 'a', tags: 'sfx' }] }]);
    expect('tags' in app.pages[0].lines[0]).toBe(false);
  });

  it('leaves a line that was never tagged untouched', () => {
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'sfx', en: 'a' }] }]);
    expect('tags' in app.pages[0].lines[0]).toBe(false);
  });
});

describe('loadProjectPages repair count', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('reports nothing to repair when every id on disk is usable', () => {
    expect(loadProjectPages([pageWith([box('b7'), box('b9')])])).toBe(0);
  });

  it('counts every id it had to mint, boxes and pages alike', () => {
    const repaired = loadProjectPages([
      { ...pageWith([box('b7'), box('b7')]), id: 3 },
      { ...pageWith([box(undefined)]), id: 3 },
    ]);
    expect(repaired).toBe(3);
  });
});

// The seam the history file hangs off: only the page on screen keeps its undo
// stack in memory, so a page turn has to say which page it left and which it
// arrived at. The store itself knows nothing about either.
describe('the page switch hook', () => {
  it('names both pages, and says nothing when the page did not change', () => {
    loadProjectPages([{ ...pageWith([]), id: 1 }, { ...pageWith([]), id: 2 }]);
    const seen = [];
    setPageSwitchHook((from, to) => seen.push([from, to]));
    try {
      gotoPage(1);
      gotoPage(1); // already there - nothing to hand over
      gotoPage(9); // out of range - refused before anything moves
      gotoPage(0);
      expect(seen).toEqual([
        [1, 2],
        [2, 1],
      ]);
    } finally {
      setPageSwitchHook(null);
    }
  });

  // An entry still inside a settle window belongs to the page being left, and
  // the live stack is the only place it can be pushed - `recordEdit` has no
  // page awareness of its own. A settle that ran a step later would land on the
  // page being arrived at, and the next write would file that page's entries
  // under this one's key.
  it('settles a pending edit while the page being left is still the live one', () => {
    loadProjectPages([{ ...pageWith([]), id: 1 }, { ...pageWith([]), id: 2 }]);
    const seen = [];
    setEditSettleHook(() => seen.push(page().id));
    try {
      gotoPage(1);
      expect(seen).toEqual([1]);
    } finally {
      setEditSettleHook(null);
    }
  });
});

// One slot each is fine right up until a second listener wants the same seam:
// the second registration displaced the first silently, so a panel that
// coalesces its edits would have taken the Inspector's settle away and neither
// of them would have said a word - the Inspector's edits would simply have
// stopped being recorded. The page-switch seam stands in for all four; they are
// one implementation.
describe('the hook seams take more than one subscriber', () => {
  const twoPages = () => [
    { ...pageWith([]), id: 1 },
    { ...pageWith([]), id: 2 },
  ];

  it('fires every subscriber, in the order they registered', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook((from, to) => seen.push(['a', from, to]));
    const offB = setPageSwitchHook((from, to) => seen.push(['b', from, to]));
    try {
      gotoPage(1);
      expect(seen).toEqual([
        ['a', 1, 2],
        ['b', 1, 2],
      ]);
    } finally {
      offA();
      offB();
    }
  });

  it('unsubscribes exactly one, leaving the rest standing', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook(() => seen.push('a'));
    const offB = setPageSwitchHook(() => seen.push('b'));
    try {
      offA();
      gotoPage(1);
      expect(seen).toEqual(['b']);
    } finally {
      offB();
    }
  });

  // Identity is the registration, not the function. Two panels that happened to
  // register the same callback are two subscribers, and releasing one must not
  // take the other with it.
  it('counts the same function registered twice as two subscribers', () => {
    loadProjectPages(twoPages());
    let n = 0;
    const bump = () => n++;
    const offA = setPageSwitchHook(bump);
    const offB = setPageSwitchHook(bump);
    try {
      offA();
      gotoPage(1);
      expect(n).toBe(1);
    } finally {
      offB();
    }
  });

  // A component's teardown can run twice - a release that removed "one entry"
  // each time would eat a subscriber that had nothing to do with it.
  it('does nothing on a second release', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook(() => seen.push('a'));
    const offB = setPageSwitchHook(() => seen.push('b'));
    try {
      offA();
      offA();
      gotoPage(1);
      expect(seen).toEqual(['b']);
    } finally {
      offB();
    }
  });

  // A blunt teardown, and the only caller left is a test suite: every
  // registration in src/ holds its unsubscribe and calls that instead. Kept
  // because the suites lean on it to stop a hook registered for one case leaking
  // into the next, and pinned here because the behaviour is a hazard worth
  // knowing about - `setSaver(null)` unhooks every autosave in the app.
  it('clears the seam outright when handed something that is not a function', () => {
    loadProjectPages(twoPages());
    const seen = [];
    setPageSwitchHook(() => seen.push('a'));
    setPageSwitchHook(() => seen.push('b'));
    setPageSwitchHook(null);
    gotoPage(1);
    expect(seen).toEqual([]);
  });

  it('runs every settle subscriber before the page turns', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setEditSettleHook(() => seen.push(['a', page().id]));
    const offB = setEditSettleHook(() => seen.push(['b', page().id]));
    try {
      gotoPage(1);
      expect(seen).toEqual([
        ['a', 1],
        ['b', 1],
      ]);
    } finally {
      offA();
      offB();
    }
  });
});

// Pre-existing: the page turn ran `clearPending`, which threw the in-flight
// gesture away rather than settling it - so the record standing for what the
// user had just typed was never written, and turning the page mid-edit cost them
// an undo step. The ordering is the load-bearing half: the record has to be
// pushed while the page being left still owns the live stack, a step ahead of
// the switch hook handing that stack to the history file.
describe('a page turn ends the inline edit it interrupts', () => {
  const twoPages = (boxes = []) => [
    { ...pageWith(boxes), id: 1 },
    { ...pageWith([]), id: 2 },
  ];

  it('records the free-typed box before the switch hook fires', () => {
    loadProjectPages(twoPages());
    const log = [];
    const offRec = setRecorder((e) => log.push(['record', e.t, e.pageId]));
    const offSwitch = setPageSwitchHook((from, to) => log.push(['switch', from, to]));
    try {
      const id = addEmptyBox(100, 100);
      byId(id).text = 'typed';
      gotoPage(1);
      expect(log).toEqual([
        ['record', 'place', 1],
        ['switch', 1, 2],
      ]);
    } finally {
      offRec();
      offSwitch();
    }
  });

  it('records an edit to a box that was already there the same way', () => {
    loadProjectPages(twoPages([box('b1')]));
    const log = [];
    const offRec = setRecorder((e) => log.push(['record', e.t, e.before, e.after]));
    const offSwitch = setPageSwitchHook(() => log.push(['switch']));
    try {
      beginEdit('b1');
      byId('b1').text = 'changed';
      gotoPage(1);
      expect(log).toEqual([['record', 'text', 'x', 'changed'], ['switch']]);
    } finally {
      offRec();
      offSwitch();
    }
  });

  // Nothing is left pending on the page behind: a second turn must not write the
  // same entry again, and the box must not still look like a gesture in progress
  // - that is what used to suppress the record of its own deletion.
  it('leaves nothing behind to settle a second time', () => {
    loadProjectPages(twoPages());
    const log = [];
    const off = setRecorder((e) => log.push(e.t));
    try {
      const id = addEmptyBox(100, 100);
      byId(id).text = 'typed';
      gotoPage(1);
      gotoPage(0);
      gotoPage(1);
      expect(log).toEqual(['place']);
      expect(app.editingId).toBe(null);
    } finally {
      off();
    }
  });
});

// `settleText` used to clear the before-text on the way in, which made a second
// settle record nothing - by forgetting rather than by having nothing left to
// say. Any caller that settled while the session continued then disabled
// recording for the rest of it, because `endEdit`'s guard is
// `before !== undefined`. The live path was a failed save on the way out of the
// editor: it throws instead of closing the chapter, so the user is bounced back
// in with the caret still open and the before-text gone, and nothing they type
// afterwards is ever recorded.
describe('a settle in the middle of a live edit session', () => {
  const onePage = () => [{ ...pageWith([box('b1')]), id: 1 }];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(onePage());
  });

  it('records what came before it and what comes after it', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      byId('b1').text = 'xab';
      endEdit('xab');
      expect(log).toEqual([
        ['x', 'xa'],
        ['xa', 'xab'],
      ]);
    } finally {
      off();
    }
  });

  // Re-arming must not cost the idempotence the clearing bought: settling twice
  // with nothing typed in between is still one entry, not two, and not an entry
  // whose two sides are the same string.
  it('is still idempotent when nothing was typed in between', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      settleEdits();
      settleEdits();
      endEdit('xa');
      expect(log).toEqual([['x', 'xa']]);
    } finally {
      off();
    }
  });

  // Three settles, three runs of typing, three entries - each one starting where
  // the last left off, with no gap and no overlap.
  it('leaves no gap between one settled run and the next', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      byId('b1').text = 'xab';
      settleEdits();
      byId('b1').text = 'xabc';
      settleEdits();
      expect(log).toEqual([
        ['x', 'xa'],
        ['xa', 'xab'],
        ['xab', 'xabc'],
      ]);
    } finally {
      off();
    }
  });

  // Only the absence of a session clears it. A settle with no edit open must not
  // leave something armed that a later `endEdit` would record against.
  it('arms nothing when there is no edit open', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      settleEdits();
      byId('b1').text = 'zz';
      endEdit('zz');
      expect(log).toEqual([]);
    } finally {
      off();
    }
  });

  // The order the two halves of a settle run in, which nothing pinned before: a
  // panel's pending entry has been sitting in its settle window while the box on
  // the canvas was still being typed into, so it is the older of the two and has
  // to be recorded first. Flip the two lines in `settleEdits` and this fails.
  it('records a subscriber’s pending entry before its own inline edit', () => {
    const log = [];
    const offRec = setRecorder((e) => log.push(e.t));
    const offHook = setEditSettleHook(() =>
      recordEdit({ t: 'style', pageId: page().id, boxId: 'b1', before: {}, after: {} }),
    );
    try {
      beginEdit('b1');
      byId('b1').text = 'changed';
      settleEdits();
      expect(log).toEqual(['style', 'text']);
    } finally {
      offRec();
      offHook();
    }
  });
});

// Four writers used to carry four intervals, each picked on its own. Two tiers
// now, and the cases below pin each writer to the *duration* its tier names:
// spell `PREF_SAVE_MS` differently and every case here moves with it.
//
// What they cannot see, and it is worth being straight about since the comment
// here used to claim otherwise: `PREF_SAVE_MS - 1` is 199 by the time the test
// runs, so a writer that quietly went back to a hard-coded 200 passes. Nothing
// short of reading the source can tell those apart. What is actually pinned is
// that the two tiers stay ordered, and that each writer fires on the number its
// tier holds today - so changing that number cannot silently leave one writer
// behind on the old one.
describe('the persistence intervals', () => {
  it('keeps a preference well ahead of a document write', () => {
    expect(PREF_SAVE_MS).toBeLessThan(DOC_SAVE_MS);
  });

  // Async because the savers are started off a resolved promise, so that one
  // that throws synchronously still comes back as a rejection: the call lands a
  // microtask after the timer, not inside it.
  it('debounces the chapter autosave on the document interval', async () => {
    vi.useFakeTimers();
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    let saves = 0;
    const off = setSaver(() => {
      saves++;
      return Promise.resolve();
    });
    try {
      markUnsaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS - 1);
      expect(saves).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toBe(1);
    } finally {
      off();
      app.chapterRef = null;
      vi.useRealTimers();
    }
  });

  // Every path that writes the document ends by saying so, and the debounce
  // armed before it is still counting down towards a write of a document that
  // is already on disk. Harmless-looking, and not: on the way out of a chapter
  // the late write is aimed at whatever `app.chapterRef` has become by the time
  // it fires.
  it('cancels the pending autosave once the document has reached the disk', async () => {
    vi.useFakeTimers();
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    let saves = 0;
    const off = setSaver(() => {
      saves++;
      return Promise.resolve();
    });
    try {
      markUnsaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS - 1);
      markSaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS * 2);
      expect(saves).toBe(0);
    } finally {
      off();
      app.chapterRef = null;
      vi.useRealTimers();
    }
  });

  // The rail's arrow-key contract persists on every key that moved the edge, and
  // a held arrow auto-repeats. Unbuffered that was dozens of serialisations a
  // second for a string nobody reads until the next launch.
  it('coalesces a burst of sidebar writes into one, on the preference interval', () => {
    vi.useFakeTimers();
    let writes = 0;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => writes++ });
    try {
      saveSidebar();
      saveSidebar();
      saveSidebar();
      vi.advanceTimersByTime(PREF_SAVE_MS - 1);
      expect(writes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(writes).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// The read itself runs once at module load, in an environment with no
// `localStorage` at all - so the tests take the vetting the read delegates to,
// which is where anything can actually be wrong.
describe('sidebar geometry persistence', () => {
  it('clamps a width to the range the rail can drag to', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN - 500)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(SIDEBAR_MAX + 500)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('clamps a stored width the same way a dragged one is clamped', () => {
    expect(sidebarFromJSON('{"width":9999}')).toEqual({ width: SIDEBAR_MAX });
    expect(sidebarFromJSON('{"width":10}')).toEqual({ width: SIDEBAR_MIN });
    expect(sidebarFromJSON('{"width":300}')).toEqual({ width: 300 });
  });

  it('drops a width that is not a number rather than coercing it', () => {
    expect(sidebarFromJSON('{"width":"300"}')).toEqual({});
    expect(sidebarFromJSON('{"width":null}')).toEqual({});
  });

  it('drops a hidden flag that is not a boolean', () => {
    expect(sidebarFromJSON('{"hidden":"yes"}')).toEqual({});
    expect(sidebarFromJSON('{"hidden":true}')).toEqual({ hidden: true });
    expect(sidebarFromJSON('{"hidden":false}')).toEqual({ hidden: false });
  });

  it('reads nothing out of a blob that is not an object', () => {
    expect(sidebarFromJSON('not json')).toEqual({});
    expect(sidebarFromJSON('null')).toEqual({});
    expect(sidebarFromJSON('[1,2]')).toEqual({});
    expect(sidebarFromJSON('')).toEqual({});
    expect(sidebarFromJSON(null)).toEqual({});
  });

  // Debounced now, so the write happens on the timer rather than in the call -
  // the environment with no storage at all has to survive both halves.
  it('saves without a storage to save to', () => {
    vi.useFakeTimers();
    try {
      expect(() => saveSidebar()).not.toThrow();
      expect(() => vi.advanceTimersByTime(PREF_SAVE_MS)).not.toThrow();
      expect(() => flushSidebar()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // The debounce opened a window the synchronous write never had: ⌘Q destroys
  // the window, and the last drag of the rail was still on a 200ms timer. The
  // document and its history are drained on every route out; this is the same
  // obligation one tier down.
  describe('the flush on the way out', () => {
    const withStorage = (fn) => {
      const writes = [];
      const had = 'localStorage' in globalThis;
      const prev = globalThis.localStorage;
      globalThis.localStorage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
      const width = app.leftWidth;
      vi.useFakeTimers();
      try {
        fn(writes);
      } finally {
        vi.useRealTimers();
        app.leftWidth = width;
        if (had) globalThis.localStorage = prev;
        else delete globalThis.localStorage;
      }
    };

    it('writes what the timer was still holding', () => {
      withStorage((writes) => {
        app.leftWidth = 321;
        saveSidebar();
        expect(writes).toEqual([]); // still inside the window
        flushSidebar();
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0][1]).width).toBe(321);
        // And the timer went with it, rather than firing again behind the flush.
        vi.advanceTimersByTime(PREF_SAVE_MS * 2);
        expect(writes).toHaveLength(1);
      });
    });

    it('writes nothing when nothing was pending', () => {
      withStorage((writes) => {
        flushSidebar();
        expect(writes).toEqual([]);
      });
    });
  });
});

// There is no manual save in this app, so the indicator is the user's only
// standing signal that their work is not reaching the disk. The debounce is not
// the risky path: `flushSave` is, because it runs on the way out - leaving the
// editor, quitting, opening another chapter - and it cancels the debounce as it
// goes, so a rejection here leaves nothing scheduled to raise the flag later.
describe('the save indicator on the flush path', () => {
  beforeEach(() => {
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    app.saveFailed = false;
  });
  afterEach(() => {
    setSaver(null);
    app.chapterRef = null;
    app.saveFailed = false;
  });

  it('raises the failed state when the flush is rejected', async () => {
    setSaver(() => Promise.reject(new Error('disk full')));
    await expect(flushSave()).rejects.toThrow('disk full');
    expect(app.saveFailed).toBe(true);
  });

  // Load-bearing: flushBeforeLeaving reads the rejection to decide whether the
  // user may leave and what to tell them. Swallowing it here to set a flag
  // would let them walk out of a chapter that was never written.
  it('still hands the rejection to its caller', async () => {
    const err = new Error('read-only volume');
    setSaver(() => Promise.reject(err));
    await expect(flushSave()).rejects.toBe(err);
  });

  it('leaves the failed state alone when the flush lands', async () => {
    setSaver(() => Promise.resolve());
    await flushSave();
    expect(app.saveFailed).toBe(false);
  });

  // No chapter open is not a failed save - there was nothing to write.
  it('does not raise the failed state when there is nothing to flush', async () => {
    setSaver(() => Promise.reject(new Error('never called')));
    app.chapterRef = null;
    await flushSave();
    expect(app.saveFailed).toBe(false);
  });
});

// The rail hands `setTool` a string and the canvas branches on it. A tool the
// canvas has no branch for is not a harmless no-op: every press on the page
// falls through to `deselect`, and nothing on screen says why.
describe('the tool enum', () => {
  afterEach(() => setTool('place'));

  it('takes each tool the canvas answers to', () => {
    for (const t of TOOLS) {
      setTool(t);
      expect(app.tool).toBe(t);
    }
  });

  it('carries the hand', () => {
    expect(TOOLS).toContain('pan');
  });

  it('refuses a tool nothing implements, leaving the last one in place', () => {
    setTool('text');
    setTool('bulk'); // the mode that used to live on the rail
    setTool(undefined);
    expect(app.tool).toBe('text');
  });
});

// The percentage in the dock is `zoom * 100`, so every one of these is a number
// the user reads off the screen.
describe('zoom', () => {
  afterEach(() => setZoom(1));

  it('clamps to the range the dock can display', () => {
    setZoom(99);
    expect(app.zoom).toBe(ZOOM_MAX);
    setZoom(0.0001);
    expect(app.zoom).toBe(ZOOM_MIN);
  });

  // `isFit` is what tells the canvas to re-fit on a resize and lights the Fit
  // button. Only a fit sets it; a step off one has left it.
  it('holds the fit flag only until the zoom is stepped', () => {
    applyFit(0.43);
    expect(app.zoom).toBeCloseTo(0.43);
    expect(app.isFit).toBe(true);
    zoomIn();
    expect(app.isFit).toBe(false);
  });

  it('steps up from an arbitrary fit onto the next named stop', () => {
    applyFit(0.43);
    zoomIn();
    expect(app.zoom).toBe(0.5); // the half size the user asked for, exactly
    zoomIn();
    expect(app.zoom).toBe(0.67);
  });

  it('steps down onto the stop below, not back onto the one it is on', () => {
    setZoom(0.5);
    zoomOut();
    expect(app.zoom).toBe(0.33);
  });

  // Walking the ladder from either end must not stall or skip: these are the
  // only two buttons that move the zoom by hand.
  // Walking from either end must visit every stop once and then hold: a step
  // that skipped one, or that stalled short of the end, is a button the user
  // presses again with nothing happening.
  it('walks the whole ladder and holds at the ends', () => {
    setZoom(ZOOM_MIN);
    const up = [];
    for (let i = 1; i < ZOOM_STOPS.length; i++) {
      zoomIn();
      up.push(app.zoom);
    }
    expect(up).toEqual(ZOOM_STOPS.slice(1));
    zoomIn();
    expect(app.zoom).toBe(ZOOM_MAX);

    const down = [];
    for (let i = ZOOM_STOPS.length - 2; i >= 0; i--) {
      zoomOut();
      down.push(app.zoom);
    }
    expect(down).toEqual(ZOOM_STOPS.slice(0, -1).reverse());
    zoomOut();
    expect(app.zoom).toBe(ZOOM_MIN);
  });

  it('resets to exactly one page pixel per screen pixel', () => {
    setZoom(0.37);
    zoomReset();
    expect(app.zoom).toBe(1);
    expect(app.isFit).toBe(false);
  });
});

// A bulk edit used to land the whole template on every target, so a user who
// wanted the colour changed got the font, the size and the shadow with it. The
// mask is what they choose instead; everything below is what "unticked leaves
// the box alone" has to mean for that to be true.
describe('the bulk edit mask', () => {
  const styled = (id, lineN) => ({ id, lineN, text: null, x: 0, y: 0, w: 10, h: 10 });
  // `sfx` rather than a registry entry: `lineTags` reads a legacy `line.type` as
  // a tag, so these lines are tagged without this file needing localStorage.
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'sfx', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [styled('b1', 1), styled('b2', 2), styled('b3', null)],
    },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', en: 'c' }], boxes: [styled('b4', 1)] },
  ];
  const boxOf = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    // The style a new box inherits is a module global that a previous apply may
    // have moved; every case here reads it back, so it starts from the default.
    app.lastStyle = defaultStyle();
    openBulk();
  });
  afterEach(() => closeBulk());

  // The panel's rows are laid out against this list, so a property missing from
  // it is a property with no tick box and no way into a bulk edit. Pinning it to
  // the style's own leaves is what makes "every Inspector text option" a fact
  // rather than a claim: a field added to `defaultStyle` and forgotten here
  // fails this. Geometry cannot appear because x/y/w/h live on the box, not the
  // style - which is also why they stay the Inspector's.
  it('covers every leaf of the style, and nothing that is not one', () => {
    const leaves = Object.entries(defaultStyle()).flatMap(([k, v]) =>
      v && typeof v === 'object' ? Object.keys(v).map((f) => `${k}.${f}`) : [k],
    );
    expect([...BULK_PROPS].sort()).toEqual(leaves.sort());
    for (const geom of ['x', 'y', 'w', 'h']) expect(BULK_PROPS).not.toContain(geom);
  });

  it('opens with nothing ticked', () => {
    expect(app.bulk.mask).toEqual({});
    expect(bulkTicked()).toEqual([]);
  });

  it('ticks and unticks by path, in the panel’s own order', () => {
    tickBulkProp('shadow.blur');
    tickBulkProp('color');
    expect(bulkTicked()).toEqual(['color', 'shadow.blur']);
    setBulkProp('color', false);
    expect(bulkTicked()).toEqual(['shadow.blur']);
  });

  // A path that is not a property would sit in the mask forever, counted as a
  // tick by the footer and moved by nothing.
  it('refuses a key that is not a bulk property', () => {
    setBulkProp('x', true);
    setBulkProp('shadow', true);
    setBulkProp('nonsense', true);
    expect(bulkTicked()).toEqual([]);
  });

  it('moves only the ticked properties, nested ones included', () => {
    const base = { ...defaultStyle(), color: '#111111', size: 40 };
    base.shadow = { ...base.shadow, blur: 1, x: 3 };
    const tpl = { ...defaultStyle(), color: '#ff0000', size: 99 };
    tpl.shadow = { ...tpl.shadow, blur: 12, x: 40 };
    const out = mergeMasked(base, tpl, { color: true, 'shadow.blur': true });
    expect(out.color).toBe('#ff0000');
    expect(out.shadow.blur).toBe(12);
    expect(out.size).toBe(40);
    expect(out.shadow.x).toBe(3);
  });

  it('changes nothing at all with an empty mask', () => {
    const base = { ...defaultStyle(), color: '#111111' };
    expect(mergeMasked(base, { ...defaultStyle(), color: '#ff0000' }, {})).toEqual(base);
  });

  // The result is assigned onto a box. Sharing the nested groups with the style
  // it was merged from would tie two boxes' shadows together.
  it('never hands back the base style’s own nested objects', () => {
    const base = defaultStyle();
    const out = mergeMasked(base, defaultStyle(), { 'shadow.blur': true });
    expect(out.shadow).not.toBe(base.shadow);
    expect(out.roughen).not.toBe(base.roughen);
  });

  it('leaves the unticked properties of a clicked target alone', () => {
    boxOf('b1').style.size = 40;
    toggleBulkTarget('b1');
    app.bulk.style.color = '#00ff00';
    app.bulk.style.size = 12;
    setBulkProp('color', true);
    applyBulk();
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b1').style.size).toBe(40);
  });

  // An Apply that changed no pixel is indistinguishable from a broken one, and
  // the record it would leave rewinds nothing while costing a step of a
  // five-step history.
  it('refuses an apply with nothing ticked, and stays open', () => {
    toggleBulkTarget('b1');
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(boxOf('b1').style.color).not.toBe('#00ff00');
    expect(app.bulk.active).toBe(true);
  });

  it('records one entry for the whole apply, carrying whole styles', () => {
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('bulk');
    expect(log[0].items.map((i) => i.boxId)).toEqual(['b1', 'b2']);
    // Whole styles on both sides: the history's `bulk` kind assigns them
    // outright, so an entry carrying only the changed fields would replace each
    // box's style with a fragment on undo.
    expect(log[0].items[0].before.size).toBe(defaultStyle().size);
    expect(log[0].items[0].after.size).toBe(defaultStyle().size);
    expect(log[0].items[0].after.color).toBe('#00ff00');
  });

  // In a longstrip chapter every page of the chapter is drawn as one column, so
  // a target can be ticked on any slice while the index sits on whichever one
  // the scroll last focused. Scoped to `page()`, every target on another slice
  // resolved to undefined and `filter(Boolean)` dropped it without a word: tick
  // six boxes, press Apply, two of them change and the toast says two.
  it('reaches targets on pages the index is not on', () => {
    toggleBulkTarget('b1');
    toggleBulkTarget('b4');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).toBe('#00ff00');
    // One entry per page, on that page's own stack. A single entry can only
    // live on one stack and undo is per page, so the alternative is an entry
    // filed against the page on screen that rewinds boxes on another.
    expect(log.map((e) => [e.pageId, e.items.map((i) => i.boxId)])).toEqual([
      [1, ['b1']],
      [2, ['b4']],
    ]);
  });

  it('carries only the ticked half into the style the next box inherits', () => {
    toggleBulkTarget('b1');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    app.bulk.style.size = 99;
    applyBulk();
    expect(app.lastStyle.color).toBe('#00ff00');
    expect(app.lastStyle.size).toBe(defaultStyle().size);
  });

  it('drops the mask when the panel closes, so the next edit starts from nothing', () => {
    tickBulkProp('color');
    closeBulk();
    expect(app.bulk.mask).toEqual({});
    openBulk();
    expect(bulkTicked()).toEqual([]);
  });
});

// The tag-driven half: one press of Enter restyles every box carrying a tag,
// without the user clicking one of them. Scope is the array of pages handed
// over and nothing else - there is no scope enum anywhere in this path.
describe('a tag-scoped bulk edit', () => {
  const styled = (id, lineN) => ({ id, lineN, text: null, x: 0, y: 0, w: 10, h: 10 });
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'sfx', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [styled('b1', 1), styled('b2', 2), styled('b3', null)],
    },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', en: 'c' }], boxes: [styled('b4', 1)] },
  ];
  const boxOf = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);
  const green = () => {
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
  };

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
    openBulk();
  });
  afterEach(() => closeBulk());

  it('restyles every box carrying the tag in the pages it is handed', () => {
    green();
    expect(applyBulkToTag('sfx', app.pages)).toBe(2);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).toBe('#00ff00');
    // An untagged line, and a free-typed box that has no line to tag at all.
    expect(boxOf('b2').style.color).not.toBe('#00ff00');
    expect(boxOf('b3').style.color).not.toBe('#00ff00');
  });

  it('takes its scope from that array and nothing else', () => {
    green();
    expect(applyBulkToTag('sfx', [page()])).toBe(1);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).not.toBe('#00ff00');
  });

  it('leaves the unticked properties of a tagged box alone', () => {
    boxOf('b1').style.size = 40;
    green();
    app.bulk.style.size = 12;
    applyBulkToTag('sfx', app.pages);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b1').style.size).toBe(40);
  });

  // One entry per page, and no entry naming boxes on a page other than its own.
  // Undo is per page: a single entry filed against the page on screen would
  // rewind boxes on pages keeping stacks of their own, whose before/after still
  // described the world before this apply - their next undo would then restore a
  // style they had not been in since. So a chapter-wide apply is one press of
  // undo per page, taken on that page.
  it('records one entry per page, not one per box and not one for the chapter', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulkToTag('sfx', app.pages);
    } finally {
      off();
    }
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.t)).toEqual(['bulk', 'bulk']);
    expect(log.map((e) => e.pageId)).toEqual([1, 2]);
    // Every item on the page its entry names, which is the invariant the
    // history's `bulk` kind reads for.
    for (const e of log) {
      expect(e.items.map((i) => i.pageId)).toEqual(e.items.map(() => e.pageId));
    }
    expect(log[0].items.map((i) => i.boxId)).toEqual(['b1']);
    expect(log[1].items.map((i) => i.boxId)).toEqual(['b4']);
  });

  // The other half of the same rule: an apply that stayed on one page is still
  // one entry and one press.
  it('records a single entry when the apply never left the page', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulkToTag('sfx', [page()]);
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].pageId).toBe(page().id);
  });

  // Reviewer-verified drift: the merge into `lastStyle` sat outside the guard,
  // so an apply that matched nothing still moved the style every later placed
  // box inherits - to a value the user could not account for, because it had
  // never been applied to anything they could see.
  it('leaves the inherited style alone when the tag reached no box', () => {
    setBulkProp('roughen.amount', true);
    app.bulk.style.roughen.amount = 13;
    const was = app.lastStyle.roughen.amount;
    expect(applyBulkToTag('nosuchtag', app.pages)).toBe(0);
    expect(app.lastStyle.roughen.amount).toBe(was);
  });

  // Two ways of naming boxes, never one: the scope selector governs the tag
  // edit, and a box the user clicked is not part of it.
  it('ignores the click-to-select targets', () => {
    toggleBulkTarget('b3');
    green();
    applyBulkToTag('sfx', app.pages);
    expect(boxOf('b3').style.color).not.toBe('#00ff00');
  });

  it('refuses a tag apply with nothing ticked, and stays open', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(applyBulkToTag('sfx', app.pages)).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(app.bulk.active).toBe(true);
  });

  it('records nothing when the tag reaches no box', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(applyBulkToTag('narration', app.pages)).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
  });

  it('does nothing at all when bulk mode is not open', () => {
    green();
    closeBulk();
    expect(applyBulkToTag('sfx', app.pages)).toBe(0);
    expect(boxOf('b1').style.color).not.toBe('#00ff00');
  });
});

// Applying a tag used to be an action with no effect anyone could see: a tag's
// defaults reach a box only at placement, so tagging a line whose box was
// already on the page changed a badge and nothing else, and the user was left to
// conclude the defaults did not work. An apply restyles the box now, as one undo
// step.
describe('applying a tag to a line whose box is already placed', () => {
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [],
    },
  ];
  // The documented seam: a registry handed over rather than read out of a
  // localStorage the node environment does not have.
  const seedTags = (list) =>
    loadTags({ getItem: () => JSON.stringify({ list }), setItem: () => {} });
  const sfx = (extra = {}) => [
    { name: 'sfx', font: 'Bangers', outline: '#ff0000', outlineWidth: 6, ...extra },
  ];
  // The box this call placed, not the line's first - a line can end up with two.
  const placeLine = (n) => {
    activateLine(n);
    placeActiveAt(100, 100);
    return page().boxes[page().boxes.length - 1];
  };

  beforeEach(() => {
    app.chapterRef = null;
    seedTags([]);
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
  });

  it('restyles the box to the style it would have been placed with', () => {
    seedTags(sfx());
    const b = placeLine(1);
    expect(b.style.font).not.toBe('Bangers');
    const out = toggleTagOnLine(1, 'sfx');
    expect(out).toMatchObject({ added: true, restyled: 1, tags: ['sfx'] });
    expect(b.style.font).toBe('Bangers');
    expect(b.style.outline).toBe('#ff0000');
    expect(b.style.outlineWidth).toBe(6);
  });

  // The rule, stated as the equality it is: tag-then-place and place-then-tag
  // are the same function, so they cannot drift into two answers.
  it('lands on the same style as placing the box under the tag would have', () => {
    seedTags(sfx());
    const placedThenTagged = placeLine(1);
    toggleTagOnLine(1, 'sfx');
    toggleTagOnLine(2, 'sfx');
    const taggedThenPlaced = placeLine(2);
    expect(taggedThenPlaced.style.font).toBe(placedThenTagged.style.font);
    expect(taggedThenPlaced.style.outline).toBe(placedThenTagged.style.outline);
    expect(taggedThenPlaced.style.outlineWidth).toBe(placedThenTagged.style.outlineWidth);
  });

  // The rule for a box the user has styled by hand: the tag wins over the three
  // fields a tag can define, and touches nothing else. Manual styling winning
  // would make an apply do nothing on precisely the boxes the user has been
  // working on, which is the complaint this answers - and it is one undo press
  // away either way.
  it('overrides a font the user set by hand, and leaves everything else alone', () => {
    seedTags(sfx());
    const b = placeLine(1);
    b.style.font = 'Comic Neue';
    b.style.size = 44;
    b.style.color = '#123456';
    b.style.shadow.on = true;
    b.style.rotation = 12;
    toggleTagOnLine(1, 'sfx');
    expect(b.style.font).toBe('Bangers');
    expect(b.style.size).toBe(44);
    expect(b.style.color).toBe('#123456');
    expect(b.style.shadow.on).toBe(true);
    expect(b.style.rotation).toBe(12);
  });

  it('is one undo step, carrying whole styles on both sides', () => {
    seedTags(sfx());
    const b = placeLine(1);
    const was = b.style.font;
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('style');
    expect(log[0].pageId).toBe(page().id);
    expect(log[0].boxId).toBe(b.id);
    expect(log[0].before.font).toBe(was);
    expect(log[0].after.font).toBe('Bangers');
    // Whole styles: the history's `style` kind assigns them outright, so a
    // fragment would replace the box's style with three fields.
    expect(log[0].before.size).toBe(defaultStyle().size);
  });

  // `activateLine` will re-arm a line that is already placed, so a second click
  // on the canvas gives one line two boxes. Both are the line's, and one click
  // must still be one press of undo.
  it('covers every box on the line with a single entry', () => {
    seedTags(sfx());
    const first = placeLine(1);
    const second = placeLine(1);
    expect(first.id).not.toBe(second.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(toggleTagOnLine(1, 'sfx').restyled).toBe(2);
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('bulk');
    expect(log[0].items.map((i) => i.boxId)).toEqual([first.id, second.id]);
  });

  // Un-applying restyles nothing: a box's style is a value it owns, not a
  // reference to the tag, so there is no "what it would have been" to go back to
  // and guessing would be a second rule for the same button.
  it('changes nothing when the click takes the tag off again', () => {
    seedTags(sfx());
    const b = placeLine(1);
    toggleTagOnLine(1, 'sfx');
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: false, restyled: 0, tags: [] });
    expect(b.style.font).toBe('Bangers'); // kept, not reverted
    expect(log).toEqual([]);
  });

  it('records nothing when the tag defines no defaults', () => {
    seedTags([{ name: 'sfx', font: null, outline: null, outlineWidth: null }]);
    placeLine(1);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: true, restyled: 0 });
    expect(log).toEqual([]);
  });

  it('records nothing when the line has no box yet', () => {
    seedTags(sfx());
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: true, restyled: 0, tags: ['sfx'] });
    expect(log).toEqual([]);
    // …and the tag still reaches the box the ordinary way, at placement.
    expect(placeLine(1).style.font).toBe('Bangers');
  });

  it('normalises the name it is handed, like every other tag write', () => {
    seedTags(sfx());
    const b = placeLine(1);
    toggleTagOnLine(1, '  SFX  ');
    expect(lineTags(page().lines[0])).toEqual(['sfx']);
    expect(b.style.font).toBe('Bangers');
  });

  it('does nothing at all for a line or a name that is not there', () => {
    seedTags(sfx());
    expect(toggleTagOnLine(99, 'sfx')).toEqual({ tags: [], added: false, restyled: 0 });
    expect(toggleTagOnLine(1, '   ')).toEqual({ tags: [], added: false, restyled: 0 });
  });
});

// ---------------------------------------------------------------------------
// the page's coordinate space
// ---------------------------------------------------------------------------
//
// `.page-frame` is `p.w * zoom` by `p.h * zoom` and `.page-img` inside it is
// `width:100%; height:100%`, so these two numbers are not a note about the file
// - they are the space the art is drawn into and the space every box is
// positioned in. Nothing letterboxes: when they disagree with the image, the
// art is stretched and the zoom readout is a percentage of pixels that do not
// exist. Everything below is that one invariant.
describe('the page coordinate space', () => {
  const unmeasured = (id, extra = {}) => ({
    id,
    w: 0,
    h: 0,
    lines: [],
    boxes: [],
    raw: `blob:raw-${id}`,
    cleaned: null,
    ...extra,
  });

  beforeEach(() => {
    app.chapterRef = null;
  });

  it('calls a page with no positive pair unmeasured, not a page of size zero', () => {
    expect(hasPageSpace({ w: 1080, h: 1535 })).toBe(true);
    expect(hasPageSpace({ w: 0, h: 0 })).toBe(false);
    expect(hasPageSpace({ w: 1080, h: 0 })).toBe(false);
    expect(hasPageSpace({})).toBe(false);
    expect(hasPageSpace({ w: NaN, h: NaN })).toBe(false);
    expect(hasPageSpace(null)).toBe(false);
  });

  // `createChapter` writes `w:0,h:0` for every page it copies - it never
  // decodes the images - so this is the state 23 of the 28 pages in the
  // author's own library are saved in. Loading must not turn it into a size:
  // PAGE_W/PAGE_H there is an invented coordinate space, and the first real
  // measurement would then look like a space *changing* and drag every box
  // across by 1080/850.
  it('keeps an unmeasured page unmeasured across a load', () => {
    loadProjectPages([unmeasured(1), { ...unmeasured(2), w: undefined, h: undefined }]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([0, 0]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([0, 0]);
  });

  it('refuses a measurement of zero, which is a failed decode and not a size', () => {
    loadProjectPages([{ ...unmeasured(1), w: 1080, h: 1535 }]);
    expect(setPageDims(page(), 0, 0)).toBe(false);
    expect([page().w, page().h]).toEqual([1080, 1535]);
  });

  it('adopts the first measurement without moving anything', () => {
    loadProjectPages([unmeasured(1)]);
    const p = page();
    p.boxes.push({ id: 'b1', lineN: null, text: 'x', x: 40, y: 60, w: 220, h: 92 });
    expect(setPageDims(p, 1080, 1535)).toBe(true);
    expect([p.w, p.h]).toEqual([1080, 1535]);
    // Nothing was authored in a space that did not exist, so nothing can have
    // been authored in the wrong one.
    expect([p.boxes[0].x, p.boxes[0].y]).toEqual([40, 60]);
  });

  // The other half of the same rule, and the one that keeps the art and the
  // boxes together: a page that HAS a space and is handed a different one has
  // had its art replaced (a cleaned raster at another resolution landing on a
  // page that is already typeset). The boxes were placed over that art.
  it('carries the boxes and the detected geometry across a space that changes', () => {
    loadProjectPages([
      {
        ...unmeasured(1),
        w: 500,
        h: 1000,
        boxes: [{ id: 'b1', lineN: null, text: 'x', x: 100, y: 200, w: 50, h: 40 }],
        detect: { panels: [[0, 0, 500, 500]], boxes: [{ n: 1, box: [10, 20, 30, 40], font_size: 24 }] },
      },
    ]);
    const p = page();
    expect(setPageDims(p, 1000, 3000)).toBe(true);
    expect([p.boxes[0].x, p.boxes[0].y, p.boxes[0].w, p.boxes[0].h]).toEqual([200, 600, 100, 120]);
    expect(p.detect.panels[0]).toEqual([0, 0, 1000, 1500]);
    expect(p.detect.boxes[0].box).toEqual([20, 60, 60, 120]);
    expect(p.detect.boxes[0].font_size).toBe(72);
  });

  it('leaves a page that already knows its size alone', () => {
    loadProjectPages([{ ...unmeasured(1), w: 1080, h: 1535 }]);
    expect(setPageDims(page(), 1080, 1535)).toBe(false);
  });

  // There is one `<img>` in the canvas and `src` changes under it on every page
  // turn, so a decode can finish after the user has moved on. Addressed by the
  // page on screen, that measurement lands on the wrong page - and on a chapter
  // with a double-page spread in it, that page is then drawn stretched for
  // good, and saved that way. The object URL belongs to exactly one page.
  it('lands a late decode on the page whose image it was', () => {
    loadProjectPages([unmeasured(1), unmeasured(2)]);
    gotoPage(1); // the user has already turned the page
    const landed = setPageDimsForSrc('blob:raw-1', 1080, 1535);
    expect(landed).toBe(app.pages[0]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([1080, 1535]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([0, 0]);
  });

  it('finds a page by either of its two rasters, and says so when nobody owns the url', () => {
    loadProjectPages([unmeasured(1, { cleaned: 'blob:cleaned-1' }), unmeasured(2)]);
    expect(pageForSrc('blob:cleaned-1')).toBe(app.pages[0]);
    expect(pageForSrc('blob:raw-2')).toBe(app.pages[1]);
    expect(pageForSrc('blob:nothing')).toBe(null);
    expect(setPageDimsForSrc('blob:nothing', 800, 900)).toBe(null);
  });

  // The measurement is the document changing, and there is no manual save in
  // this app: unsaved, a chapter re-learns its page sizes one visit at a time
  // every session, and every page nobody opened stays at 0x0 for the exporter.
  it('marks the document unsaved when a page learns its size', () => {
    loadProjectPages([unmeasured(1)]);
    app.saved = true;
    setPageDims(page(), 1080, 1535);
    expect(app.saved).toBe(false);
  });
});

// The engine's `img_width`/`img_height` are the decoded size of the image it
// was handed (src-tauri/src/detect/engine.rs decodes once, detect::analyze
// reports that size, nothing resizes between), and every `box` it returns is
// quoted in that space. So they are the detector's frame of reference, not a
// second opinion about how big the page is.
describe('applying a detection result', () => {
  const result = (over = {}) => ({
    img_width: 1000,
    img_height: 2000,
    panels: [[0, 0, 500, 1000]],
    lines: [{ n: 1, type: 'dialogue', jp: 'あ', box: [100, 200, 300, 400], vertical: true, font_size: 20 }],
    ...over,
  });

  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
  });

  it('adopts the detector size only on a page that has never been measured', () => {
    loadProjectPages([{ id: 1, w: 0, h: 0, lines: [], boxes: [] }]);
    applyDetection(result());
    expect([page().w, page().h]).toEqual([1000, 2000]);
    // Adopted, so the boxes are already in the page's space and untouched.
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
  });

  // The canvas draws `p.cleaned ?? p.raw`; detection runs on `p.raw`. Writing
  // the detector's size over a measured page is what stretched the cleaned art
  // into the raw's box - and the zoom percentage with it.
  it('never overwrites a page that has been measured', () => {
    loadProjectPages([{ id: 1, w: 2000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result());
    expect([page().w, page().h]).toEqual([2000, 2000]);
  });

  it('maps its geometry into the page space instead', () => {
    loadProjectPages([{ id: 1, w: 2000, h: 1000, lines: [], boxes: [] }]);
    applyDetection(result());
    // x doubles (2000/1000), y halves (1000/2000).
    expect(page().detect.boxes[0].box).toEqual([200, 100, 600, 200]);
    expect(page().detect.panels[0]).toEqual([0, 0, 1000, 500]);
    expect(page().detect.boxes[0].font_size).toBe(10);
    expect(page().detect.boxes[0].vertical).toBe(true);
  });

  it('leaves the geometry alone when the detector agrees with the page', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result());
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
    expect(page().detect.panels[0]).toEqual([0, 0, 500, 1000]);
  });

  // A result that reports no size at all leaves the page as it found it rather
  // than dividing by it.
  it('survives a result with no dimensions in it', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result({ img_width: 0, img_height: 0 }));
    expect([page().w, page().h]).toEqual([1000, 2000]);
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
  });

  it('applies to the page it is given, not to the page on screen', () => {
    loadProjectPages([
      { id: 1, w: 0, h: 0, lines: [], boxes: [] },
      { id: 2, w: 0, h: 0, lines: [], boxes: [] },
    ]);
    applyDetection(result(), app.pages[1]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([0, 0]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([1000, 2000]);
  });

  // Re-detecting a page is an ordinary thing to do - a better model, a cleaned
  // raster, a page that came out wrong the first time - and it used to throw
  // away every translation on that page, with no undo entry and no warning.
  it('keeps the English on a line the detector found again unchanged', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }], boxes: [] },
    ]);
    applyDetection(result());
    expect(page().lines.map((l) => [l.n, l.jp, l.en])).toEqual([[1, 'あ', 'Ah']]);
  });

  // Same number, different sentence. The detector renumbers from 1 in reading
  // order on every run, so the number alone does not say it is the same line -
  // one bubble found that was missed before shifts every number after it.
  // Carrying the old English across would put a confident, wrong translation in
  // the queue, which is strictly worse than an empty row the user can see is
  // empty.
  it('drops the English when that number now names different Japanese', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'い', en: 'Ah' }], boxes: [] },
    ]);
    applyDetection(result());
    expect(page().lines[0].jp).toBe('あ');
    expect(page().lines[0].en).toBe('');
  });

  // Queue-side markup takes the looser rule - by number alone, which is what the
  // JSON re-import path already does to the same wholesale replacement. One
  // click to re-apply and one to take off, so the cost of guessing wrong is not
  // the cost of guessing wrong about a translation.
  it('carries the tags on a line across, like a re-import does', () => {
    loadProjectPages([
      {
        id: 1,
        w: 1000,
        h: 2000,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: '', tags: ['sfx'] }],
        boxes: [],
      },
    ]);
    applyDetection(result());
    expect(lineTags(page().lines[0])).toEqual(['sfx']);
  });

  // The detector never saw these rows and cannot renumber them - its numbers
  // start at 1 - so it has no opinion about them at all.
  it('carries the rows the user typed, and the boxes that made them', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    const freeN = byId(id).lineN;
    applyDetection(result());
    expect(page().lines.map((l) => l.n)).toEqual([1, freeN]);
    expect(page().lines.find((l) => l.n === freeN).en).toBe('typed');
    // The box survives with its line. A surviving line whose box was wiped is
    // exactly the orphan row `deleteBox` goes out of its way never to leave:
    // unplaceable, undeletable, holding the text of a box that is gone.
    expect(page().boxes.map((b) => b.id)).toEqual([id]);
  });

  // The typeset boxes do go - every one is bound to a number the detector has
  // just reassigned - and the two ids pointing into them have to go with them.
  it('wipes the typeset boxes and takes the selection and the caret with them', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }], boxes: [] },
    ]);
    activateLine(1);
    placeActiveAt(100, 100);
    const b = page().boxes[0];
    beginEdit(b.id);
    expect([app.selectedId, app.editingId]).toEqual([b.id, b.id]);
    applyDetection(result());
    expect(page().boxes).toHaveLength(0);
    // Dangling, `selectedId` names a box nothing can find, and `editingId` is
    // read by App.svelte as "the user is typing" - every global shortcut in the
    // app stays dead behind it.
    expect(app.selectedId).toBe(null);
    expect(app.editingId).toBe(null);
  });
});

// The auto-fit itself needs real text metrics, and the arithmetic it is made of
// is pinned in typeset.test.js (`neededHeight`, `growToFit`). What belongs here
// is the guard: under node there is no canvas, so `autoFitBox` must decline
// rather than size a box from the stand-in metric every measurement falls back
// to. `loadProjectPages` refits every page it loads, so without that guard every
// test run - and every headless consumer - would silently rewrite the geometry
// in the document it just opened.
describe('auto-height declines when there is nothing to measure with', () => {
  it('leaves a loaded box exactly as the file had it', () => {
    app.chapterRef = null;
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'A LONG LINE OF DIALOGUE', x: 10, y: 20, w: 60, h: 12 }],
      },
    ]);
    const b = page().boxes[0];
    expect([b.x, b.y, b.w, b.h]).toEqual([10, 20, 60, 12]);
  });
});

// ===========================================================================
// Placement follows the bubble
// ===========================================================================
// A placed box used to be 220x92 whatever it landed on - a size chosen for a
// page nobody had seen. `p.detect.boxes` already holds, per line, the rect the
// Japanese occupied, in page coordinates; that is the size and the position the
// English wants, less a margin so the text is not pressed against the outline.
describe('bubble-aware placement', () => {
  const withDetect = (boxes) => [
    {
      id: 1,
      w: 1000,
      h: 2000,
      lines: [{ n: 1, jp: 'あ', en: '', type: 'dialogue' }, { n: 2, jp: 'い', en: '', type: 'dialogue' }],
      boxes: [],
      detect: { panels: [], boxes },
    },
  ];

  beforeEach(() => {
    app.chapterRef = null;
  });

  it('finds the line’s own rect first', () => {
    loadProjectPages(withDetect([
      { n: 1, box: [100, 100, 300, 300], vertical: true, font_size: 20 },
      { n: 2, box: [500, 500, 700, 700], vertical: true, font_size: 20 },
    ]));
    expect(detectedRectFor(page(), 2, 0, 0)).toEqual([500, 500, 700, 700]);
  });

  it('falls back to whichever rect the click landed in', () => {
    loadProjectPages(withDetect([{ n: 2, box: [500, 500, 700, 700], vertical: false, font_size: 20 }]));
    // Line 1 has no geometry of its own, but the user is pointing at a bubble.
    expect(detectedRectFor(page(), 1, 600, 600)).toEqual([500, 500, 700, 700]);
    // A click on bare paper is not pointing at anything.
    expect(detectedRectFor(page(), 1, 50, 50)).toBe(null);
  });

  it('sizes and centres the box on the rect, inset off the outline', () => {
    const p = { w: 1000, h: 2000 };
    const g = placementRect(p, [100, 100, 300, 400], 0, 0);
    // A 200x300 rect: 8% of its shorter side is 16, held to the 14 ceiling, and
    // taken off every edge.
    expect(g).toEqual({ x: 114, y: 114, w: 172, h: 272 });
    // Centred on the rect, not on the click.
    expect([g.x + g.w / 2, g.y + g.h / 2]).toEqual([200, 250]);
  });

  it('keeps the inset from eating a small rect or dominating a large one', () => {
    const p = { w: 4000, h: 4000 };
    // A long thin SFX strip: 8% of 30 rounds to 2, held up by the floor of 3,
    // so the margin is visible rather than notional.
    expect(placementRect(p, [0, 0, 400, 30], 0, 0).w).toBe(394);
    // A full-page rect: the ceiling stops the margin swallowing the bubble.
    expect(placementRect(p, [0, 0, 1000, 1000], 0, 0).w).toBe(972);
  });

  it('never places a box smaller than a drag is allowed to make one', () => {
    const g = placementRect({ w: 1000, h: 2000 }, [0, 0, 10, 10], 0, 0);
    expect([g.w, g.h]).toEqual([40, 30]);
  });

  // `p.w`/`p.h` are 0 until something decodes the art, and clamping against a
  // number nobody has measured is what `growToFit` already refuses to do. Here
  // it was worse than a no-op: `clamp(cx - w/2, 0, Math.max(0, 0 - w))` is a
  // range of exactly zero, so every placement on a page the canvas had not
  // measured yet landed on the origin and the bubble the detector found was
  // thrown away. A whole chapter can be in that state - a page is only measured
  // when it is looked at.
  it('does not clamp a placement against a page nobody has measured', () => {
    expect(placementRect({ w: 0, h: 0 }, [100, 100, 300, 400], 0, 0)).toEqual({
      x: 114,
      y: 114,
      w: 172,
      h: 272,
    });
    // The lower edge still holds: a box is never placed off the top-left, which
    // needs no measurement to know.
    expect(placementRect({ w: 0, h: 0 }, null, 10, 10)).toEqual({ x: 0, y: 0, w: 220, h: 92 });
  });

  it('keeps the old constants when there is nothing detected behind the line', () => {
    expect(placementRect({ w: 1000, h: 2000 }, null, 500, 500)).toEqual({
      x: 390,
      y: 454,
      w: 220,
      h: 92,
    });
  });

  it('places from the bubble rather than from the constants', () => {
    loadProjectPages(withDetect([{ n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 }]));
    placeActiveAt(50, 50); // deliberately off the bubble: the line's own rect wins
    const b = page().boxes[0];
    expect([b.w, b.h]).toEqual([372, 172]);
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([300, 200]);
  });
});

// ===========================================================================
// Free-typed boxes join the text queue
// ===========================================================================
// A box made with the Text tool used to be canvas-only: `lineN: null`, no queue
// row, and - since tags live on lines - no way to tag it, no way for a
// tag-scoped bulk edit to reach it, and no showing in the "N / M placed" count.
// It now brings a line of its own with it. What pins that, below, is the four
// things that can go wrong with such a line: its number colliding with the
// translator's, its text living in two places, the placed count lying, and the
// line outliving the box that made it.
describe('a free-typed box brings a queue line with it', () => {
  const withLines = (lines) => [{ id: 1, w: 800, h: 1200, lines, boxes: [] }];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(withLines([]));
  });

  it('creates one line, numbered below zero, and points the box at it', () => {
    const id = addEmptyBox(100, 100);
    expect(page().lines.length).toBe(1);
    const ln = page().lines[0];
    expect(ln.n).toBeLessThan(0);
    expect(byId(id).lineN).toBe(ln.n);
    // Null, not '': the text lives on the line. A string here would shadow it
    // in `boxText` and the queue's textarea would stop reaching the box.
    expect(byId(id).text).toBe(null);
  });

  // The whole reason the number is negative. Imported lines are the
  // translator's numbering, they are what `psd.js` and `exporter.js` write out,
  // and they must not be renumbered to make room for anything.
  it('never takes a number an imported line already has, and renumbers none of them', () => {
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }, { n: 7, type: 'sfx', jp: 'ドン', en: 'DON' }]));
    addEmptyBox(100, 100);
    addEmptyBox(200, 200);
    expect(page().lines.map((l) => l.n)).toEqual([1, 7, -1, -2]);
  });

  // Descending from whatever is lowest, so a chapter whose lines a hand edit
  // numbered from -5 still cannot be collided with.
  it('goes below the lowest number on the page, not below zero', () => {
    loadProjectPages(withLines([{ n: -5, type: 'dialogue', jp: '', en: 'hand-edited' }]));
    addEmptyBox(100, 100);
    expect(page().lines.at(-1).n).toBe(-6);
  });

  // Per page: `box.lineN` only ever joins within a page, so page two starting
  // its own free numbering at -1 is correct and not a collision.
  it('numbers each page on its own', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [] },
    ]);
    addEmptyBox(100, 100);
    gotoPage(1);
    addEmptyBox(100, 100);
    expect(app.pages[0].lines[0].n).toBe(-1);
    expect(app.pages[1].lines[0].n).toBe(-1);
  });

  // `normLine` in importer.js validates `type` against three names and silently
  // downgrades anything else. A free line written with a fourth would come back
  // from the app's own exported JSON as something it was not.
  it("gives the line a type the importer's own validation accepts", () => {
    addEmptyBox(100, 100);
    expect(page().lines[0].type).toBe('dialogue');
  });

  // No Japanese source: the user typed English straight onto the page. The
  // queue and the box both render their JP on `{#if line.jp}`, so '' is no
  // label at all rather than a blank one.
  it('leaves jp empty and puts the typed text in en', () => {
    const id = addEmptyBox(100, 100);
    expect(page().lines[0].jp).toBe('');
    expect(page().lines[0].en).toBe('');
    endEdit('BOOM');
    expect(page().lines[0].en).toBe('BOOM');
    // One copy: the box owns nothing and resolves through its line.
    expect(byId(id).text).toBe(null);
    expect(boxText(byId(id))).toBe('BOOM');
  });

  it('is placed by definition, so the queue count stays honest', () => {
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }]));
    const before = page().lines.filter((l) => isPlaced(page(), l.n)).length;
    expect(before).toBe(0);
    addEmptyBox(100, 100);
    // Both halves of "N / M placed" move together - the line is counted, and it
    // is counted as placed, because the box is what created it.
    expect(page().lines.length).toBe(2);
    expect(page().lines.filter((l) => isPlaced(page(), l.n)).length).toBe(1);
  });

  // The queue's active line parks on the last line once everything is placed.
  // Parking on a free line arms `placeActiveAt` to drop a second box onto a
  // line that already has one.
  it('is skipped by the "all placed" fallback', () => {
    loadProjectPages(withLines([{ n: 4, type: 'dialogue', jp: '', en: 'x' }]));
    placeActiveAt(100, 100);
    addEmptyBox(300, 300);
    endEdit('typed');
    expect(firstUnplaced(page())).toBe(4);
  });

  it('refuses a second box on the same free line', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    activateLine(byId(id).lineN);
    placeActiveAt(400, 400);
    expect(page().boxes.length).toBe(1);
  });
});

describe('deleting a free-typed box takes its line with it', () => {
  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }], boxes: [] }]);
  });

  // Left behind, the row is unplaceable, un-deletable (the queue has no such
  // control) and holds the text of a box that is gone.
  it('leaves no orphan row in the queue', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    expect(page().lines.length).toBe(2);
    deleteBox(id);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  // An imported line is the opposite case: it came from the translation and
  // outlives any box, so it goes back into the queue exactly as before.
  it('hands an imported line back to the queue instead', () => {
    placeActiveAt(100, 100);
    const id = page().boxes[0].id;
    deleteBox(id);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
    expect(page().activeLineN).toBe(1);
  });

  // The queue must not be left armed on a number that no longer exists.
  it('does not arm the queue on the line it just removed', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    deleteBox(id);
    expect(page().activeLineN).not.toBe(-1);
  });

  // The empty-placeholder gesture: created and abandoned without typing. Both
  // halves have to go, or the user is left with a blank row for a box they
  // never made.
  it('takes the line too when the box is abandoned empty', () => {
    addEmptyBox(100, 100);
    endEdit('  ');
    expect(page().boxes.length).toBe(0);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  it('takes the line too when an empty free box is abandoned via deselect', () => {
    addEmptyBox(100, 100);
    deselect();
    expect(page().boxes.length).toBe(0);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  // Stronger than the case above, which only ever saw the queue armed by
  // `addEmptyBox`'s own path: here the user has clicked the free row, so
  // `activeLineN` really is the number that is about to leave the document.
  // `placeActiveAt` looks the active line up by number, so a stale one there
  // makes every later click on the canvas a silent no-op with no way out but
  // clicking another queue row - which is not a thing anybody knows to try.
  it('re-arms the queue when the line it was pointing at goes', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    const n = byId(id).lineN;
    activateLine(n);
    expect(page().activeLineN).toBe(n);
    deleteBox(id);
    expect(page().activeLineN).toBe(1);
    expect(page().lines.some((l) => l.n === page().activeLineN)).toBe(true);
  });

  // A delete can arrive from outside the box being typed into - the Inspector's
  // button, the keyboard while the pointer is elsewhere. App.svelte reads
  // `editingId` as "the user is typing" and returns before any shortcut is
  // reached, so a caret left on a box that no longer exists kills every global
  // shortcut in the app until something else happens to clear it.
  it('closes the caret on the box it deletes', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    beginEdit(id);
    expect(app.editingId).toBe(id);
    deleteBox(id);
    expect(app.editingId).toBe(null);
    expect(app.selectedId).toBe(null);
  });
});

// The blur or the Escape with no typing in it, which used to be an edit.
describe('ending an inline edit that changed nothing', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Hello' }], boxes: [] },
    ]);
  });

  const placed = () => {
    activateLine(1);
    placeActiveAt(100, 100);
    return page().boxes[0];
  };

  // A queue-placed box owns no text: `b.text` is null on purpose, so `boxText`
  // resolves through the line and the queue's textarea keeps reaching the
  // canvas. `editBefore` is that same null, while the editable hands back the
  // string it was *displaying* - the line's. Compared as they stand, an
  // untouched blur reads as "null became 'Hello'", writes that string onto the
  // box as an override and detaches it from its line for good.
  it('leaves a queue-placed box reading its line, and records nothing', () => {
    const b = placed();
    beginEdit(b.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      endEdit(boxText(b));
    } finally {
      off();
    }
    expect(b.text).toBe(null);
    expect(log).toEqual([]);
    // The whole of the claim: it is still following the queue.
    page().lines[0].en = 'Goodbye';
    expect(boxText(b)).toBe('Goodbye');
  });

  it('still writes the override when the user actually typed', () => {
    const b = placed();
    beginEdit(b.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      endEdit('Hello there');
    } finally {
      off();
    }
    expect(b.text).toBe('Hello there');
    expect(log.map((e) => e.t)).toEqual(['text']);
  });

  // A free-typed box keeps its text on its line, so `boxOwnText` already reads
  // the same field on both sides of an edit. The guard must not reach it.
  it('does not swallow an edit to a free-typed box', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    expect(boxText(byId(id))).toBe('typed');
  });
});

// The button at the foot of the queue has no page coordinates to hand over -
// it lives in a panel floating over a canvas that may be zoomed into any
// corner. The page's own centre is off-screen at that zoom, and a box the user
// cannot see is a box they cannot type into.
describe('visiblePageCenter', () => {
  const p = { w: 1000, h: 2000 };
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

  it('centres on the visible part of the page, not on the page', () => {
    // The frame is drawn at 2x from (-500,-1000), so the page's own centre sits
    // at client (500, 1000) - outside a viewport that only shows the top-left.
    const got = visiblePageCenter(p, rect(0, 0, 400, 400), rect(-500, -1000, 1500, 3000), 2);
    expect(got).toEqual({ x: 350, y: 600 });
  });

  it('is the page centre when the whole page is in view', () => {
    expect(visiblePageCenter(p, rect(0, 0, 2000, 3000), rect(0, 0, 1000, 2000), 1)).toEqual({ x: 500, y: 1000 });
  });

  it('falls back to the page centre with nothing to measure', () => {
    expect(visiblePageCenter(p, null, null, 1)).toEqual({ x: 500, y: 1000 });
    expect(visiblePageCenter(p, rect(0, 0, 100, 100), rect(0, 0, 100, 100), 0)).toEqual({ x: 500, y: 1000 });
  });

  // Not a viewport at all. Measured against an empty intersection the box lands
  // at whichever edge the page was dragged past.
  it('falls back when the page is scrolled entirely out of view', () => {
    expect(visiblePageCenter(p, rect(0, 0, 400, 400), rect(900, 900, 1900, 2900), 1)).toEqual({ x: 500, y: 1000 });
  });

  // A page that has never been measured has w/h of 0 - see `hasPageSpace`.
  it('uses the default page size for a page with no space yet', () => {
    expect(visiblePageCenter({ w: 0, h: 0 }, null, null, 1)).toEqual({ x: PAGE_W / 2, y: PAGE_H / 2 });
  });
});

// ===== the chapter's workflow mode =====
// `app.chapterMode` mirrors the open chapter's `mode` field. Everything the
// editor hides in translate mode is a `{#if}` over one derived boolean, which is
// not worth a DOM test; what IS worth testing is the two things that are not
// presentational - the tool the mode allows, and the fact that no code path can
// still add a box.
describe('translate mode', () => {
  const withLines = (lines) => [{ id: 1, w: 800, h: 1200, lines, boxes: [] }];

  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    setTool('place');
    loadProjectPages(withLines([]));
  });
  afterEach(() => {
    app.chapterMode = 'typeset';
    setTool('place');
  });

  it('normalises anything that is not one of the two names to typeset', () => {
    expect(CHAPTER_MODES).toEqual(['typeset', 'translate']);
    expect(normalizeChapterMode('translate')).toBe('translate');
    expect(normalizeChapterMode('typeset')).toBe('typeset');
    // What a chapter.json written before this field existed, or hand-edited,
    // can hand over. None of these may leave a chapter in a mode the editor
    // does not implement.
    for (const bad of [undefined, null, '', 'Translate', 'clean', 0, {}]) {
      expect(normalizeChapterMode(bad)).toBe('typeset');
    }
  });

  it('leaves the hand as the only tool the rail and the keyboard can reach', () => {
    setTool('pan');
    app.chapterMode = 'translate';
    expect(isTranslateMode()).toBe(true);
    // v and t both come through here, so refusing here is what makes them
    // no-ops without a second guard in the keydown handler.
    setTool('place');
    setTool('text');
    expect(app.tool).toBe('pan');
    // And the way back is not blocked: a chapter switched to typeset while it
    // is open gets its tools back with no further ceremony.
    app.chapterMode = 'typeset';
    setTool('place');
    expect(app.tool).toBe('place');
  });

  it('adds no box, whichever entry point is called', () => {
    app.chapterMode = 'translate';
    expect(addEmptyBox(100, 100)).toBe(null);
    expect(page().boxes).toHaveLength(0);
    // And no line either: `addEmptyBox` creates the pair, so a guard that let
    // the line through would leave an unbacked row in the queue for ever.
    expect(page().lines).toHaveLength(0);

    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }]));
    app.chapterMode = 'translate';
    activateLine(1);
    placeActiveAt(100, 100);
    expect(page().boxes).toHaveLength(0);
  });

  it('disallows deleting boxes in translate mode', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }],
        boxes: [{ id: 'b1', lineN: 1, text: 'Ah', x: 0, y: 0, w: 10, h: 10, style: defaultStyle() }],
      },
    ]);
    app.chapterMode = 'translate';
    deleteBox('b1');
    expect(page().boxes).toHaveLength(1);
  });

  it('arms the active line without selecting canvas boxes on row click', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 10, y: 10, w: 100, h: 50, style: {} }],
      },
    ]);
    app.chapterMode = 'translate';
    expect(app.selectedId).toBe(null);

    activateLine(1);
    expect(page().activeLineN).toBe(1);
    expect(app.selectedId).toBe(null);

    // In typeset mode, activating the line selects its box
    app.chapterMode = 'typeset';
    activateLine(1);
    expect(page().activeLineN).toBe(1);
    expect(app.selectedId).toBe('b1');
  });
});

// The translate workspace's progress badge. Derived from the lines, never
// stored - see `translatedCount`.
describe('the translated count', () => {
  it('counts a line as done once it has English on it', () => {
    expect(isTranslated({ n: 1, en: 'Ah' })).toBe(true);
    expect(isTranslated({ n: 1, en: '' })).toBe(false);
    expect(isTranslated({ n: 1 })).toBe(false);
    expect(isTranslated(null)).toBe(false);
  });

  it('does not count whitespace as a translation', () => {
    expect(isTranslated({ n: 1, en: '   ' })).toBe(false);
    expect(isTranslated({ n: 1, en: '\n\t' })).toBe(false);
  });

  // The legacy fields `lineText` already resolves through. A chapter saved under
  // the old schema has its translation in `natural`, and it is translated.
  it('reads the legacy text fields the rest of the app reads', () => {
    expect(isTranslated({ n: 1, natural: 'Ah' })).toBe(true);
  });

  it('counts a page', () => {
    expect(translatedCount([{ n: 1, en: 'Ah' }, { n: 2, en: '' }, { n: 3, en: 'Oh' }])).toBe(2);
    expect(translatedCount([])).toBe(0);
    expect(translatedCount(null)).toBe(0);
  });
});

// The reference sidebar's zoom. Both the buttons and the wheel multiply through
// `rawZoomBy`, so the Fit floor and the ceiling are written once.
describe('the raw reference zoom', () => {
  beforeEach(() => {
    app.rawZoom = 0;
  });
  afterEach(() => {
    app.rawZoom = 0;
  });

  it('treats 0 as Fit on the way up, so the first step in is a real zoom', () => {
    rawZoomIn();
    expect(app.rawZoom).toBeCloseTo(1.25);
  });

  // Fit is the floor, so the press that means "smaller than this" has nowhere
  // to go. It used to read Fit as 1x and step down to 0.8 - the sidebar visibly
  // shrinking below the fit it was already at, and jumping back to Fit on the
  // press after.
  it('stays at Fit when zoomed out from Fit', () => {
    rawZoomOut();
    expect(app.rawZoom).toBe(0);
    rawZoomBy(0.5);
    expect(app.rawZoom).toBe(0);
    // And the way up out of Fit is untouched: that is what reading 0 as 1x is
    // for.
    rawZoomIn();
    expect(app.rawZoom).toBeCloseTo(1.25);
  });

  it('lands back on Fit rather than shrinking below it', () => {
    app.rawZoom = 0.35;
    rawZoomOut();
    expect(app.rawZoom).toBe(0);
  });

  it('takes a continuous factor from the wheel and keeps the same floor', () => {
    app.rawZoom = 2;
    rawZoomBy(1.1);
    expect(app.rawZoom).toBeCloseTo(2.2);
    rawZoomBy(0.05);
    expect(app.rawZoom).toBe(0);
  });

  // A trackpad pinch arrives as a stream of deltas and would otherwise run the
  // zoom off into the thousands in one flick.
  it('will not zoom past the ceiling', () => {
    app.rawZoom = 7;
    rawZoomBy(100);
    expect(app.rawZoom).toBe(RAW_ZOOM_MAX);
  });
});

// ===========================================================================
// The project's page layout
// ===========================================================================
// A longstrip project draws every page of the chapter as one scrolling column,
// so the page under the pointer is no longer the page the index is on. These
// cover the flag itself and the two entry points that had to stop assuming
// otherwise - the store half of it; the canvas resolves the frame.
describe('the project layout flag', () => {
  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('knows exactly two layouts', () => {
    expect(LAYOUTS).toEqual(['pages', 'longstrip']);
  });

  // Every project.json written before the flag existed has no `layout` key at
  // all, and every one of them is a paged project.
  it('reads anything unrecognised, absent included, as pages', () => {
    expect(normalizeLayout(undefined)).toBe('pages');
    expect(normalizeLayout(null)).toBe('pages');
    expect(normalizeLayout('webtoon')).toBe('pages');
    expect(normalizeLayout('longstrip')).toBe('longstrip');
    expect(normalizeLayout('pages')).toBe('pages');
  });

  it('answers isLongstrip from the open project, and defaults to no', () => {
    expect(isLongstrip()).toBe(false);
    app.projectLayout = 'longstrip';
    expect(isLongstrip()).toBe(true);
  });
});

describe('editing a page other than the one the index is on', () => {
  const twoPages = () => [
    { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'one' }], boxes: [] },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'い', en: 'two' }], boxes: [] },
  ];

  beforeEach(() => {
    app.chapterRef = null;
    app.projectLayout = 'longstrip';
    loadProjectPages(twoPages());
    gotoPage(0);
  });

  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('places the box on the page it was handed', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pages[0].boxes).toHaveLength(0);
    expect(app.pages[1].boxes).toHaveLength(1);
  });

  // The live undo stack, the selection the inspector reads and the queue on
  // screen are all scoped to the current page, so an edit on another one has to
  // take the index with it or the record is filed against a page nobody is on.
  it('takes the index with it, so the record and the selection agree', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pageIndex).toBe(1);
    expect(byId(app.selectedId)).toBeTruthy();
  });

  it('gives the box the line it found on THAT page, and advances that page\'s queue', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pages[1].boxes[0].lineN).toBe(1);
    // Its only line is placed now, so its queue parks on the last one rather
    // than on nothing - and its box is what proves the placement landed there.
    expect(isPlaced(app.pages[1], 1)).toBe(true);
    // Page one is untouched: its line is still waiting to be placed.
    expect(isPlaced(app.pages[0], 1)).toBe(false);
    expect(app.pages[0].activeLineN).toBe(1);
  });

  it('writes a free-typed box and its line onto the target page too', () => {
    const id = addEmptyBox(120, 120, app.pages[1]);
    expect(app.pages[0].lines).toHaveLength(1);
    expect(app.pages[1].lines).toHaveLength(2);
    expect(app.pages[1].boxes.map((b) => b.id)).toEqual([id]);
    expect(app.pageIndex).toBe(1);
  });

  // The paged call site passes no target at all, and must go on meaning "the
  // page on screen" down to the character.
  it('still means the current page when no target is given', () => {
    gotoPage(1);
    placeActiveAt(100, 100);
    expect(app.pages[1].boxes).toHaveLength(1);
    expect(app.pages[0].boxes).toHaveLength(0);
    addEmptyBox(200, 200);
    expect(app.pages[1].boxes).toHaveLength(2);
  });

  describe('focusPage', () => {
    it('moves the index onto the page it is handed', () => {
      focusPage(app.pages[1]);
      expect(app.pageIndex).toBe(1);
    });

    it('does nothing for the page already current, or for one not in the document', () => {
      focusPage(app.pages[0]);
      expect(app.pageIndex).toBe(0);
      focusPage({ id: 99, boxes: [], lines: [] });
      expect(app.pageIndex).toBe(0);
      focusPage(null);
      expect(app.pageIndex).toBe(0);
    });
  });
});
