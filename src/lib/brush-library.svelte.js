// ===== The installed brush library =====
//
// Brushes are app-wide, not per-project. A letterer imports a `.sut` once and
// every chapter they open afterwards can draw with it, so the tips live in a
// folder beside the app's own data rather than inside any one project, and a
// saved stroke stores only the brush's `id`.
//
// On disk, under `<appDataDir>/brushes/`:
//
//   library.json          the index - see `INDEX_SCHEMA` and `sanitiseEntry`
//   <id>.png              one 8-bit greyscale tip per brush, ink at 255
//
// Two files rather than one blob because the tips are the big part (the largest
// in the corpus is 2352 x 11394) and the index is the part that is rewritten on
// every import. Reading the index costs a JSON parse; a tip's bytes are read
// only when something is about to stamp with it.
//
// Nothing here may throw at a caller. A missing folder is an empty library, an
// unreadable index is an empty library that says so, and a plain browser with
// no Tauri host - `vite dev`, the test runner - is an empty library too. The
// panel that shows this list has no error path of its own and must not need one.
//
// ---------------------------------------------------------------------------
// THE TIP LIFETIME CONTRACT - read this before stamping with a tip (2.4)
// ---------------------------------------------------------------------------
//
// A decoded tip is an `ImageBitmap`, whose pixels live OUTSIDE the JS heap and
// are not counted by anything that watches heap size. That corpus tip decodes
// to 2352 * 11394 * 4 = 107 MB; a hundred of them is the class of leak this app
// has already had to fix twice. So:
//
//   * The cache is bounded by `TIP_BUDGET_PX` decoded pixels and evicts least
//     recently used first. An evicted tip is simply DROPPED - the cache lets go
//     of its reference and the collector reclaims the bitmap once the last
//     painter holding it has finished. It is never `close()`d on eviction,
//     because a painter mid-frame may still be drawing with it and closing a
//     bitmap out from under `drawImage` throws.
//   * `close()` happens in exactly one place, `forgetBrushTips()`, which is for
//     chapter teardown - the moment when no painter is live.
//
// What that asks of a painter: hold a tip across ONE frame, never across a
// chapter close. Re-ask `brushTip(id)` next frame; a hit is a map lookup, and a
// miss re-reads a file that is already in the OS page cache.
import { fsx } from './fsx.js';
import { defaultBrushSettings, dynCurve, DYN_SOURCES } from './brush.js';

// The version stamped into library.json. Bumped when the entry shape changes in
// a way `sanitiseEntry` cannot absorb, which it has not yet had to be.
export const INDEX_SCHEMA = 1;

// The id of the engine's own round tip. Never an imported brush's id (see
// `sanitiseEntry`), so `brush: 'round'` on a stroke is unambiguous, and it is
// what a stroke falls back to when its brush is gone.
export const BUILTIN_BRUSH = 'round';

// How many decoded tip pixels may be cached at once. 24 MP is ~96 MB of RGBA -
// enough for a working set of a dozen ordinary tips, and small enough that the
// worst case is a fraction of the webview's budget rather than a multiple of it.
export const TIP_BUDGET_PX = 24_000_000;

const DIR_NAME = 'brushes';
const INDEX_NAME = 'library.json';

// What the Rust ladder can produce. Anything else in a hand-edited index is
// read as full-resolution pixels rather than dropping the brush.
const SOURCES = ['pixels', 'thumbnail', 'round'];

const NO_HOST =
  'Brush import needs the desktop app; the browser preview cannot read brush files.';

const FROM_FUTURE =
  'The brush library was written by a newer version of this app. No brushes are ' +
  'loaded, and importing is off so nothing here overwrites it. Update to use them.';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// The installed brushes, in the order the picker shows them: oldest import
// first, and a re-import keeps its brush where it was rather than jumping it to
// the end. Mutated in place, never reassigned - a component that captured this
// array is looking at the live one.
export const installedBrushes = $state([]);

// Everything about the list that is not the list. Separate so a picker can bind
// to `installedBrushes` directly without reaching through a wrapper.
export const brushLibrary = $state({
  loading: false,
  // True once a load has finished, successfully or not. An empty list plus
  // `loaded` is "you have no brushes"; an empty list without it is "not yet".
  loaded: false,
  // Set only when the library on disk was there and could not be used. A
  // missing folder is not an error, and neither is running without Tauri.
  error: '',
  // The index on disk is from a schema this build does not know. Nothing may be
  // written over it - see `FROM_FUTURE`.
  readOnly: false,
});

// ---------------------------------------------------------------------------
// Host and paths
// ---------------------------------------------------------------------------

// Is there a Tauri host? Asked per call and never remembered - the same module
// runs under `vite dev` in a plain browser and under the node test runner, and
// in both the answer is no. Same predicate as fsx.js's, for the same reason.
const inTauri = () =>
  typeof globalThis !== 'undefined' && !!globalThis.window?.__TAURI_INTERNALS__;

let coreMod = null;
async function getInvoke() {
  if (!inTauri()) return null;
  if (!coreMod) coreMod = await import('@tauri-apps/api/core');
  return coreMod.invoke;
}

let dirCache = null;

// `<appDataDir>/brushes`, or null where there is no app data directory to be
// inside - which is fsx's convention for a path only a Tauri host can answer
// (see `assetUrl`). Resolved once and remembered; a failure is not remembered,
// so a call that lost the race with the host coming up can retry.
export async function brushDir() {
  if (dirCache) return dirCache;
  const base = await fsx.appDataDir();
  if (!base) return null;
  dirCache = await fsx.join(base, DIR_NAME);
  return dirCache;
}

async function indexPath() {
  const dir = await brushDir();
  return dir && fsx.join(dir, INDEX_NAME);
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

// A clamped number, or the default. Only a real number - or a string that is
// one - counts: `Number(null)` and `Number([])` are both 0, and a setting that
// is missing must fall back to the engine's value rather than being clamped up
// from a zero nobody wrote.
const num = (v, d, lo, hi) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// An id has to be usable as a file name, because the tip beside it is named
// after it. The Rust side mints 32 hex characters; this is the wider rule that
// still cannot name a parent directory or escape the folder.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const validId = (id) =>
  typeof id === 'string' && ID_RE.test(id) && !id.includes('..') && id !== BUILTIN_BRUSH;

// The tip file for a brush. Derived, never read back off the index: a hand
// edited `pngFile` is a name this module would go on to pass to `remove`, and
// the only safe answer to "which file is this brush's?" is the one the id
// already guarantees is a plain name inside the folder.
const pngFileFor = (id) => `${id}.png`;

// The size dynamics off an import, or null when the file had none to give.
//
// `off` is a source the panel offers and an import may NOT send: a `.sut` that
// says nothing about dynamics omits the key entirely (see below), so a `src` of
// `off` arriving here is junk rather than an opinion, and honouring it would
// switch the letterer's dynamics off in the name of a brush that never asked.
//
// The amount is the strength slider, 0-100, already inverted out of CSP's
// minimum-size percentage on the Rust side.
//
// The curve is the brush's own response graph, and it is optional in the same
// all-or-nothing way the whole `dyn` is: `dynCurve` either hands back a usable
// graph or null, and a null drops the key rather than storing a broken one. A
// brush whose graph was the straight line sends none - the Rust side omits an
// identity curve - and the engine's fallback is that same straight line, so the
// two agree without either having to spell it out.
function importedDyn(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.src !== 'string' || v.src === 'off' || !DYN_SOURCES.includes(v.src)) return null;
  const curve = dynCurve(v.curve);
  return {
    src: v.src,
    amount: num(v.amount, defaultBrushSettings().dyn.amount, 0, 100),
    ...(curve ? { curve } : null),
  };
}

// The settings an import speaks for, and only those.
//
// Deliberately NOT the whole of `defaultBrushSettings()`: a `.sut` says nothing
// about the ink's colour and nothing about which brush is selected. Those keys
// are absent here so that applying a brush to the tool - 2.5's job - is a plain
// spread that leaves the letterer's colour and correction where they set them:
//
//   brushTool.settings = { ...brushTool.settings, ...entry.settings, brush: id }
//
// `dyn` is the ONE key that is conditional, and it is the same rule read the
// other way. Phase 2.3 left it out because the `Effector` blobs that hold the
// size dynamics were undecoded; phase 6.1 decoded them, so a brush that names a
// driver now sends one and the spread applies it. A brush whose blob was
// missing, undecodable or drove size off nothing still sends NO key, and the
// spread then leaves hand-set dynamics exactly where they were. Absent and
// present are the whole contract - this must never emit `dyn: undefined`.
//
// Missing or junk values fall back per key to `defaultBrushSettings()`, so a
// column the parser could not read leaves the engine exactly where it was.
export function sanitiseBrushSettings(src) {
  const d = defaultBrushSettings();
  const s = src && typeof src === 'object' ? src : {};
  const taper = (t, dt) => ({
    on: typeof t?.on === 'boolean' ? t.on : dt.on,
    len: num(t?.len, dt.len, 0, 500),
    ratio: num(t?.ratio, dt.ratio, 0, 100),
  });
  const dyn = importedDyn(s.dyn);
  return {
    ...(dyn ? { dyn } : null),
    size: num(s.size, d.size, 0.5, 2000),
    opacity: num(s.opacity, d.opacity, 0, 1),
    spacing: num(s.spacing, d.spacing, 1, 200),
    hardness: num(s.hardness, d.hardness, 0, 100),
    angle: ((num(s.angle, d.angle, -1e7, 1e7) % 360) + 360) % 360,
    angleJitter: num(s.angleJitter, d.angleJitter, 0, 100),
    flatness: num(s.flatness, d.flatness, 0.01, 1),
    antialias: s.antialias !== false,
    taperIn: taper(s.taperIn, d.taperIn),
    taperOut: taper(s.taperOut, d.taperOut),
    waterEdge: s.waterEdge === true,
    waterEdgeWidth: num(s.waterEdgeWidth, d.waterEdgeWidth, 1, 20),
    waterEdgePower: num(s.waterEdgePower, d.waterEdgePower, 0, 1),
    stabilise: num(s.stabilise, d.stabilise, 0, 100),
    sharpAngles: {
      on: s.sharpAngles?.on === true,
      deg: num(s.sharpAngles?.deg, d.sharpAngles.deg, 1, 179),
    },
  };
}

// One index row, from disk or straight off the command. Null when there is no
// usable id, which is the only thing an entry cannot be repaired without.
function sanitiseEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!validId(id)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '';
  return {
    id,
    // The id is a hash, so a nameless brush shows a short prefix rather than a
    // blank cell in the grid.
    name: name || `Brush ${id.slice(0, 6)}`,
    width: Math.round(num(raw.width, 1, 1, 1e6)),
    height: Math.round(num(raw.height, 1, 1, 1e6)),
    source: SOURCES.includes(raw.source) ? raw.source : 'pixels',
    // Null, not absent, and never coerced: the Rust side sends `null` for a tip
    // that had nothing to be graded against, and `Number(null)` is 0 - which
    // would read as a perfect match against CSP's own preview.
    diff: typeof raw.diff === 'number' && Number.isFinite(raw.diff) ? raw.diff : null,
    pngFile: pngFileFor(id),
    settings: sanitiseBrushSettings(raw.settings),
  };
}

// A plain object again - the list holds `$state` proxies, and JSON.stringify of
// a proxy is fine but a structured clone of one is not, so the serialised form
// is built by hand and stays the schema's business rather than Svelte's.
const rowOf = (e) => ({
  id: e.id,
  name: e.name,
  width: e.width,
  height: e.height,
  source: e.source,
  diff: e.diff,
  pngFile: pngFileFor(e.id),
  settings: sanitiseBrushSettings(e.settings),
});

const indexJson = (entries) =>
  JSON.stringify({ schema: INDEX_SCHEMA, brushes: entries.map(rowOf) }, null, 2);

function replaceAll(entries) {
  installedBrushes.splice(0, installedBrushes.length, ...entries);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let loadInFlight = null;

// Read the library off disk. Idempotent and shared: several callers awaiting it
// at boot get one read, and a caller after that gets the already-settled
// promise rather than a second one. `force` is how an import or a removal
// re-reads what it just wrote.
export function loadBrushLibrary({ force = false } = {}) {
  if (force) loadInFlight = null;
  if (!loadInFlight) loadInFlight = doLoad();
  return loadInFlight;
}

async function doLoad() {
  brushLibrary.loading = true;
  brushLibrary.error = '';
  brushLibrary.readOnly = false;
  try {
    // No host: an empty library, and NOT an error. The browser preview is a
    // supported way to run this app and a red banner there would be noise.
    if (!inTauri()) {
      replaceAll([]);
      return;
    }
    let text = null;
    try {
      const p = await indexPath();
      if (p && (await fsx.exists(p))) text = await fsx.readTextFile(p);
    } catch {
      // The folder is not there yet, or the read failed. Either way there is
      // nothing installed as far as this session is concerned.
      text = null;
    }
    if (text == null) {
      replaceAll([]);
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Corrupt index. The session starts empty and says so, and NOTHING on
      // disk is touched: the tips are still in the folder, so re-importing the
      // same `.sut` files rebuilds the index over the top with the same ids and
      // the projects that reference them come back. Deleting here would throw
      // away the one copy of the pixels.
      brushLibrary.error =
        'The brush library index could not be read. No brushes are loaded; re-import to rebuild it.';
      replaceAll([]);
      return;
    }
    // An index from a build that knows more than this one. Reading the rows we
    // recognise and writing them back would silently DELETE whatever the newer
    // schema added, so this build reads nothing and writes nothing - a downgrade
    // is not allowed to cost the library. A missing `schema` is schema 1, which
    // is what the first index that ever shipped would have looked like.
    const schema = typeof parsed?.schema === 'number' ? parsed.schema : INDEX_SCHEMA;
    if (schema > INDEX_SCHEMA) {
      brushLibrary.error = FROM_FUTURE;
      brushLibrary.readOnly = true;
      replaceAll([]);
      return;
    }
    const rows = Array.isArray(parsed?.brushes) ? parsed.brushes : [];
    const out = [];
    const seen = new Set();
    for (const raw of rows) {
      const e = sanitiseEntry(raw);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    replaceAll(out);
  } catch (e) {
    brushLibrary.error = String(e?.message ?? e);
    replaceAll([]);
  } finally {
    brushLibrary.loading = false;
    brushLibrary.loaded = true;
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

// The installed entry, or undefined. Synchronous: the list is already in
// memory, and a painter resolving a brush mid-frame cannot await.
export function getBrush(id) {
  if (typeof id !== 'string' || !id) return undefined;
  return installedBrushes.find((b) => b.id === id);
}

// What a stored `brush` id means right now, in three answers:
//
//   { id, name, ... }              the installed brush - stamp its tip
//   { id: 'round', builtin: true } the engine's own round dab
//   { id, builtin: true, missing: true }
//                                  a brush this install does not have
//
// The last one is the case the design is about: a project opened on a machine
// where the `.sut` was never imported must still open, drawing its strokes with
// the round tip and saying so, rather than refusing.
//
// The fallback is a READING, never a rewrite. The stroke keeps the id it was
// drawn with, so importing the missing `.sut` later - even after the file was
// renamed or moved, since the id is hashed from the bytes - brings the real tip
// back to strokes that have been round in the meantime. Normalising a missing
// id to 'round' on load would have made that unrecoverable, and `data.js`
// already keeps any id string it is given (see `normalizeInkStroke`).
export function resolveBrush(id) {
  if (!id || id === BUILTIN_BRUSH) return { id: BUILTIN_BRUSH, builtin: true };
  const entry = getBrush(id);
  if (entry) return entry;
  return { id, builtin: true, missing: true };
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

// id -> { promise: Promise<tip|null>, px }. Insertion order is least-recently-
// used first: a hit moves its slot to the end. See the lifetime contract at the
// top of this file for why eviction drops rather than closes.
const tipCache = new Map();
let tipPx = 0;

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return null;
}

// PNG bytes to something a canvas can draw. `ImageBitmap` where the platform
// has it, an `<img>` where it does not, and null in node - which is not a
// failure, it is what a test runner with no image decoder can offer.
async function decodeTip(bytes) {
  if (typeof createImageBitmap === 'function' && typeof Blob === 'function') {
    return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }
  if (typeof Image === 'function' && typeof URL?.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('the tip could not be decoded'));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}

// The tip a stamper draws with, or null when there is nothing to draw.
//
// Always the same wrapper shape, in every environment, so 2.4 has one thing to
// hold: `{ id, width, height, source, image, bytes }`. `image` is the decoded
// `ImageBitmap`/`HTMLImageElement` in the app and null under node; `bytes` is
// the raw greyscale PNG and is dropped the moment there is a decoded image to
// draw with, so a tip is never held twice. In node - no decoder - `bytes` is
// what the tests read instead.
//
// Cached under `TIP_BUDGET_PX`. See the lifetime contract at the top: hold the
// returned tip for a frame, not across a chapter close.
export async function brushTip(id) {
  const entry = getBrush(id);
  if (!entry) return null;
  let slot = tipCache.get(entry.id);
  if (slot) {
    // Touch: move to the most-recently-used end of the insertion order.
    tipCache.delete(entry.id);
    tipCache.set(entry.id, slot);
  } else {
    slot = { promise: loadTip(entry), px: 0 };
    tipCache.set(entry.id, slot);
  }
  const tip = await slot.promise;
  // A failure is not remembered. The read can fail because the volume was busy
  // or the app was mid-import, and caching that would leave the brush blank for
  // the rest of the session.
  if (!tip) {
    dropTip(entry.id);
    return null;
  }
  // Charged once, and only if this slot is still the cached one - a decode that
  // lost its place to an eviction while it was in flight is not accounted for.
  // The entry's own dimensions ARE the decoded size, which is what has to be
  // budgeted whether or not this platform has a decoder to prove it.
  if (!slot.px && tipCache.get(entry.id) === slot) {
    slot.px = Math.max(1, entry.width * entry.height);
    tipPx += slot.px;
    evictTips();
  }
  return tip;
}

async function loadTip(entry) {
  try {
    const dir = await brushDir();
    if (!dir) return null;
    const bytes = toBytes(await fsx.readFile(await fsx.join(dir, entry.pngFile)));
    if (!bytes?.length) return null;
    const image = await decodeTip(bytes);
    return {
      id: entry.id,
      width: entry.width,
      height: entry.height,
      source: entry.source,
      image,
      // Held only where there is nothing decoded to draw with. Keeping both
      // would mean every tip in the cache costs its PNG on top of its bitmap.
      bytes: image ? null : bytes,
    };
  } catch {
    return null;
  }
}

// Let go of a cached tip WITHOUT closing it: a painter may still be holding the
// bitmap for the frame it is in the middle of, and closing it under `drawImage`
// throws. The collector reclaims it once the last holder is done.
function dropTip(id) {
  const slot = tipCache.get(id);
  if (!slot) return;
  tipCache.delete(id);
  tipPx = Math.max(0, tipPx - slot.px);
}

// Least recently used first, down to the budget. The newest slot is never the
// one evicted - it is at the end of the order, and a single tip larger than the
// whole budget is kept until something else needs the room.
function evictTips() {
  for (const id of tipCache.keys()) {
    if (tipPx <= TIP_BUDGET_PX || tipCache.size <= 1) break;
    dropTip(id);
  }
}

// Drop every decoded tip and release its pixels now. The ONLY place a bitmap is
// closed, because it is the only moment no painter can be live: the editor
// leaving a chapter. Calling this while a stroke is being drawn would close a
// bitmap out from under `drawImage`.
export function forgetBrushTips() {
  const slots = [...tipCache.values()];
  tipCache.clear();
  tipPx = 0;
  for (const s of slots) {
    s.promise?.then?.(
      (t) => t?.image?.close?.(),
      () => {},
    );
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Every mutation of the index runs one at a time.
//
// Both writers read `installedBrushes`, await a filesystem round trip, and then
// write the whole index back. Two of them overlapping - the panel's Import while
// a delete is still landing - would each build their next index from the same
// starting list and the second write would erase the first one's brush. So they
// queue, and each one reads the list only once it is its turn.
let writeQueue = Promise.resolve();

function serialise(fn) {
  const run = writeQueue.then(fn, fn);
  // The queue must survive a failing link: one import that threw cannot be
  // allowed to reject every write after it.
  writeQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Install the brushes in `paths` (`.sut` files) into the library.
//
// Returns `{ added, replaced, previewQuality, errors }` for the caller's toast:
//   added          brushes installed by this call, replacements included
//   replaced       how many of those took the place of one already installed
//   previewQuality how many of those are not full-resolution pixels - the
//                  thumbnail and round rungs of the ladder
//   errors         `[{ path, error }]`, one per file the command could not read
//                  plus one per tip that could not be written
//
// Never throws and never fails the whole import for one bad file: importing six
// files of which one is a JPEG installs the five.
export async function importBrushes(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(
    (p) => typeof p === 'string' && p.trim(),
  );
  const none = { added: 0, replaced: 0, previewQuality: 0, errors: [] };
  const refuse = (error) => ({ ...none, errors: list.map((path) => ({ path, error })) });
  if (!list.length) return none;

  const invoke = await getInvoke();
  if (!invoke) return refuse(NO_HOST);

  await loadBrushLibrary();
  if (brushLibrary.readOnly) return refuse(FROM_FUTURE);

  // Outside the queue: parsing a corpus is seconds of CPU in Rust, and there is
  // nothing shared to protect until there are brushes to install.
  let result;
  try {
    result = await invoke('brush_import', { paths: list });
  } catch (e) {
    return refuse(String(e?.message ?? e));
  }
  return serialise(() => install(result));
}

async function install(result) {
  const none = { added: 0, replaced: 0, previewQuality: 0, errors: [] };
  const errors = (Array.isArray(result?.errors) ? result.errors : []).map((e) => ({
    path: String(e?.path ?? ''),
    error: String(e?.error ?? 'the file could not be read'),
  }));
  const incoming = Array.isArray(result?.brushes) ? result.brushes : [];

  // The list this import is aiming at, as plain rows. Built whole and only then
  // committed, so a write that fails leaves memory agreeing with disk. Read
  // here, inside the queue, so it is the list as of this call's turn.
  const next = installedBrushes.map(rowOf);
  const at = new Map(next.map((e, i) => [e.id, i]));

  let added = 0;
  let replaced = 0;
  let previewQuality = 0;
  const written = [];
  // Ids this batch has already installed. Selecting the same file twice - or
  // two copies of it under different names, which hash the same - must install
  // one brush and count one, not write the same bytes twice and claim two.
  const inBatch = new Set();

  let dir;
  try {
    dir = await brushDir();
    if (!dir) throw new Error('there is no app data directory');
    await fsx.mkdir(dir);
  } catch (e) {
    return {
      ...none,
      errors: [
        ...errors,
        { path: DIR_NAME, error: `the brush folder could not be created: ${e?.message ?? e}` },
      ],
    };
  }

  for (const raw of incoming) {
    const entry = sanitiseEntry(raw);
    if (!entry) {
      errors.push({ path: String(raw?.name ?? raw?.id ?? ''), error: 'the brush had no usable id' });
      continue;
    }
    if (inBatch.has(entry.id)) continue;
    const bytes = toBytes(raw?.tipPng);
    if (!bytes?.length) {
      errors.push({ path: entry.name, error: 'the brush arrived with no tip image' });
      continue;
    }
    try {
      await fsx.writeFileAtomic(await fsx.join(dir, entry.pngFile), bytes);
    } catch (e) {
      errors.push({ path: entry.name, error: `the tip could not be written: ${e?.message ?? e}` });
      continue;
    }
    inBatch.add(entry.id);
    written.push(entry.id);
    const i = at.get(entry.id);
    if (i === undefined) {
      // A fresh brush goes on the end.
      at.set(entry.id, next.length);
      next.push(entry);
    } else {
      // A re-import - the same `.sut`, or a copy of it under another name -
      // updates the brush WHERE IT IS. Moving it to the end would reshuffle the
      // picker's grid under someone who only meant to refresh one tip.
      next[i] = entry;
      replaced++;
    }
    added++;
    if (entry.source !== 'pixels') previewQuality++;
  }

  if (!written.length) return { ...none, errors };

  try {
    await fsx.writeTextFileAtomic(await indexPath(), indexJson(next));
  } catch (e) {
    // The tips are on disk but the index does not mention them. Memory is left
    // alone so it still matches what is written, and the next import over the
    // same files rewrites both halves.
    return {
      ...none,
      errors: [
        ...errors,
        { path: INDEX_NAME, error: `the brush index could not be written: ${e?.message ?? e}` },
      ],
    };
  }

  for (const id of written) dropTip(id);
  replaceAll(next);
  brushLibrary.error = '';
  brushLibrary.loaded = true;
  return { added, replaced, previewQuality, errors };
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

// Uninstall one brush: index, tip file, memory. True when it was there.
//
// Strokes that were drawn with it are not touched - they keep the id and read
// as `missing` until it is imported again. See `resolveBrush`.
export async function removeBrush(id) {
  if (!inTauri()) return false;
  await loadBrushLibrary();
  if (brushLibrary.readOnly) return false;
  return serialise(async () => {
    const entry = getBrush(id);
    if (!entry) return false;
    const pngFile = entry.pngFile;
    const next = installedBrushes.filter((b) => b.id !== id).map(rowOf);
    // The index first. If the file removal fails after it, the brush is gone
    // from the library and an orphan PNG is left behind, which is inert litter
    // in a folder nothing else reads - a tip is only ever opened by name, from
    // an index row. The other order leaves an index row pointing at a file that
    // is not there, which is a brush that paints nothing.
    //
    // Nothing sweeps those orphans, deliberately: the only cheap sweep is "any
    // .png the index does not name", and after a corrupt index that is every
    // tip in the folder - including the ones whose `.sut` the letterer no
    // longer has.
    await fsx.writeTextFileAtomic(await indexPath(), indexJson(next));
    dropTip(id);
    replaceAll(next);
    try {
      const dir = await brushDir();
      if (dir) await fsx.remove(await fsx.join(dir, pngFile));
    } catch {
      /* the entry is already gone; the file is inert either way */
    }
    return true;
  });
}

// Tests only: forget the resolved folder and the shared load promise, so a
// suite can run a fresh boot against a different mock filesystem.
export function __resetBrushLibrary() {
  dirCache = null;
  loadInFlight = null;
  coreMod = null;
  writeQueue = Promise.resolve();
  tipCache.clear();
  tipPx = 0;
  replaceAll([]);
  brushLibrary.loading = false;
  brushLibrary.loaded = false;
  brushLibrary.error = '';
  brushLibrary.readOnly = false;
}
