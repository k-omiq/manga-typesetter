import { describe, it, expect, beforeEach } from 'vitest';
import {
  panels,
  PANEL_IDS,
  MIN_W,
  MIN_H,
  defaultGeometry,
  clampPanel,
  sanitize,
  loadPanels,
  movePanel,
  resizePanel,
  raisePanel,
  setHidden,
  resetPanels,
  serializePanels,
  clampAll,
} from './panels.svelte.js';

const fakeStorage = (initial) => {
  let v = initial;
  return {
    getItem: () => v,
    setItem: (_k, next) => (v = next),
    dump: () => v,
  };
};

describe('defaults', () => {
  it('parks both panels down the right edge', () => {
    const g = defaultGeometry(1400);
    expect(g.options.x).toBe(1400 - 320 - 16);
    expect(g.queue.x).toBe(g.options.x);
    expect(g.queue.y).toBeGreaterThan(g.options.y);
    expect(g.options.hidden).toBe(false);
  });

  it('does not park a panel off the left of a narrow window', () => {
    expect(defaultGeometry(200).options.x).toBe(16);
  });
});

describe('clampPanel', () => {
  it('keeps a grab-able strip on screen when the window shrinks', () => {
    const c = clampPanel({ x: 3000, y: 4000, w: 320, h: 400, hidden: false }, 1000, 800);
    expect(c.x).toBeLessThanOrEqual(1000 - 120);
    expect(c.y).toBeLessThanOrEqual(800 - 32);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
  });

  it('refuses a panel smaller than a usable one', () => {
    const c = clampPanel({ x: 0, y: 0, w: 10, h: 10, hidden: false }, 1000, 800);
    expect(c.w).toBe(MIN_W);
    expect(c.h).toBe(MIN_H);
  });

  it('keeps a hidden panel reachable too', () => {
    const c = clampPanel({ x: 5000, y: 5000, w: 320, h: 400, hidden: true }, 1000, 800);
    expect(c.x).toBeLessThanOrEqual(1000 - 120);
    expect(c.hidden).toBe(true);
  });
});

describe('sanitize', () => {
  it('falls back to defaults for a corrupt blob', () => {
    expect(sanitize('not json at all', 1400, 900)).toEqual(defaultGeometry(1400));
  });

  it('falls back per panel, keeping the half that is valid', () => {
    const g = sanitize({ options: { x: 40, y: 60, w: 300, h: 300, hidden: true } }, 1400, 900);
    expect(g.options.x).toBe(40);
    expect(g.options.hidden).toBe(true);
    expect(g.queue).toEqual(defaultGeometry(1400).queue);
  });

  it('drops values of the wrong type instead of trusting them', () => {
    const g = sanitize({ options: { x: 'left', y: null, w: 300, h: 300, hidden: 'yes' } }, 1400, 900);
    expect(g.options).toEqual(defaultGeometry(1400).options);
  });
});

describe('the live state', () => {
  beforeEach(() => resetPanels(1400, 900));

  it('round-trips through storage', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 100, 200);
    setHidden('options', true);
    const written = JSON.parse(serializePanels());
    const s2 = fakeStorage(JSON.stringify(written));
    resetPanels(1400, 900);
    loadPanels(s2, 1400, 900);
    expect(panels.queue.x).toBe(100);
    expect(panels.queue.y).toBe(200);
    expect(panels.options.hidden).toBe(true);
  });

  it('survives a storage that throws', () => {
    const s = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    expect(() => loadPanels(s, 1400, 900)).not.toThrow();
    expect(panels.options).toEqual(defaultGeometry(1400).options);
  });

  it('clamps everything when the window resizes', () => {
    loadPanels(fakeStorage(null), 1400, 900);
    movePanel('options', 1300, 850);
    clampAll(600, 400);
    expect(panels.options.x).toBeLessThanOrEqual(600 - 120);
    expect(panels.options.y).toBeLessThanOrEqual(400 - 32);
  });

  it('has an id list the UI can iterate', () => {
    expect(PANEL_IDS).toEqual(['options', 'queue']);
  });
});

// The two mutators the brief's own cases do not reach. They are the ones the
// drag/resize component will lean on hardest, so they get a case each.
describe('resize and raise', () => {
  beforeEach(() => resetPanels(1400, 900));

  it('will not resize a panel below a usable size', () => {
    resizePanel('queue', 10, 10);
    expect(panels.queue.w).toBe(MIN_W);
    expect(panels.queue.h).toBe(MIN_H);
  });

  it('puts the raised panel above the other one', () => {
    raisePanel('options');
    expect(panels.options.z).toBeGreaterThan(panels.queue.z);
    raisePanel('queue');
    expect(panels.queue.z).toBeGreaterThan(panels.options.z);
  });
});
