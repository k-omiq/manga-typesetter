import { describe, it, expect, beforeEach, vi } from 'vitest';

// An in-memory app data folder, in the shape library.test.js uses: a set of
// directory paths and a map of file path -> contents. Writes into a directory
// that does not exist fail the way the real ones do, so `mkdir` being missing
// would break something.
vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  const requireParent = (p) => {
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent && !tree.dirs.has(parent)) throw new Error('ENOENT ' + parent);
  };
  return {
    fsx: {
      _tree: tree,
      // The seam a test uses to break one write - see "reports a tip it could
      // not write". Keyed by path; the value is the message to throw.
      _fail: new Map(),
      async appDataDir() {
        return '/appdata';
      },
      async join(...parts) {
        return parts.join('/');
      },
      async exists(p) {
        return tree.dirs.has(p) || tree.files.has(p);
      },
      async mkdir(p) {
        const parts = p.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (d) tree.dirs.add(d);
        }
      },
      async readTextFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeTextFileAtomic(p, c) {
        if (this._fail.has(p)) throw new Error(this._fail.get(p));
        requireParent(p);
        tree.files.set(p, c);
      },
      async readFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeFileAtomic(p, bytes) {
        if (this._fail.has(p)) throw new Error(this._fail.get(p));
        requireParent(p);
        tree.files.set(p, bytes);
      },
      async remove(p) {
        for (const d of [...tree.dirs]) if (d === p || d.startsWith(p + '/')) tree.dirs.delete(d);
        for (const f of [...tree.files.keys()]) if (f === p || f.startsWith(p + '/')) tree.files.delete(f);
      },
    },
  };
});

// What the Rust command answers with. `h.result` is the next ImportResult;
// `h.throws` makes the invoke itself fail, the way a command that is not
// registered does.
const h = vi.hoisted(() => ({ calls: [], result: null, throws: null }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke(cmd, args) {
    h.calls.push([cmd, args]);
    if (h.throws) return Promise.reject(new Error(h.throws));
    return Promise.resolve(h.result);
  },
}));

const { fsx } = await import('./fsx.js');
const {
  installedBrushes,
  brushLibrary,
  loadBrushLibrary,
  importBrushes,
  getBrush,
  resolveBrush,
  brushTip,
  removeBrush,
  brushDir,
  sanitiseBrushSettings,
  __resetBrushLibrary,
  BUILTIN_BRUSH,
  INDEX_SCHEMA,
} = await import('./brush-library.svelte.js');

const DIR = '/appdata/brushes';
const INDEX = `${DIR}/library.json`;

// The IPC shape: `tipPng` arrives as a plain array of bytes, camelCase keys.
const brush = (id, over = {}) => ({
  id,
  name: `Brush ${id}`,
  tipPng: [137, 80, 78, 71, id.charCodeAt(0)],
  width: 64,
  height: 64,
  source: 'pixels',
  diff: 3.5,
  settings: {
    size: 48,
    opacity: 0.9,
    spacing: 7,
    hardness: 80,
    angle: 15,
    angleJitter: 4,
    flatness: 0.8,
    antialias: true,
    taperIn: { on: true, len: 30, ratio: 70 },
    taperOut: { on: false, len: 10, ratio: 20 },
    waterEdge: false,
    waterEdgeWidth: 4,
    waterEdgePower: 0.5,
    stabilise: 20,
    sharpAngles: { on: true, deg: 60 },
  },
  ...over,
});

const withTauri = () => {
  globalThis.window = { __TAURI_INTERNALS__: {} };
};
const withoutTauri = () => {
  delete globalThis.window;
};

beforeEach(() => {
  fsx._tree.dirs.clear();
  fsx._tree.files.clear();
  fsx._fail.clear();
  h.calls.length = 0;
  h.result = null;
  h.throws = null;
  __resetBrushLibrary();
  withTauri();
});

describe('loading', () => {
  it('is empty and not an error when nothing has been installed', async () => {
    await loadBrushLibrary();
    expect(installedBrushes).toHaveLength(0);
    expect(brushLibrary.loaded).toBe(true);
    expect(brushLibrary.error).toBe('');
  });

  it('reads the installed brushes out of library.json', async () => {
    await fsx.mkdir(DIR);
    fsx._tree.files.set(
      INDEX,
      JSON.stringify({
        schema: 1,
        brushes: [
          { id: 'aaa', name: 'Ink', width: 10, height: 20, source: 'thumbnail', diff: null, pngFile: 'aaa.png', settings: {} },
        ],
      }),
    );
    await loadBrushLibrary();
    expect(installedBrushes).toHaveLength(1);
    expect(installedBrushes[0].name).toBe('Ink');
    expect(installedBrushes[0].source).toBe('thumbnail');
    // A row with no settings still comes back with the engine's whole vocabulary.
    expect(installedBrushes[0].settings.spacing).toBe(10);
  });

  it('drops a row with no usable id, and one calling itself the built-in tip', async () => {
    await fsx.mkdir(DIR);
    fsx._tree.files.set(
      INDEX,
      JSON.stringify({
        schema: 1,
        brushes: [
          { id: '../escape', name: 'Bad' },
          { id: BUILTIN_BRUSH, name: 'Impostor' },
          { id: 'good', name: 'Good' },
        ],
      }),
    );
    await loadBrushLibrary();
    expect(installedBrushes.map((b) => b.id)).toEqual(['good']);
  });

  it('tolerates a corrupt library.json and leaves the folder alone', async () => {
    await fsx.mkdir(DIR);
    fsx._tree.files.set(INDEX, '{ not json at all');
    fsx._tree.files.set(`${DIR}/aaa.png`, Uint8Array.from([1, 2, 3]));
    await loadBrushLibrary();
    expect(installedBrushes).toHaveLength(0);
    expect(brushLibrary.error).toMatch(/could not be read/i);
    // The tips are the only copy of the pixels; a bad index never deletes them.
    expect(fsx._tree.files.has(`${DIR}/aaa.png`)).toBe(true);
    expect(fsx._tree.files.get(INDEX)).toBe('{ not json at all');
  });

  it('reads once however many callers ask, until forced', async () => {
    await Promise.all([loadBrushLibrary(), loadBrushLibrary(), loadBrushLibrary()]);
    await fsx.mkdir(DIR);
    fsx._tree.files.set(INDEX, JSON.stringify({ schema: 1, brushes: [{ id: 'later', name: 'Later' }] }));
    await loadBrushLibrary();
    expect(installedBrushes).toHaveLength(0);
    await loadBrushLibrary({ force: true });
    expect(installedBrushes.map((b) => b.id)).toEqual(['later']);
  });
});

describe('importBrushes', () => {
  it('writes a tip file and an index, and counts what it added', async () => {
    h.result = { brushes: [brush('aaa'), brush('bbb')], errors: [] };
    const out = await importBrushes(['/x/one.sut']);
    expect(h.calls[0]).toEqual(['brush_import', { paths: ['/x/one.sut'] }]);
    expect(out).toEqual({ added: 2, replaced: 0, previewQuality: 0, errors: [] });
    expect(fsx._tree.files.has(`${DIR}/aaa.png`)).toBe(true);
    expect(fsx._tree.files.has(`${DIR}/bbb.png`)).toBe(true);
    const idx = JSON.parse(fsx._tree.files.get(INDEX));
    expect(idx.schema).toBe(INDEX_SCHEMA);
    expect(idx.brushes.map((b) => b.id)).toEqual(['aaa', 'bbb']);
    expect(installedBrushes.map((b) => b.id)).toEqual(['aaa', 'bbb']);
  });

  it('keeps the imported settings on the entry, without the keys a .sut cannot speak for', async () => {
    h.result = { brushes: [brush('aaa')], errors: [] };
    await importBrushes(['/x/one.sut']);
    const s = getBrush('aaa').settings;
    expect(s.size).toBe(48);
    expect(s.taperIn).toEqual({ on: true, len: 30, ratio: 70 });
    expect(s.sharpAngles).toEqual({ on: true, deg: 60 });
    // Colour, dynamics and the selected brush belong to the tool, not the file.
    expect(s.color).toBeUndefined();
    expect(s.dyn).toBeUndefined();
    expect(s.brush).toBeUndefined();
  });

  it('counts every tip that is not full-resolution pixels as preview quality', async () => {
    h.result = {
      brushes: [brush('aaa'), brush('bbb', { source: 'thumbnail' }), brush('ccc', { source: 'round' })],
      errors: [],
    };
    const out = await importBrushes(['/x/one.sut']);
    expect(out.added).toBe(3);
    expect(out.previewQuality).toBe(2);
  });

  it('passes the per-file errors through beside the brushes it did install', async () => {
    h.result = { brushes: [brush('aaa')], errors: [{ path: '/x/photo.jpg', error: 'not a .sut' }] };
    const out = await importBrushes(['/x/one.sut', '/x/photo.jpg']);
    expect(out.added).toBe(1);
    expect(out.errors).toEqual([{ path: '/x/photo.jpg', error: 'not a .sut' }]);
    expect(installedBrushes).toHaveLength(1);
  });

  it('replaces a re-imported brush where it stands rather than duplicating it', async () => {
    h.result = { brushes: [brush('aaa'), brush('bbb'), brush('ccc')], errors: [] };
    await importBrushes(['/x/one.sut']);
    h.result = { brushes: [brush('bbb', { name: 'Renamed', settings: { size: 99 } })], errors: [] };
    const out = await importBrushes(['/x/one-copy.sut']);
    expect(out).toEqual({ added: 1, replaced: 1, previewQuality: 0, errors: [] });
    expect(installedBrushes.map((b) => b.id)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(getBrush('bbb').name).toBe('Renamed');
    expect(getBrush('bbb').settings.size).toBe(99);
  });

  it('reports a tip it could not write and leaves it out of the index', async () => {
    fsx._fail.set(`${DIR}/bbb.png`, 'the disk is full');
    h.result = { brushes: [brush('aaa'), brush('bbb')], errors: [] };
    const out = await importBrushes(['/x/one.sut']);
    expect(out.added).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].error).toMatch(/could not be written/);
    expect(installedBrushes.map((b) => b.id)).toEqual(['aaa']);
    expect(JSON.parse(fsx._tree.files.get(INDEX)).brushes.map((b) => b.id)).toEqual(['aaa']);
  });

  it('leaves memory agreeing with disk when the index cannot be written', async () => {
    fsx._fail.set(INDEX, 'read-only volume');
    h.result = { brushes: [brush('aaa')], errors: [] };
    const out = await importBrushes(['/x/one.sut']);
    expect(out.added).toBe(0);
    expect(out.errors.at(-1).error).toMatch(/index could not be written/);
    expect(installedBrushes).toHaveLength(0);
  });

  it('reports a command that failed outright, once per file, without throwing', async () => {
    h.throws = 'command brush_import not found';
    const out = await importBrushes(['/x/one.sut', '/x/two.sut']);
    expect(out.added).toBe(0);
    expect(out.errors.map((e) => e.path)).toEqual(['/x/one.sut', '/x/two.sut']);
    expect(out.errors[0].error).toMatch(/brush_import/);
  });

  it('does nothing when handed no paths', async () => {
    const out = await importBrushes([]);
    expect(out).toEqual({ added: 0, replaced: 0, previewQuality: 0, errors: [] });
    expect(h.calls).toHaveLength(0);
  });
});

describe('id stability', () => {
  it('round-trips ids, order and settings through library.json', async () => {
    h.result = { brushes: [brush('aaa'), brush('bbb', { source: 'thumbnail', diff: null })], errors: [] };
    await importBrushes(['/x/one.sut']);
    const before = installedBrushes.map((b) => ({ ...b, settings: { ...b.settings } }));

    // A fresh boot against the same folder.
    __resetBrushLibrary();
    await loadBrushLibrary();

    expect(installedBrushes.map((b) => b.id)).toEqual(['aaa', 'bbb']);
    expect(installedBrushes[1].source).toBe('thumbnail');
    expect(installedBrushes[1].diff).toBe(null);
    expect(installedBrushes[0].settings).toEqual(before[0].settings);
    expect(installedBrushes[0].pngFile).toBe('aaa.png');
  });
});

describe('resolveBrush', () => {
  beforeEach(async () => {
    h.result = { brushes: [brush('aaa')], errors: [] };
    await importBrushes(['/x/one.sut']);
  });

  it('gives back the installed entry', () => {
    expect(resolveBrush('aaa').name).toBe('Brush aaa');
    expect(resolveBrush('aaa').missing).toBeUndefined();
  });

  it('reads the built-in round tip as built-in, not as missing', () => {
    expect(resolveBrush(BUILTIN_BRUSH)).toEqual({ id: BUILTIN_BRUSH, builtin: true });
    expect(resolveBrush('')).toEqual({ id: BUILTIN_BRUSH, builtin: true });
  });

  it('falls a project referencing a brush this install lacks back to the round tip, and says so', () => {
    expect(resolveBrush('nothere')).toEqual({ id: 'nothere', builtin: true, missing: true });
    // The id is kept, never rewritten: importing the .sut later brings the tip
    // back to the strokes that have been round in the meantime.
    expect(resolveBrush('nothere').id).toBe('nothere');
  });
});

describe('brushTip', () => {
  beforeEach(async () => {
    h.result = { brushes: [brush('aaa')], errors: [] };
    await importBrushes(['/x/one.sut']);
  });

  it('reads the tip file and hands back the wrapper the stamper draws with', async () => {
    const tip = await brushTip('aaa');
    expect(tip.id).toBe('aaa');
    expect(tip.width).toBe(64);
    expect(tip.source).toBe('pixels');
    expect([...tip.bytes]).toEqual([137, 80, 78, 71, 'a'.charCodeAt(0)]);
    // No image decoder under node, and that is not a failure.
    expect(tip.image).toBe(null);
  });

  it('decodes once per brush', async () => {
    const a = await brushTip('aaa');
    fsx._tree.files.delete(`${DIR}/aaa.png`);
    const b = await brushTip('aaa');
    expect(b).toBe(a);
  });

  it('is null for a brush that is not installed, and for one whose file is gone', async () => {
    expect(await brushTip('nothere')).toBe(null);
    fsx._tree.files.delete(`${DIR}/aaa.png`);
    __resetBrushLibrary();
    await loadBrushLibrary();
    expect(await brushTip('aaa')).toBe(null);
  });
});

describe('removeBrush', () => {
  beforeEach(async () => {
    h.result = { brushes: [brush('aaa'), brush('bbb')], errors: [] };
    await importBrushes(['/x/one.sut']);
  });

  it('drops the entry, the index row and the tip file', async () => {
    expect(await removeBrush('aaa')).toBe(true);
    expect(installedBrushes.map((b) => b.id)).toEqual(['bbb']);
    expect(JSON.parse(fsx._tree.files.get(INDEX)).brushes.map((b) => b.id)).toEqual(['bbb']);
    expect(fsx._tree.files.has(`${DIR}/aaa.png`)).toBe(false);
    expect(fsx._tree.files.has(`${DIR}/bbb.png`)).toBe(true);
  });

  it('says so when there was nothing to remove', async () => {
    expect(await removeBrush('nothere')).toBe(false);
    expect(installedBrushes).toHaveLength(2);
  });

  it('leaves strokes drawn with it reading as missing, not rewritten', async () => {
    await removeBrush('aaa');
    expect(resolveBrush('aaa')).toEqual({ id: 'aaa', builtin: true, missing: true });
  });
});

describe('without a Tauri host', () => {
  beforeEach(() => withoutTauri());

  it('loads an empty library and calls it no error', async () => {
    await loadBrushLibrary();
    expect(installedBrushes).toHaveLength(0);
    expect(brushLibrary.loaded).toBe(true);
    expect(brushLibrary.error).toBe('');
  });

  it('reports one clear error per path instead of throwing', async () => {
    const out = await importBrushes(['/x/one.sut', '/x/two.sut']);
    expect(out.added).toBe(0);
    expect(out.errors.map((e) => e.path)).toEqual(['/x/one.sut', '/x/two.sut']);
    expect(out.errors[0].error).toMatch(/desktop app/i);
    expect(h.calls).toHaveLength(0);
    expect(fsx._tree.files.size).toBe(0);
  });

  it('removes nothing', async () => {
    expect(await removeBrush('aaa')).toBe(false);
  });
});

describe('sanitiseBrushSettings', () => {
  it('falls each junk value back to the engine default rather than the whole set', () => {
    const s = sanitiseBrushSettings({ size: 'huge', spacing: 7, hardness: 500, taperIn: null });
    expect(s.size).toBe(24);
    expect(s.spacing).toBe(7);
    expect(s.hardness).toBe(100);
    expect(s.taperIn).toEqual({ on: true, len: 20, ratio: 60 });
  });

  it('treats a null as absent rather than as the zero it coerces to', () => {
    const s = sanitiseBrushSettings({ size: null, spacing: null, opacity: null });
    expect(s.size).toBe(24);
    expect(s.spacing).toBe(10);
    expect(s.opacity).toBe(1);
  });

  it('wraps an angle and floors a flatness that would leave no area', () => {
    expect(sanitiseBrushSettings({ angle: -90 }).angle).toBe(270);
    expect(sanitiseBrushSettings({ flatness: 0 }).flatness).toBe(0.01);
  });
});

describe('brushDir', () => {
  it('is a brushes folder inside the app data directory', async () => {
    expect(await brushDir()).toBe(DIR);
  });
});
