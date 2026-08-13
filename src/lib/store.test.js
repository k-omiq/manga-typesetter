import { describe, it, expect, beforeEach } from 'vitest';
import { app, loadProjectPages, addEmptyBox } from './store.svelte.js';

const pageWith = (boxes) => ({
  id: 1,
  w: 800,
  h: 1200,
  lines: [],
  boxes,
});
const box = (id, extra = {}) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, ...extra });

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
    loadProjectPages([
      { ...pageWith([box('b40')]), id: 1 },
      { ...pageWith([box(undefined)]), id: 2 },
    ]);
    const minted = app.pages[1].boxes[0].id;
    expect(minted).toBe('b41');
  });

  it('seeds the counter so a box added after the load cannot collide', () => {
    loadProjectPages([pageWith([box('b120')])]);
    const id = addEmptyBox(100, 100);
    expect(id).toBe('b121');
  });
});
