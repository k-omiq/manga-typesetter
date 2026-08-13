import { describe, it, expect, beforeEach } from 'vitest';
import {
  app,
  loadProjectPages,
  addEmptyBox,
  clampSidebarWidth,
  saveSidebar,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
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

// The read side of `mt.sidebar` runs once at module load and cannot be re-run
// from here, so what is testable without a DOM is the clamp it feeds the stored
// width through, and that the whole mechanism survives the environment this
// suite runs in — node has no `localStorage` at all.
describe('sidebar geometry persistence', () => {
  it('clamps a width to the range the rail can drag to', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN - 500)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(SIDEBAR_MAX + 500)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('saves without a storage to save to', () => {
    expect(() => saveSidebar()).not.toThrow();
  });

  it('leaves the defaults alone when nothing could be read', () => {
    expect(app.sidebarHidden).toBe(false);
    expect(clampSidebarWidth(app.leftWidth)).toBe(app.leftWidth);
  });
});
