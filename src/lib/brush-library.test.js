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
      // The seam a test uses to make one write slow: path -> how many ticks it
      // takes. A concurrency test needs to choose who finishes first rather
      // than hoping the microtask order obliges.
      _slow: new Map(),
      // Null without a host, exactly as the real one is.
      async appDataDir() {
        return globalThis.window?.__TAURI_INTERNALS__ ? '/appdata' : null;
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
        // A real write is a round trip. Yielding here is what gives two
        // concurrent writers a window to interleave in, which is the whole of
        // what the queue exists to close.
        await Promise.resolve();
        if (this._fail.has(p)) throw new Error(this._fail.get(p));
        requireParent(p);
        tree.files.set(p, c);
      },
      async readFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeFileAtomic(p, bytes) {
        for (let i = 0, n = this._slow.get(p) ?? 1; i < n; i++) await Promise.resolve();
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
// `h.byPath` answers per requested path instead, which is how two imports can
// be in flight at once with different payloads; `h.throws` makes the invoke
// itself fail, the way a command that is not registered does.
const h = vi.hoisted(() => ({ calls: [], result: null, byPath: null, throws: null }));

vi.mock('@tauri-apps/api/core', () => ({
  async invoke(cmd, args) {
    h.calls.push([cmd, args]);
    if (h.throws) throw new Error(h.throws);
    if (h.byPath) {
      // A real command is a round trip; yielding here is what lets two callers
      // actually interleave rather than running one after the other by luck.
      await Promise.resolve();
      return { brushes: args.paths.flatMap((p) => h.byPath[p] ?? []), errors: [] };
    }
    return h.result;
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
  forgetBrushTips,
  removeBrush,
  brushDir,
  sanitiseBrushSettings,
  __resetBrushLibrary,
  BUILTIN_BRUSH,
  INDEX_SCHEMA,
  TIP_BUDGET_PX,
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
  fsx._slow.clear();
  h.calls.length = 0;
  h.result = null;
  h.byPath = null;
  h.throws = null;
  delete globalThis.createImageBitmap;
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

  it('ignores a pngFile a hand edit put in the index', async () => {
    await fsx.mkdir(DIR);
    fsx._tree.files.set(
      INDEX,
      JSON.stringify({
        schema: 1,
        brushes: [{ id: 'aaa', name: 'Ink', pngFile: '../../../Documents/thesis.png' }],
      }),
    );
    await loadBrushLibrary();
    // Derived from the id, which is already known to be a plain name - so a
    // later removeBrush unlinks a tip and never somebody's document.
    expect(installedBrushes[0].pngFile).toBe('aaa.png');
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

  it('installs one brush when a batch yields the same id twice', async () => {
    // The same file selected twice, or two copies of it under other names - the
    // id is hashed from the bytes, so both come back as one brush.
    h.result = { brushes: [brush('aaa'), brush('aaa', { name: 'Copy' })], errors: [] };
    const out = await importBrushes(['/x/one.sut', '/x/one-again.sut']);
    expect(out).toEqual({ added: 1, replaced: 0, previewQuality: 0, errors: [] });
    expect(installedBrushes.map((b) => b.id)).toEqual(['aaa']);
    expect(getBrush('aaa').name).toBe('Brush aaa');
  });

  it('does not let two imports in flight at once clobber each other', async () => {
    // One import first, so the lazily-imported Tauri module and the resolved
    // folder are both warm and the two below really do race rather than one
    // waiting on the other's module load.
    h.result = { brushes: [brush('zzz')], errors: [] };
    await importBrushes(['/x/warm.sut']);

    h.result = null;
    h.byPath = { '/x/one.sut': [brush('aaa')], '/x/two.sut': [brush('bbb')] };
    // The first import's tip takes its time, so the second would otherwise
    // finish and commit while the first still holds the pre-import list.
    fsx._slow.set(`${DIR}/aaa.png`, 20);
    const [r1, r2] = await Promise.all([
      importBrushes(['/x/one.sut']),
      importBrushes(['/x/two.sut']),
    ]);
    expect(r1.added).toBe(1);
    expect(r2.added).toBe(1);
    // Both survive: the second import read the list only once the first had
    // committed, rather than building its index from the same starting point.
    expect(installedBrushes.map((b) => b.id).sort()).toEqual(['aaa', 'bbb', 'zzz']);
    expect(
      JSON.parse(fsx._tree.files.get(INDEX))
        .brushes.map((b) => b.id)
        .sort(),
    ).toEqual(['aaa', 'bbb', 'zzz']);
  });

  it('does not let a removal in flight lose a concurrent import', async () => {
    h.result = { brushes: [brush('aaa'), brush('bbb')], errors: [] };
    await importBrushes(['/x/one.sut']);
    h.byPath = { '/x/two.sut': [brush('ccc')] };
    const [gone, imported] = await Promise.all([
      removeBrush('aaa'),
      importBrushes(['/x/two.sut']),
    ]);
    expect(gone).toBe(true);
    expect(imported.added).toBe(1);
    expect(installedBrushes.map((b) => b.id).sort()).toEqual(['bbb', 'ccc']);
    expect(
      JSON.parse(fsx._tree.files.get(INDEX))
        .brushes.map((b) => b.id)
        .sort(),
    ).toEqual(['bbb', 'ccc']);
  });
});

describe('an index from a newer version', () => {
  beforeEach(async () => {
    await fsx.mkdir(DIR);
    fsx._tree.files.set(
      INDEX,
      JSON.stringify({ schema: INDEX_SCHEMA + 1, brushes: [{ id: 'aaa', name: 'Future' }] }),
    );
    await loadBrushLibrary();
  });

  it('loads nothing and says why, rather than reading the rows it recognises', () => {
    expect(installedBrushes).toHaveLength(0);
    expect(brushLibrary.readOnly).toBe(true);
    expect(brushLibrary.error).toMatch(/newer version/i);
  });

  it('refuses to import over it', async () => {
    h.result = { brushes: [brush('bbb')], errors: [] };
    const out = await importBrushes(['/x/one.sut']);
    expect(out.added).toBe(0);
    expect(out.errors[0].error).toMatch(/newer version/i);
    // The command is never even asked, and the index is exactly as it was.
    expect(h.calls).toHaveLength(0);
    expect(JSON.parse(fsx._tree.files.get(INDEX)).schema).toBe(INDEX_SCHEMA + 1);
  });

  it('refuses to remove from it', async () => {
    expect(await removeBrush('aaa')).toBe(false);
    expect(JSON.parse(fsx._tree.files.get(INDEX)).schema).toBe(INDEX_SCHEMA + 1);
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

  it('drops the raw PNG once there is a decoded image to draw with', async () => {
    fakeDecoder();
    const tip = await brushTip('aaa');
    expect(tip.image).toBeTruthy();
    // Held once, not twice: the bitmap is the drawable and the PNG behind it is
    // dead weight the moment it exists.
    expect(tip.bytes).toBe(null);
  });
});

// A decoder the node runner does not have. Returns the list of bitmaps that
// have been close()d, which is the whole of the lifetime contract.
function fakeDecoder() {
  const closed = [];
  globalThis.createImageBitmap = async () => ({
    width: 1,
    height: 1,
    close() {
      closed.push(this);
    },
  });
  return closed;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the tip cache', () => {
  // 10 MP each, so two fit inside the budget and three do not.
  const BIG = { width: 4000, height: 2500 };

  beforeEach(async () => {
    h.result = { brushes: [brush('aaa', BIG), brush('bbb', BIG), brush('ccc', BIG)], errors: [] };
    await importBrushes(['/x/one.sut']);
  });

  it('is bounded by a decoded-pixel budget, not by brush count', () => {
    // 24 MP is ~96 MB of RGBA. The corpus's largest tip alone decodes to 107 MB,
    // so an unbounded cache is a webview OOM rather than a slow leak.
    expect(TIP_BUDGET_PX).toBe(24_000_000);
    expect(BIG.width * BIG.height * 3).toBeGreaterThan(TIP_BUDGET_PX);
  });

  it('evicts the least recently used tip when the budget is passed', async () => {
    const a1 = await brushTip('aaa');
    const c1 = await brushTip('ccc');
    await brushTip('bbb'); // 30 MP cached; aaa is oldest and goes

    // ccc was used after aaa and is still the same object.
    expect(await brushTip('ccc')).toBe(c1);
    // A re-read is how an eviction is visible: the file answers differently now.
    fsx._tree.files.set(`${DIR}/aaa.png`, Uint8Array.from([9, 9, 9]));
    const a2 = await brushTip('aaa');
    expect(a2).not.toBe(a1);
    expect([...a2.bytes]).toEqual([9, 9, 9]);
  });

  it('counts a hit as a use, so touching a tip saves it from the next eviction', async () => {
    const a1 = await brushTip('aaa');
    const b1 = await brushTip('bbb');
    expect(await brushTip('aaa')).toBe(a1); // touch: bbb is now the oldest
    await brushTip('ccc');

    expect(await brushTip('aaa')).toBe(a1);
    fsx._tree.files.set(`${DIR}/bbb.png`, Uint8Array.from([7]));
    const b2 = await brushTip('bbb');
    expect(b2).not.toBe(b1);
  });

  it('lets go of an evicted bitmap without closing it', async () => {
    const closed = fakeDecoder();
    await brushTip('aaa');
    await brushTip('bbb');
    await brushTip('ccc');
    await flush();
    // A painter mid-frame may still hold the evicted one; closing it under
    // drawImage throws, so eviction only drops the reference.
    expect(closed).toHaveLength(0);
  });

  it('lets go of a removed brush without closing its bitmap either', async () => {
    const closed = fakeDecoder();
    await brushTip('aaa');
    await removeBrush('aaa');
    await flush();
    expect(closed).toHaveLength(0);
  });

  it('closes every bitmap in forgetBrushTips, which is chapter teardown', async () => {
    const closed = fakeDecoder();
    await brushTip('aaa');
    await brushTip('bbb');
    forgetBrushTips();
    await flush();
    expect(closed).toHaveLength(2);
  });

  it('re-reads a tip that was dropped by a re-import', async () => {
    const a1 = await brushTip('aaa');
    h.result = { brushes: [brush('aaa', { ...BIG, tipPng: [5, 5] })], errors: [] };
    await importBrushes(['/x/one.sut']);
    const a2 = await brushTip('aaa');
    expect(a2).not.toBe(a1);
    expect([...a2.bytes]).toEqual([5, 5]);
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

  it('has no brush folder to name', async () => {
    expect(await brushDir()).toBe(null);
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
