import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  app,
  loadProjectPages,
  addEmptyBox,
  clampSidebarWidth,
  flushSave,
  sidebarFromJSON,
  saveSidebar,
  setSaver,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  setPageSwitchHook,
  gotoPage,
} from './store.svelte.js';

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
      gotoPage(1); // already there — nothing to hand over
      gotoPage(9); // out of range — refused before anything moves
      gotoPage(0);
      expect(seen).toEqual([
        [1, 2],
        [2, 1],
      ]);
    } finally {
      setPageSwitchHook(null);
    }
  });
});

// The read itself runs once at module load, in an environment with no
// `localStorage` at all — so the tests take the vetting the read delegates to,
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

  it('saves without a storage to save to', () => {
    expect(() => saveSidebar()).not.toThrow();
  });
});

// There is no manual save in this app, so the indicator is the user's only
// standing signal that their work is not reaching the disk. The debounce is not
// the risky path: `flushSave` is, because it runs on the way out — leaving the
// editor, quitting, opening another chapter — and it cancels the debounce as it
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

  // No chapter open is not a failed save — there was nothing to write.
  it('does not raise the failed state when there is nothing to flush', async () => {
    setSaver(() => Promise.reject(new Error('never called')));
    app.chapterRef = null;
    await flushSave();
    expect(app.saveFailed).toBe(false);
  });
});
