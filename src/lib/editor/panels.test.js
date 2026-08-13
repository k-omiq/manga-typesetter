import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// The module debounces its writes, and the timer it leaves behind outlives the
// case that scheduled it. Every case runs on a fake clock so a write from one
// can never land in the middle of another.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

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

  it('leaves a panel that already fits exactly where it is', () => {
    const g = { x: 200, y: 300, w: 320, h: 400, hidden: false, z: 2 };
    expect(clampPanel(g, 1000, 800)).toEqual(g);
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

  // The defaults are laid out by width alone, so a short window is the one
  // case where falling back to them can park a panel out of reach.
  it('clamps the panel it falls back to, not just the one it kept', () => {
    const g = sanitize(null, 1000, 400);
    expect(g.queue.y).toBeLessThanOrEqual(400 - 32);
    expect(g.queue.h).toBeLessThanOrEqual(400 - 16);
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

  it('never lands a fresh layout below a short window', () => {
    loadPanels(fakeStorage(null), 1000, 400);
    expect(panels.queue.y).toBeLessThanOrEqual(400 - 32);
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

  // A blob saved before z existed loads both panels at the same depth. Being
  // level with the top is not being on top.
  it('still raises when the two panels are level', () => {
    loadPanels(
      fakeStorage(
        JSON.stringify({
          options: { x: 40, y: 40, w: 320, h: 400, hidden: false },
          queue: { x: 80, y: 80, w: 320, h: 400, hidden: false },
        }),
      ),
      1400,
      900,
    );
    expect(panels.options.z).toBe(panels.queue.z);
    raisePanel('options');
    expect(panels.options.z).toBeGreaterThan(panels.queue.z);
  });
});

// Every mutator debounces a write. Nothing above this point advances the
// clock, so without these cases the whole persistence half could be deleted
// and the suite would stay green.
describe('persistence', () => {
  beforeEach(() => {
    resetPanels(1400, 900);
    vi.clearAllTimers(); // the reset's own write is not what any case here is testing
  });

  it('writes the layout once the drag settles', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 120, 240);
    expect(s.dump()).toBe(null);
    vi.advanceTimersByTime(200);
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 120, y: 240 });
  });

  it('coalesces a burst of drag updates into one write', () => {
    const s = fakeStorage(null);
    let writes = 0;
    loadPanels(
      {
        getItem: () => null,
        setItem: (k, v) => {
          writes++;
          s.setItem(k, v);
        },
      },
      1400,
      900,
    );
    movePanel('queue', 100, 100);
    vi.advanceTimersByTime(100);
    movePanel('queue', 140, 160);
    vi.advanceTimersByTime(200);
    expect(writes).toBe(1);
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 140, y: 160 });
  });

  it('survives a storage that throws on write', () => {
    loadPanels(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
      1400,
      900,
    );
    movePanel('options', 40, 40);
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(panels.options.x).toBe(40);
  });
});
