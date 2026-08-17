// ===== The project library =====
// Owns the on-disk catalogue and every filesystem call that touches it.
// The layout is discovered by scanning for marker files rather than kept in a
// central index, so moving a folder in Finder cannot desynchronise anything.
//
//   <root>/<project-slug>/project.json
//   <root>/<project-slug>/thumb.png
//   <root>/<project-slug>/<chapter-slug>/chapter.json
//   <root>/<project-slug>/<chapter-slug>/raws/
//   <root>/<project-slug>/<chapter-slug>/cleaned/   (only once a page has one)

import { fsx } from './fsx.js';
import { uniqueSlug, chapterSlug } from './paths.js';
import {
  app,
  loadProjectPages,
  hasPageSpace,
  markSaved,
  markUnsaved,
  setSaver,
  flushSave,
  clearPending,
  settleEdits,
  setTool,
  normalizeChapterMode,
  normalizeLayout,
  toast,
} from './store.svelte.js';
import { buildTextJson } from './text-json.js';
import { carryTagsForward } from './tags.svelte.js';
import {
  setChapterImageDirs,
  setResidentWindow,
  releaseAllPageImages,
} from './page-images.js';
import { openHistory, closeHistory, flushHistory } from './editor/history-file.svelte.js';
import { setLeaveEditorHook } from './route.svelte.js';

const ROOT_KEY = 'mt.libraryRoot';
const SCHEMA = 1;

export const library = $state({
  root: '',
  projects: [],
  loading: false,
  error: '',
});

export async function defaultRoot() {
  return fsx.join(await fsx.homeDir(), 'Documents', 'MangaTypesetter');
}

export async function initRoot() {
  let saved = null;
  try {
    saved = localStorage.getItem(ROOT_KEY);
  } catch {
    /* ignore */
  }
  library.root = saved || (await defaultRoot());
}

// Both filesystem scopes this app is granted are $HOME/** (see
// src-tauri/capabilities/default.json, and the asset scope it mirrors). A root
// outside the home directory is not a library it can read or write, so callers
// check before adopting one rather than letting it fail one call at a time.
//
// Both separators are folded to one before the prefix test. `fsx.homeDir()`
// answers `C:\Users\name` on Windows and the picker hands back backslashes too,
// so a comparison with '/' written into it fails on every valid Windows path —
// and Settings then refuses the folder the user just chose with a message about
// the home directory it is plainly inside.
export async function withinHome(dir) {
  const norm = (s) =>
    String(s)
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '');
  const home = norm(await fsx.homeDir());
  const d = norm(dir);
  return d === home || d.startsWith(home + '/');
}

export async function setRoot(path) {
  library.root = path;
  try {
    localStorage.setItem(ROOT_KEY, path);
  } catch {
    /* ignore */
  }
}

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// A name that resolves to a plain file within its containing directory without
// traversing or naming parent directories.
const isPlainFileName = (name) =>
  typeof name === 'string' &&
  name.trim().length > 0 &&
  !name.includes('/') &&
  !name.includes('\\') &&
  name !== '.' &&
  name !== '..';

async function readJson(path) {
  return JSON.parse(await fsx.readTextFile(path));
}

// Every record file — project.json and chapter.json alike — goes down
// atomically. chapter.json is the only copy of a chapter's typesetting and it is
// rewritten on an 800ms debounce, so a half-written one is a chapter lost.
async function writeJson(path, value) {
  await fsx.writeTextFileAtomic(path, JSON.stringify(value, null, 2));
}

async function subdirs(dir) {
  const entries = await fsx.readDir(dir);
  return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

// ---------- scan ----------

// Everything slice 1 knows about a chapter's state: it has pages, and it has
// typesetting. There is no progress model here and none is invented — a box on
// any page means work has started, and that is the whole claim.
export const isTypeset = (pages) => (pages ?? []).some((pg) => (pg.boxes ?? []).length > 0);

// The chapter's translations, as the same JSON document the export produces,
// written beside chapter.json on every save. It is a derived file — chapter.json
// remains the only copy of anything — so it goes down with the same atomic write
// and nothing anywhere reads it back.
//
// Takes the serialised text rather than the pages, because the caller that
// matters has to snapshot the document at the same instant it builds
// chapter.json's own `pages` — see `writeOpenChapter`.
async function writeTranslationsJson(dir, text) {
  await fsx.writeTextFileAtomic(await fsx.join(dir, 'translations.json'), text);
}

async function readChapter(projectDir, slug) {
  const dir = await fsx.join(projectDir, slug);
  const raw = await readJson(await fsx.join(dir, 'chapter.json'));
  const pages = raw.pages ?? [];
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title ?? '',
    slug,
    dir,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    pageCount: pages.length,
    typeset: isTypeset(pages),
    // Absent reads as 'typeset', which is what every chapter written before this
    // field existed actually is — so no chapter on disk changes behaviour.
    mode: normalizeChapterMode(raw.mode),
    unreadable: false,
  };
}

// A folder copied inside the library — the obvious way to back one up — carries
// the original's id. Two entries under one id break the keyed {#each} that
// renders them and make every id lookup ambiguous, so the later one is flagged
// rather than admitted. The first occurrence keeps the id and stays usable.
function duplicateStub(name, slug, dir) {
  return {
    id: `duplicate:${slug}`,
    name,
    slug,
    dir,
    number: 0,
    title: '',
    pageCount: 0,
    typeset: false,
    mode: 'typeset',
    chapters: [],
    unreadable: true,
    duplicate: true,
  };
}

async function readProject(root, slug, problems, dupes) {
  const dir = await fsx.join(root, slug);
  const raw = await readJson(await fsx.join(dir, 'project.json'));
  const chapters = [];
  const seenIds = new Set();
  for (const cslug of await subdirs(dir)) {
    const marker = await fsx.join(dir, cslug, 'chapter.json');
    if (!(await fsx.exists(marker))) continue; // not a chapter directory
    try {
      const chapter = await readChapter(dir, cslug);
      if (seenIds.has(chapter.id)) {
        dupes.push(`${slug}/${cslug}`);
        chapters.push(duplicateStub(cslug, cslug, chapter.dir));
      } else {
        seenIds.add(chapter.id);
        chapters.push(chapter);
      }
    } catch (e) {
      // One bad chapter folder must never blank the project's chapter list.
      problems.push(`${slug}/${cslug}`);
      chapters.push({
        id: `unreadable:${cslug}`,
        number: 0,
        title: '',
        slug: cslug,
        dir: await fsx.join(dir, cslug),
        pageCount: 0,
        typeset: false,
        mode: 'typeset',
        unreadable: true,
      });
    }
  }
  chapters.sort((a, b) => a.number - b.number);
  return {
    id: raw.id,
    name: raw.name,
    slug,
    dir,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    coverChapterId: raw.coverChapterId ?? null,
    coverPageId: raw.coverPageId ?? null,
    // Absent reads 'pages', which is what every project written before the
    // longstrip layout existed actually is — see LAYOUTS in the store.
    layout: normalizeLayout(raw.layout),
    chapters,
    unreadable: false,
  };
}

// Every scan takes a ticket. A scan can sit for a long time on a folder
// permission prompt, and the app's own documented recovery from that is Settings
// ▸ Change folder — which points the library somewhere else and scans again. The
// blocked scan then rejects long after the new one has painted the screen, so it
// must not put its results anywhere.
let scanSeq = 0;

export async function scanLibrary() {
  const token = ++scanSeq;
  // Captured once, at entry. Read live, `library.root` is a different value
  // after every await, and the failure message at the bottom would name the root
  // now in force against the error of the one this scan actually read.
  const root = library.root;
  // `loading` belongs to the newest scan whichever root it is reading — a
  // superseded scan clearing it would blank a spinner the live one still owns.
  // Results belong to a scan only while the root they describe is still the one
  // on screen.
  const isNewest = () => scanSeq === token;
  const owns = () => isNewest() && library.root === root;

  // No root means initRoot never finished. Scanning '' would either fail with
  // something unrecognisable or read the wrong place, and clearing the error
  // would throw away the only explanation the user has — including across the
  // retry button, which lands back here.
  if (!root) {
    library.projects = [];
    library.loading = false;
    if (!library.error) {
      library.error = 'The library folder is not set. Choose one in Settings.';
    }
    return;
  }
  library.loading = true;
  library.error = '';
  const found = [];
  const problems = [];
  const dupes = [];
  const seenIds = new Set();
  try {
    if (!(await fsx.exists(root))) await fsx.mkdir(root);
    for (const slug of await subdirs(root)) {
      const marker = await fsx.join(root, slug, 'project.json');
      if (!(await fsx.exists(marker))) continue; // not a project directory
      try {
        const project = await readProject(root, slug, problems, dupes);
        if (seenIds.has(project.id)) {
          dupes.push(slug);
          found.push(duplicateStub(project.name, slug, project.dir));
        } else {
          seenIds.add(project.id);
          found.push(project);
        }
      } catch (e) {
        // One bad folder must never blank the library.
        problems.push(slug);
        found.push({
          id: `unreadable:${slug}`,
          name: slug,
          slug,
          dir: await fsx.join(root, slug),
          chapters: [],
          unreadable: true,
        });
      }
    }
    found.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    // Superseded: the catalogue on screen describes a root this scan was not
    // reading, and nothing here is an improvement on it.
    if (!owns()) return;
    library.projects = found;
    const notes = [];
    if (problems.length) notes.push(`Could not read: ${problems.join(', ')}`);
    if (dupes.length) {
      notes.push(
        `Already in the library under another folder: ${dupes.join(', ')} — rename or remove the copy.`,
      );
    }
    library.error = notes.join(' · ');
  } catch (e) {
    // A failure against a root the user has already moved on from is not news,
    // and reporting it would blank a library that is being read perfectly well.
    if (!owns()) return;
    library.projects = [];
    library.error = `Could not read the library at ${root} — ${e?.message ?? e}`;
  } finally {
    if (isNewest()) library.loading = false;
  }
}

// ---------- lookups ----------

export const projectById = (id) => library.projects.find((p) => p.id === id);
export const chapterById = (projectId, chapterId) =>
  projectById(projectId)?.chapters.find((c) => c.id === chapterId);

// Where the open chapter's own files live — what the undo history writes beside.
// Derived from the catalogue on every call rather than remembered, so a rescan
// that rebuilds the records cannot leave anyone holding a stale directory.
export function openChapterDir() {
  const ref = app.chapterRef;
  if (!ref) return null;
  return chapterById(ref.projectId, ref.chapterId)?.dir ?? null;
}

// ---------- mutations ----------

// Pick a directory name that is free ON DISK, not merely free in the catalogue.
//
// `taken` is built from what the scan found, and the scan by design ignores any
// directory without a marker file. `fsx.mkdir` passes { recursive: true }, so it
// succeeds silently on a directory that already exists. Together those two make
// a folder the app has never seen invisible to collision avoidance: a project
// named after it would write project.json inside the user's own folder, adopt
// it, and hand a later delete — or a creation rollback — a recursive remove of
// files this app never put there.
//
// So every candidate is checked against the filesystem, and an existing
// directory counts as taken. uniqueSlug's numbering is unchanged; it is just
// fed the truth.
async function freeDir(parent, name, taken) {
  const seen = new Set(taken);
  for (;;) {
    const slug = uniqueSlug(name, seen);
    const dir = await fsx.join(parent, slug);
    if (!(await fsx.exists(dir))) return { slug, dir };
    seen.add(slug);
  }
}

// `layout` is fixed here and nowhere else. Every chapter in the project inherits
// it, the editor reads it on open, and there is deliberately no way to change it
// afterwards: the pages of a longstrip chapter are slices of one continuous
// image with no margins, and re-reading them as separate pages — or the reverse —
// describes art that does not exist. Anything unrecognised, including the
// `undefined` every existing caller passes, is 'pages'.
export async function createProject(name, { layout = 'pages' } = {}) {
  const taken = new Set(library.projects.map((p) => p.slug));
  const { slug, dir } = await freeDir(library.root, name, taken);
  await fsx.mkdir(dir);
  const record = {
    schema: SCHEMA,
    id: newId('p'),
    name: String(name).trim() || 'Untitled',
    createdAt: now(),
    updatedAt: now(),
    coverChapterId: null,
    coverPageId: null,
    layout: normalizeLayout(layout),
  };
  await writeJson(await fsx.join(dir, 'project.json'), record);
  const project = { ...record, slug, dir, chapters: [], unreadable: false };
  library.projects = [project, ...library.projects];
  return project;
}

export async function deleteProject(projectId) {
  const p = projectById(projectId);
  if (!p) return;
  await fsx.remove(p.dir);
  library.projects = library.projects.filter((x) => x.id !== projectId);
}

// The bytes of a chapter's first page — whatever that page actually draws — so
// a cover can be re-derived from a chapter already on disk.
async function firstPageBytes(c) {
  const record = await readJson(await fsx.join(c.dir, 'chapter.json'));
  const pg = (record.pages ?? [])[0];
  if (!pg) return null;
  const name = pg.cleaned ?? pg.file;
  // A name out of a record can be anything a hand edit put there, and this one
  // is about to be joined onto a directory — the same reasoning as dropCleaned.
  if (!isPlainFileName(name)) return null;
  const dir = await fsx.join(c.dir, pg.cleaned ? 'cleaned' : 'raws');
  return { bytes: await fsx.readFile(await fsx.join(dir, name)), pageId: pg.id ?? null };
}

// Move the project's cover onto one of the chapters it still has.
//
// The id is only adopted once the new thumb.png has actually landed, because
// `buildChapter` offers a thumbnail on `!p.coverChapterId` alone: an id with no
// image behind it is the same dead end as an id naming a chapter that is gone.
// So a failure to re-derive gives the cover up entirely and takes the stale
// thumb.png with it — the file is the deleted chapter's art, and the card
// renders it straight off the project directory.
async function reassignCover(p, remaining) {
  for (const c of remaining) {
    if (c.unreadable) continue;
    try {
      const src = await firstPageBytes(c);
      if (!src) continue;
      await fsx.writeFile(await fsx.join(p.dir, 'thumb.png'), await makeThumb(src.bytes));
      return { coverChapterId: c.id, coverPageId: src.pageId };
    } catch {
      /* try the next chapter; a project with no cover is cosmetic */
    }
  }
  try {
    await fsx.remove(await fsx.join(p.dir, 'thumb.png'));
  } catch {
    /* ignore */
  }
  return { coverChapterId: null, coverPageId: null };
}

// A whole-record rewrite, so everything the project owns is named here. The
// layout above all: it is chosen once at creation and can never be chosen again,
// so dropping it would silently turn a webtoon project back into a paged one.
async function writeProjectRecord(p, patch) {
  const record = {
    schema: SCHEMA,
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: now(),
    coverChapterId: p.coverChapterId ?? null,
    coverPageId: p.coverPageId ?? null,
    layout: normalizeLayout(p.layout),
    ...patch,
  };
  await writeJson(await fsx.join(p.dir, 'project.json'), record);
  return record;
}

export async function deleteChapter(projectId, chapterId) {
  const p = projectById(projectId);
  const c = p?.chapters.find((x) => x.id === chapterId);
  if (!p || !c) return;
  await fsx.remove(c.dir);
  const remaining = p.chapters.filter((x) => x.id !== chapterId);
  // The cover has to follow, and project.json has to hear about it. Left
  // standing, `coverChapterId` names a chapter that no longer exists — and
  // since `buildChapter` decides whether to offer a thumbnail on
  // `!p.coverChapterId`, every later import declines and the project can never
  // have a cover again. The record leads and the catalogue follows, as
  // everywhere else here, so nothing in memory moves until the write lands.
  if (p.coverChapterId === chapterId) {
    const cover = await reassignCover(p, remaining);
    const record = await writeProjectRecord(p, cover);
    p.coverChapterId = record.coverChapterId;
    p.coverPageId = record.coverPageId;
    p.updatedAt = record.updatedAt;
  }
  p.chapters = remaining;
}

// ---------- chapter creation ----------

// Same ordering the image importer already uses, so a chapter's page order
// matches what the user sees in their file browser.
function naturalSort(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// Two picked files can share a name (routine when the user selects from two
// folders). Give the second one a disk-unique name rather than silently
// overwriting the first — same numbering style as uniqueSlug, but the
// extension and the user's original stem are preserved, never slugified.
function uniqueFileName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Cover art for the library grid. A derived asset written to its own path — it
// is never written back over a raw, and the raw it came from is untouched.
export async function makeThumb(bytes) {
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const W = 336; // 2x the 168px grid cell
    const H = Math.round((img.naturalHeight / img.naturalWidth) * W);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, W, H);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The natural pixel size of an image, measured from the bytes about to be
// written, or null when this environment cannot measure it.
//
// A page is stored `w:0,h:0` until something decodes its image, and until this
// existed the only thing that ever did was the canvas — one page at a time, as
// the user opened it. So a 28-page chapter sat on disk with 23 pages at 0x0
// (measured, in the author's own library), and every consumer that needs a page
// size before the page has been looked at got a zero: `buildPagePsd` made
// ag-psd throw `Invalid document size`, and `renderPageCanvas` sized a 0x0
// canvas and exported an empty file without a word. Measuring at import is the
// fix at the source — the size is a fact about the file being copied, and this
// is the one moment the app holds the bytes.
//
// `createImageBitmap` rather than an `<img>`: it takes the bytes directly (no
// object URL to mint and revoke, no element to attach), it decodes off the main
// thread, and it is the webview's own decoder — the same one that will draw the
// page in the canvas later, which is what makes its answer the RIGHT answer
// rather than merely a plausible one. Closed immediately: a 1080x1535 bitmap is
// 6.6 MB of RGBA, and an import loop that leaked one per page would hold the
// whole chapter's pixels at once.
//
// null, never a guess, on every failure route. `library.test.js` runs in node,
// which has no `createImageBitmap` at all, and a corrupt or exotic file can
// fail the decode in the real webview. The caller stores 0 for it, and 0 is the
// one value the store reads as "nobody has measured this yet" (`hasPageSpace`)
// — the state a first canvas visit is allowed to adopt from without dragging
// the page's boxes across. A wrong number here would be adopted as truth and
// then defended: the next honest measurement would look like a page whose art
// had been replaced, and rescale every box on it.
async function imageSize(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') return null;
  let bitmap = null;
  try {
    // No MIME type: the decoder sniffs the bytes, and the picker's extension is
    // not evidence of what the file actually is.
    bitmap = await createImageBitmap(new Blob([bytes]));
    return bitmap.width > 0 && bitmap.height > 0 ? { w: bitmap.width, h: bitmap.height } : null;
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

// Free ON DISK as well as within this batch — the same reasoning as freeDir.
// `cleaned/` on an existing chapter already holds files this run knows nothing
// about, and overwriting one would silently change another page's image.
async function freeFileName(dir, name, used) {
  const seen = new Set(used);
  for (;;) {
    const candidate = uniqueFileName(name, seen);
    if (!(await fsx.exists(await fsx.join(dir, candidate)))) return candidate;
    seen.add(candidate);
  }
}

// `cleaned/` exists only once a page actually has a cleaned image, so it is
// created on the way to the first successful copy rather than up front — a copy
// that fails on its first file must not leave an empty directory behind on a
// chapter that has no cleaned pages.
function lazyDir(path) {
  let made = false;
  return async () => {
    if (!made) {
      await fsx.mkdir(path);
      made = true;
    }
    return path;
  };
}

// Copy bytes in under a name that collides with nothing. Bytes in, bytes out —
// nothing here decodes or re-encodes an image, so bit depth, colour type and
// ICC profile arrive exactly as they left.
async function copyInto(dir, name, bytes, used) {
  const fileName = await freeFileName(dir, name, used);
  used.add(fileName);
  await fsx.writeFile(await fsx.join(dir, fileName), bytes);
  return fileName;
}

// The shared skeleton of every way a chapter comes into being: pick a free
// directory, let `copy` fill it, then write the records and update the
// catalogue — with one rollback that removes only what this run created.
//
// `copy(dir, cover)` returns the page list. `cover.offer(bytes)` is how it
// nominates the project's thumbnail; the first offer wins and a failure to
// write one is cosmetic.
async function buildChapter(p, number, title, copy, mode = 'typeset') {
  // Same hole as createProject, and here it fires on the FAILURE path: the
  // rollback below is a recursive remove, and it must never be pointed at a
  // directory this run did not bring into being.
  const taken = new Set(p.chapters.map((c) => c.slug));
  const { slug, dir } = await freeDir(p.dir, chapterSlug(number, title ?? ''), taken);

  const willHaveCover = !p.coverChapterId;
  let stagedThumb = null;
  let thumbWritten = false;
  let dirCreated = false;

  try {
    await fsx.mkdir(dir);
    dirCreated = true;

    const cover = {
      async offer(bytes) {
        if (!willHaveCover || stagedThumb || !bytes) return;
        try {
          stagedThumb = await makeThumb(bytes);
        } catch {
          /* a missing cover is cosmetic; never fail chapter creation over it */
        }
      },
    };

    const pages = await copy(dir, cover);

    const record = {
      schema: SCHEMA,
      id: newId('c'),
      number,
      title: title ?? '',
      mode: normalizeChapterMode(mode),
      createdAt: now(),
      updatedAt: now(),
      pages,
    };
    await writeJson(await fsx.join(dir, 'chapter.json'), record);
    // A chapter has its translations file from birth rather than from its first
    // save, so a chapter imported with a translations JSON already has one on
    // disk for whatever else is watching that folder. Written unconditionally —
    // it is one small file and "there is always one beside chapter.json" is a
    // simpler promise than "there is one once there were lines".
    await writeTranslationsJson(dir, buildTextJson(pages));

    const chapter = {
      id: record.id,
      number: record.number,
      title: record.title,
      slug,
      dir,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pageCount: pages.length,
      // Fresh raws carry nothing placed; a chapter rebuilt from a PSD arrives
      // already typeset, and the catalogue has to say so.
      typeset: isTypeset(pages),
      mode: record.mode,
      unreadable: false,
    };

    // Staged thumbnail write: write thumb.png only once the chapter's own files
    // are safely on disk. Prematurely writing to p.dir/thumb.png during page copy
    // meant a mid-copy failure unlinked or corrupted the project-level thumbnail.
    if (willHaveCover && !p.coverChapterId && stagedThumb) {
      try {
        await fsx.writeFile(await fsx.join(p.dir, 'thumb.png'), stagedThumb);
        thumbWritten = true;
      } catch {
        /* a missing cover is cosmetic; never fail chapter creation over it */
      }
    }

    // Compute the project's next persisted state into locals first, so the
    // in-memory catalogue is only mutated once every disk write —
    // including this one — has actually succeeded.
    const coverChapterId = willHaveCover ? chapter.id : p.coverChapterId;
    const coverPageId = willHaveCover ? (pages[0]?.id ?? null) : p.coverPageId;
    const updatedAt = now();
    await writeJson(await fsx.join(p.dir, 'project.json'), {
      schema: SCHEMA,
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt,
      coverChapterId,
      coverPageId,
      // This is a whole-record rewrite, so anything the project owns that is not
      // named here is deleted from disk. The layout is chosen once at creation
      // and can never be chosen again, so losing it to a chapter import would
      // silently turn a webtoon project back into a paged one.
      layout: normalizeLayout(p.layout),
    });

    p.chapters = [...p.chapters, chapter].sort((a, b) => a.number - b.number);
    p.coverChapterId = coverChapterId;
    p.coverPageId = coverPageId;
    p.updatedAt = updatedAt;
    return chapter;
  } catch (e) {
    // No half-written chapter is left behind for the scan to find, and no
    // thumbnail is left orphaned for a chapter that never came into being.
    // Only unlink thumb.png if this specific run created it AND the project
    // did not previously have a cover from another chapter.
    if (thumbWritten && !p.coverChapterId) {
      try {
        await fsx.remove(await fsx.join(p.dir, 'thumb.png'));
      } catch {
        /* ignore */
      }
    }
    // Only what this run created. If mkdir itself failed there is nothing of
    // ours down there, and a recursive remove would be destroying someone
    // else's files to tidy up after an error we caused.
    if (dirCreated) {
      try {
        await fsx.remove(dir);
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}

// A chapter from picked files: raws, optionally cleaned pages, optionally the
// lines a translations file supplies.
//
// Cleaned pages pair with raws BY POSITION after the same natural sort the raws
// use — the order a cleaner delivers work in, and the only rule that imposes no
// naming convention. Because it is positional it is fragile to a mismatched
// count, so the dialog states the pairing before this is ever called. Extra
// cleaned files and extra translated pages are ignored here; neither may invent
// a page, because a page with no raw persists unrenderable.
export async function createChapter({
  projectId,
  number,
  title,
  files,
  cleanedFiles = [],
  translations = null,
  mode = 'typeset',
}) {
  const p = projectById(projectId);
  if (!p) throw new Error('No such project');

  const ordered = [...files].sort(naturalSort);
  const orderedCleaned = [...(cleanedFiles ?? [])].sort(naturalSort);

  return buildChapter(p, number, title, async (dir, cover) => {
    const rawsDir = await fsx.join(dir, 'raws');
    await fsx.mkdir(rawsDir);

    const usedRaws = new Set();
    const pages = [];
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i];
      const bytes = new Uint8Array(await f.arrayBuffer());
      const file = await copyInto(rawsDir, f.name, bytes, usedRaws);
      // Measured here rather than left for a canvas visit that may never come —
      // see `imageSize`. A decode that fails leaves the page at 0, which reads
      // as unmeasured everywhere; it never invents a size.
      const size = await imageSize(bytes);
      pages.push({
        id: i + 1,
        file,
        cleaned: null,
        w: size?.w ?? 0,
        h: size?.h ?? 0,
        lines: translations?.[i]?.lines ?? [],
        detect: null,
        boxes: [],
      });
      if (i === 0) await cover.offer(bytes);
    }

    // Created on demand: a chapter with no cleaned pages has no such directory.
    if (orderedCleaned.length && pages.length) {
      const cleanedDir = await fsx.join(dir, 'cleaned');
      await fsx.mkdir(cleanedDir);
      const usedCleaned = new Set();
      const n = Math.min(orderedCleaned.length, pages.length);
      for (let i = 0; i < n; i++) {
        const f = orderedCleaned[i];
        const bytes = new Uint8Array(await f.arrayBuffer());
        pages[i].cleaned = await copyInto(cleanedDir, f.name, bytes, usedCleaned);
        // The page's space is the space of the image the app DRAWS, and both the
        // canvas and the exporters draw `cleaned ?? raw` — so the cleaned raster
        // is the measurement that counts, and it overwrites the raw's the moment
        // one arrives. A cleaner who works at a different resolution to the raw
        // is the whole reason this is not "whatever we measured first".
        //
        // A cleaned file that cannot be decoded takes the page back to
        // unmeasured instead of leaving the raw's number standing. The raw's
        // size is a true fact about a file this page no longer displays, and as
        // a stored page size it is a lie the exporter would render at — the art
        // stretched to a shape it never had. 0 says "unknown", which is exactly
        // what is true, and every consumer already has an answer for it.
        const size = await imageSize(bytes);
        pages[i].w = size?.w ?? 0;
        pages[i].h = size?.h ?? 0;
      }
    }
    return pages;
  }, mode);
}

// A chapter rebuilt from PSDs. The one place a raw is not a byte-for-byte copy:
// a PSD carries rasters, not the original files, so its pages arrive as PNG
// bytes the caller has already encoded. The dialog says so before importing.
//
// Each input page: { rawName, rawBytes, cleanedName, cleanedBytes, w, h,
// lines, boxes, detect }. A page with no raster or missing/invalid file name
// is not accepted — it would persist with an empty or unresolvable `file`,
// unrenderable and impossible to remove.
export async function createChapterFromPages({ projectId, number, title, pages: input }) {
  const p = projectById(projectId);
  if (!p) throw new Error('No such project');
  if (!input?.length) throw new Error('Nothing to import');
  if (input.some((pg) => !pg.rawBytes)) throw new Error('A page arrived with no image');
  if (
    input.some(
      (pg) =>
        !pg.rawName ||
        typeof pg.rawName !== 'string' ||
        !pg.rawName.trim() ||
        !isPlainFileName(pg.rawName),
    )
  ) {
    throw new Error('A page arrived with no file name');
  }
  if (
    input.some(
      (pg) =>
        pg.cleanedBytes &&
        (!pg.cleanedName ||
          typeof pg.cleanedName !== 'string' ||
          !pg.cleanedName.trim() ||
          !isPlainFileName(pg.cleanedName)),
    )
  ) {
    throw new Error('A cleaned page arrived with no file name');
  }

  return buildChapter(p, number, title, async (dir, cover) => {
    const rawsDir = await fsx.join(dir, 'raws');
    await fsx.mkdir(rawsDir);
    const hasCleaned = input.some((pg) => pg.cleanedBytes);
    let cleanedDir = null;
    if (hasCleaned) {
      cleanedDir = await fsx.join(dir, 'cleaned');
      await fsx.mkdir(cleanedDir);
    }

    const usedRaws = new Set();
    const usedCleaned = new Set();
    const pages = [];
    for (let i = 0; i < input.length; i++) {
      const src = input[i];
      const file = await copyInto(rawsDir, src.rawName, src.rawBytes, usedRaws);
      let cleaned = null;
      if (src.cleanedBytes) {
        cleaned = await copyInto(cleanedDir, src.cleanedName, src.cleanedBytes, usedCleaned);
      }
      pages.push({
        id: i + 1,
        file,
        cleaned,
        w: src.w ?? 0,
        h: src.h ?? 0,
        lines: src.lines ?? [],
        detect: src.detect ?? null,
        boxes: src.boxes ?? [],
      });
      if (i === 0) await cover.offer(src.cleanedBytes ?? src.rawBytes);
    }
    return pages;
  });
}

// ---------- a chapter's sources, after creation ----------

// Editing the files under a chapter that is open in the editor is the class of
// bug slice 1 spent nine review cycles removing: the open document would keep
// its own idea of the pages and the next autosave would write it back over
// whatever happened here. Refused, the way Settings refuses a library-root
// change while a chapter is open.
function assertClosed(chapterId) {
  // `opening` as well as the ref: an open gives the ref up for the length of the
  // load (see `openChapter`), and a chapter half-way onto the screen is exactly
  // as unsafe to rewrite as one already there — the open finishes holding its
  // own copy of the pages, and the first autosave puts it back over this.
  if (app.chapterRef?.chapterId === chapterId || opening?.chapterId === chapterId) {
    throw new Error('This chapter is open in the editor — leave it first');
  }
}

async function chapterFile(projectId, chapterId) {
  const c = chapterById(projectId, chapterId);
  if (!c) throw new Error('No such chapter');
  if (c.unreadable) throw new Error('This chapter could not be read');
  assertClosed(chapterId);
  return { c, path: await fsx.join(c.dir, 'chapter.json') };
}

// What the sources sheet renders: the record's pages plus, for each cleaned
// page, whether the file is actually still there. A missing one falls back to
// the raw rather than discarding anything.
export async function readChapterSources(projectId, chapterId) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const cleanedDir = await fsx.join(c.dir, 'cleaned');
  const rawsDir = await fsx.join(c.dir, 'raws');
  const pages = [];
  for (const pg of record.pages ?? []) {
    const cleaned = pg.cleaned ?? null;
    pages.push({
      id: pg.id,
      file: pg.file ?? '',
      cleaned,
      missing: cleaned ? !(await fsx.exists(await fsx.join(cleanedDir, cleaned))) : false,
    });
  }
  return { rawsDir, cleanedDir, pages };
}

// The record leads, the catalogue follows. Nothing in memory changes until the
// write has landed.
//
// translations.json goes down with it, or every one of these edits leaves the
// file beside chapter.json describing a chapter that has moved on: a re-import
// of the lines, or a cleaned page whose raster is a different size, and the
// derived document keeps saying what was true before it — until somebody opens
// the chapter in the editor and the autosave happens to refresh it. It is
// written FIRST, and deliberately: every caller here rolls back the files it
// copied when this throws, and a rollback that ran after chapter.json had
// already landed would unlink the images the new record names. So the derived
// file is written while a failure is still harmless, and chapter.json — the
// only copy of anything — is the last thing to commit.
async function commitPages(c, path, record, pages) {
  record.updatedAt = now();
  record.pages = pages;
  await writeTranslationsJson(c.dir, buildTextJson(pages));
  await writeJson(path, record);
  c.updatedAt = record.updatedAt;
  c.pageCount = pages.length;
  c.typeset = isTypeset(pages);
}

// Unlink the cleaned files nothing points at any more. Only names that came out
// of the record, only inside this chapter's own `cleaned/`, and only once the
// record no longer references them — so a failure here leaves a stray file,
// never a page pointing at one that is gone.
//
// `dropCleaned` checks `isPlainFileName`: `fsx.remove` is recursive, and
// chapter.json is an ordinary file on disk that a half-written save, a hand edit
// or a foreign tool can put anything into — so a separator or a dot-dot in a
// `cleaned` value would aim a recursive delete at a directory this app never
// created. Such a name is not one of ours; it is left alone.
async function dropCleaned(cleanedDir, names, pages) {
  const kept = new Set(pages.map((pg) => pg.cleaned).filter(Boolean));
  for (const name of names) {
    if (!isPlainFileName(name) || kept.has(name)) continue;
    try {
      await fsx.remove(await fsx.join(cleanedDir, name));
    } catch {
      /* already gone, or never written; the record is what matters */
    }
  }
}

// Copy files onto pages 1..N, replacing whatever those pages had. Pages past N
// keep theirs; files past the page count are ignored.
//
// A failure part-way is NOT rolled back. The pages already replaced keep their
// new image and the error names the page it stopped at — the previous files are
// gone by then, and a half-restored chapter is worse than a stated partial one.
export async function replaceCleanedPages(projectId, chapterId, files) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const ordered = [...files].sort(naturalSort);
  const n = Math.min(ordered.length, pages.length);
  if (!n) return { replaced: 0, ignored: ordered.length };

  const cleanedDir = await fsx.join(c.dir, 'cleaned');
  const ensureCleaned = lazyDir(cleanedDir);

  // Seeded with every name the record already claims, not just what is on disk.
  // A page whose cleaned file has gone missing still points at that name, and
  // handing the same name to a new copy would silently alias two pages onto one
  // image — the missing file being exactly what this sheet exists to repair.
  const used = new Set(pages.map((pg) => pg.cleaned).filter(Boolean));
  const copied = [];
  let failure = null;
  for (let i = 0; i < n; i++) {
    try {
      const bytes = new Uint8Array(await ordered[i].arrayBuffer());
      await ensureCleaned();
      const name = await copyInto(cleanedDir, ordered[i].name, bytes, used);
      // Measured off the bytes in hand, exactly as the import does — and for
      // exactly the same reason. The page's space is the space of the image the
      // app DRAWS, and everything draws `cleaned ?? raw`; a cleaner who delivers
      // at a different resolution to the raw used to leave `w`/`h` describing a
      // raster this page no longer displays, which is not a stale number but a
      // wrong coordinate system — boxes placed against the art on screen, PSDs
      // written at a size the layers were never drawn at, and `hasPageSpace`
      // reading it as measured so no later open would ever repair it.
      copied.push({ index: i, name, size: await imageSize(bytes) });
    } catch (e) {
      failure = { page: i + 1, e };
      break;
    }
  }

  if (copied.length) {
    const previous = copied.map(({ index }) => pages[index].cleaned);
    const next = pages.map((pg) => ({ ...pg }));
    for (const { index, name, size } of copied) {
      next[index].cleaned = name;
      // A raster that will not decode takes its page back to unmeasured rather
      // than leaving the previous image's number standing: 0 is what every
      // consumer already reads as "nobody has measured this", and `openChapter`
      // repairs it off the file itself on the next open.
      next[index].w = size?.w ?? 0;
      next[index].h = size?.h ?? 0;
    }
    try {
      await commitPages(c, path, record, next);
    } catch (e) {
      // Nothing points at the new files, so they are this run's own litter.
      await dropCleaned(cleanedDir, copied.map(({ name }) => name), pages);
      throw e;
    }
    await dropCleaned(cleanedDir, previous, next);
  }

  if (failure) {
    throw new Error(
      `Copied ${copied.length} of ${n} — stopped at page ${failure.page}: ${failure.e?.message ?? failure.e}`,
    );
  }
  return { replaced: copied.length, ignored: ordered.length - n };
}

// One page, addressed by its durable id rather than its position.
export async function setPageCleaned(projectId, chapterId, pageId, file) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const idx = pages.findIndex((pg) => pg.id === pageId);
  if (idx === -1) throw new Error('That page is no longer in this chapter');

  const cleanedDir = await fsx.join(c.dir, 'cleaned');
  const ensureCleaned = lazyDir(cleanedDir);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await ensureCleaned();
  // Same reasoning as the bulk path: never reuse a name the record still claims.
  const name = await copyInto(
    cleanedDir,
    file.name,
    bytes,
    new Set(pages.map((pg) => pg.cleaned).filter(Boolean)),
  );

  const previous = pages[idx].cleaned;
  const next = pages.map((pg) => ({ ...pg }));
  next[idx].cleaned = name;
  // Same as the bulk path: the image this page draws has just changed, so the
  // space its boxes and its export are measured in has to change with it.
  const size = await imageSize(bytes);
  next[idx].w = size?.w ?? 0;
  next[idx].h = size?.h ?? 0;
  try {
    await commitPages(c, path, record, next);
  } catch (e) {
    await dropCleaned(cleanedDir, [name], pages);
    throw e;
  }
  await dropCleaned(cleanedDir, [previous], next);
  return name;
}

export async function clearPageCleaned(projectId, chapterId, pageId) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const idx = pages.findIndex((pg) => pg.id === pageId);
  if (idx === -1) throw new Error('That page is no longer in this chapter');
  const previous = pages[idx].cleaned;
  if (!previous) return;
  const next = pages.map((pg) => ({ ...pg }));
  next[idx].cleaned = null;
  // The page draws its raw again, and the raw is not necessarily the size the
  // cleaned raster was. There are no raw bytes in hand here to measure, so the
  // page goes back to unmeasured and `openChapter` reads the true size off disk
  // on the next open — the same repair every chapter imported before the app
  // measured anything already takes.
  next[idx].w = 0;
  next[idx].h = 0;
  await commitPages(c, path, record, next);
  await dropCleaned(await fsx.join(c.dir, 'cleaned'), [previous], next);
}

export async function removeAllCleaned(projectId, chapterId) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const previous = pages.map((pg) => pg.cleaned).filter(Boolean);
  if (!previous.length) return 0;
  // Only the pages that actually lose an image go back to unmeasured — see
  // `clearPageCleaned`. A page that never had a cleaned raster keeps the
  // measurement of the raw it has been drawing all along.
  const next = pages.map((pg) => (pg.cleaned ? { ...pg, cleaned: null, w: 0, h: 0 } : { ...pg }));
  await commitPages(c, path, record, next);
  await dropCleaned(await fsx.join(c.dir, 'cleaned'), previous, next);
  return previous.length;
}

// Lines for the pages a translations file covers. It says what is on pages
// 1..N; it says nothing about whether the chapter has pages after that, so it
// never shortens the chapter and never appends to it.
//
// It also says nothing about tags — the format has never carried them — so the
// tags the user applied by hand are carried across by line number rather than
// replaced with the file's silence. Without that, re-running a corrected
// translation over a tagged chapter left every box in place and stripped every
// tag they were placed under: `sfx` and `narration` survived through `type`,
// and anything the user invented was gone with no warning. See
// `carryTagsForward` for which side wins.
export async function applyTranslations(projectId, chapterId, parsed) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const covered = Math.min(parsed.length, pages.length);
  const next = pages.map((pg, i) =>
    i < covered ? { ...pg, lines: carryTagsForward(pg.lines ?? [], parsed[i].lines) } : pg,
  );
  await commitPages(c, path, record, next);

  // A box placed from the queue carries no text of its own — it renders
  // whichever line has its number. A file that numbers its lines differently
  // leaves those boxes pointing at nothing, and they render empty. Nothing is
  // lost (re-applying the old file brings them back) but it is not something to
  // discover later, so it is counted and the caller states it.
  const orphaned = next
    .slice(0, covered)
    .reduce(
      (n, pg) =>
        n +
        (pg.boxes ?? []).filter(
          (b) => b.text == null && !(pg.lines ?? []).some((l) => l.n === b.lineN),
        ).length,
      0,
    );

  return {
    covered,
    kept: pages.length - covered,
    ignored: parsed.length - covered,
    lines: parsed.slice(0, covered).reduce((n, pg) => n + pg.lines.length, 0),
    orphaned,
  };
}

// ---------- a chapter's workflow mode ----------

// Switch a chapter between 'typeset' and 'translate' from the project screen,
// without opening it. Deliberately NOT routed through `chapterFile` and its
// `assertClosed`: that refusal exists because rewriting a chapter's *pages*
// under the open document would be overwritten by the next autosave, and a mode
// is one field the open document itself owns. So the chapter on screen takes the
// other branch — the state changes and the debounce writes it, which is the same
// path every other edit to an open chapter takes.
export async function setChapterMode(projectId, chapterId, mode) {
  const c = chapterById(projectId, chapterId);
  if (!c) throw new Error('No such chapter');
  if (c.unreadable) throw new Error('This chapter could not be read');
  const next = normalizeChapterMode(mode);

  if (app.chapterRef?.chapterId === chapterId) {
    app.chapterMode = next;
    // The same tool reset an open in translate mode performs — the rail is about
    // to lose the two tools the user may currently be holding.
    if (next === 'translate') setTool('pan');
    c.mode = next;
    markUnsaved();
    return next;
  }

  const path = await fsx.join(c.dir, 'chapter.json');
  const record = await readJson(path);
  record.mode = next;
  record.updatedAt = now();
  await writeJson(path, record);
  // The record leads, the catalogue follows — as everywhere else in this file.
  c.mode = next;
  c.updatedAt = record.updatedAt;
  return next;
}

// ---------- open / save the editor's chapter ----------

// The open chapter's page images are not held here any more. They are minted a
// handful at a time, around the page on screen, by `page-images.js` — see the
// note at the top of that file. What this function used to do, minting every
// raw and every cleaned page in the chapter before showing the first one, is
// what made opening a long chapter cost hundreds of megabytes that were never
// given back until it closed.

// Every open takes a ticket, the same way every scan does. An open is a run of
// disk reads and image decodes and the user can start another one part-way
// through it — click chapter 1, change their mind, click chapter 2 — and
// chapter 1's decodes then finish after chapter 2 is already on screen. Without
// a ticket the slow one lands its pages AND its ref on top of the new one, and
// every edit the user then makes is autosaved into the wrong chapter's file.
let openSeq = 0;

// The chapter an open is loading right now. `app.chapterRef` is deliberately
// null for the whole of a load (see below), so this is the only thing left that
// can tell `assertClosed` a chapter is on its way to the screen.
let opening = null;

// Which chapter the document in `app.pages` actually came from. `app.chapterRef`
// says where a save should go; this says what it would be saving. They are set
// together and cleared together, and a save that finds them disagreeing is
// refused rather than aimed at whichever file the ref happens to name.
let loadedRef = null;

export async function openChapter(projectId, chapterId) {
  const p = projectById(projectId);
  const c = chapterById(projectId, chapterId);
  if (!p || !c) throw new Error('No such chapter');
  // A scan stub for an unparseable chapter.json carries no pages. Loading one
  // would present an empty document that the next save would write back over
  // whatever is really in that file. Refused before anything is given up, so a
  // misfired open cannot cost the user the chapter they already have on screen.
  if (c.unreadable) throw new Error('This chapter could not be read');

  const token = ++openSeq;
  // Superseded: a newer open has taken the state over, and nothing this one is
  // still carrying is an improvement on it.
  const mine = () => openSeq === token;
  const mark = { projectId, chapterId };
  opening = mark;
  // Nothing has been given up until the ref has been. Until then a failure
  // leaves the chapter on screen exactly as it was — which is what a rejected
  // `flushSave` below has to do, because the work it could not write is still in
  // front of the user and the next attempt is their way out of it.
  let handedOver = false;
  try {
    // Write anything still pending for the chapter being replaced — and cancel
    // its debounce either way — before app.pages stops being that chapter.
    await flushSave();
    if (!mine()) return;

    // The outgoing chapter is on disk, and from here until the new document is
    // fully loaded there is no open chapter at all.
    //
    // This is the whole of the chapter-switch race. `app.pages` is about to stop
    // describing the chapter `chapterRef` names, and everything that writes
    // reads that ref: the 800ms debounce `loadProjectPages` re-arms, a
    // `flushSave` from a quit, and — the one that actually happened — the
    // `goBack` that `App.svelte` runs when the load below throws, which flushes
    // on its way out of the editor. Every one of them would serialise the NEW
    // chapter's pages into the OLD chapter's chapter.json, which is that
    // chapter's only copy. With no ref there is nothing for any of them to aim
    // at, and `markUnsaved` does not even arm the debounce.
    handedOver = true;
    app.chapterRef = null;
    loadedRef = null;

    return await loadChapter(p, c, projectId, chapterId, mine);
  } catch (e) {
    // The outgoing chapter has been flushed and its ref given up, and
    // `app.pages` may be a half-loaded document belonging to neither chapter.
    // `App.svelte` answers a failed open by navigating back, which flushes on
    // the way out — so what that flush has to find is an editor with nothing
    // open at all, rather than one chapter's pages under another chapter's name.
    if (handedOver && mine()) closeChapter();
    throw e;
  } finally {
    // Only ever our own mark: a newer open owns `opening` from the moment it
    // starts, and clearing it here would unlock a chapter that is still loading.
    if (opening === mark) opening = null;
  }
}

// Everything from the record read to the ref going back on. Called with the
// outgoing chapter already flushed and `app.chapterRef` already null, so every
// way out of here — a return, a throw, a newer open — leaves nothing aimed at
// the chapter being left.
async function loadChapter(p, c, projectId, chapterId, mine) {
  const record = await readJson(await fsx.join(c.dir, 'chapter.json'));
  if (!mine()) return;
  const rawsDir = await fsx.join(c.dir, 'raws');
  const cleanedDir = await fsx.join(c.dir, 'cleaned');

  // Pages imported before `createChapter` measured them are on disk as `w:0,h:0`
  // — a page with no coordinate space at all. The canvas repairs one per visit,
  // so a chapter nobody has flipped through end to end still exports blank
  // sheets and PSDs ag-psd refuses to write. Repairing them here costs one
  // decode per unmeasured page, once, on the open that finds them: a measured
  // chapter pays nothing, and the repair is written back below so the next open
  // pays nothing either. `imageSize` returning null leaves the page at 0, which
  // is still the honest answer.
  let repaired = false;
  const measureIfUnmeasured = async (pg) => {
    if (hasPageSpace(pg)) return pg;
    // Whatever the page actually draws — `cleaned ?? raw` — because that is the
    // raster the page's coordinates have to agree with.
    const name = pg.cleaned ?? pg.file;
    const dir = pg.cleaned ? cleanedDir : rawsDir;
    if (!name) return pg;
    try {
      const size = await imageSize(await fsx.readFile(await fsx.join(dir, name)));
      if (!size) return pg;
      repaired = true;
      return { ...pg, w: size.w, h: size.h };
    } catch {
      return pg; // unreadable here is the same as unreadable at import: leave it 0
    }
  };

  const pages = [];
  for (const raw of record.pages ?? []) {
    // Checked per page, not merely after the loop: this is the long await in the
    // whole function — one image decode per unmeasured page — and it is exactly
    // where a user who has changed their mind gets a second open in.
    if (!mine()) return;
    const pg = await measureIfUnmeasured(raw);
    // `file` and `cleaned` are the deduped on-disk names chosen at import;
    // they are the only things that resolve a page back to its images. Both
    // travel onto the store page, so nothing downstream pairs by position.
    // A slice 1 chapter.json has no `cleaned` key at all: absent reads null.
    //
    // The pictures themselves are not read here. Every page arrives with
    // `raw: null, cleaned: null` and the window below fills in the five around
    // the one being opened; `page-images.js` resolves the rest from these two
    // names as the user moves through the chapter.
    pages.push({
      ...pg,
      file: pg.file ?? null,
      cleanedFile: pg.cleaned ?? null,
      raw: null,
      cleaned: null,
    });
  }

  // The last chance to walk away without having touched anything: past this
  // line a superseded load has already replaced the newer one's document.
  if (!mine()) return;
  // Swap last: the chapter on screen stays intact until the new one is ready.
  const minted = loadProjectPages(pages);
  // After the swap, not before. Pointing the module at the new chapter releases
  // the old one's images, and releasing an image nulls the `raw`/`cleaned` of
  // the page object that held it — done a moment earlier, those page objects
  // are still the ones on screen, and the outgoing chapter would blink to a
  // blank sheet on its way out.
  setChapterImageDirs(rawsDir, cleanedDir);
  // The page being opened, awaited, so `openChapter` resolving means there is
  // something to draw; its four neighbours are started and left to arrive.
  await setResidentWindow(app.pages, app.pageIndex);
  // A newer open has already swapped its own document in and taken the image
  // module with it. Everything below is state this load has no business writing
  // any more — above all the ref, which is what a save aims at.
  if (!mine()) return;
  // The mode is a property of THIS chapter, so it is written on every open
  // rather than left standing from the last one — opening a typeset chapter
  // after a translate one must give back the whole editor. The catalogue follows
  // the record it just read, so a chapter.json edited outside the app is
  // believed here as well as by the scan.
  const mode = normalizeChapterMode(record.mode);
  app.chapterMode = mode;
  c.mode = mode;
  // The layout belongs to the PROJECT, so it comes off the catalogue record
  // rather than out of chapter.json — a chapter has no say in it. Written on
  // every open for the same reason the mode is: opening a paged chapter after a
  // longstrip one must give back the paged canvas.
  app.projectLayout = normalizeLayout(p.layout);
  // Translate mode has no place and no text tool, and `setTool` refuses them
  // while it is on — so a chapter opened in it always lands on the hand rather
  // than on whatever the previous chapter was left holding.
  if (mode === 'translate') setTool('pan');
  // Order matters. loadProjectPages ends in markUnsaved(), which only schedules
  // a save while a chapterRef is set; setting the ref after it, then marking
  // saved, means opening a chapter never schedules a write of what it just read.
  app.chapterRef = { projectId, chapterId };
  // Set in the same breath as the ref, because between the two a save would see
  // a chapter it is allowed to write and a document that is not yet declared to
  // be that chapter's.
  loadedRef = { projectId, chapterId };
  // Unless the load had to mint ids, because then what is in memory is not what
  // is in the file. Those ids come off counters whose value depends on what else
  // was opened this session, so a repair that never reaches disk is redone
  // differently on every open, and the undo history has no stable box to address.
  // Mark it dirty instead and let the debounce write the repair now.
  if (minted || repaired) markUnsaved();
  else markSaved();

  // Awaited, so the open does not resolve onto a chapter whose journal is still
  // arriving. Left unawaited, the read landed AFTER the user could already act:
  // a page turn or an edit in that window met an `openHistory` that overwrites
  // the document unconditionally and loads page one's stack over whatever page
  // they had moved to — in-flight records gone, and undo pointing at edits that
  // belong to another page.
  //
  // The cost this was avoiding — a slow or wedged filesystem standing between
  // the user and a chapter that is ready to draw — is not one this function
  // escapes anyway: the record read above and `setResidentWindow`'s page reads
  // are on the same disk, and both are already awaited. One more read changes
  // nothing about that and closes the race. Still caught: history is a
  // convenience and may never fail an open.
  await openHistory(c.dir, app.pages[0]?.id ?? null).catch(() => {});
}

// Saves are serialised, the same way the history file's writes are and for the
// same reason. `flushSave`'s clearTimeout cannot call back a debounce that has
// already entered `Promise.resolve().then(saver)`, so two of these can be in
// flight at once — and each snapshots `app.pages` at its own moment, so the
// older snapshot can rename last and overwrite a genuinely later edit. The
// atomic write means the file can never tear; the queue is what makes the last
// edit the one that survives.
let saving = Promise.resolve();

// A tag for "which save is this", so a save that lands can tell whether it is
// still the newest one queued. Incremented once per call, before the queue
// even runs it — the ordering the indicator has to trust is call order, not
// finish order.
let saveSeq = 0;

export function saveOpenChapter() {
  const seq = ++saveSeq;
  const done = saving.then(() => writeOpenChapter(seq));
  // The queue must outlive a save that fails, or one bad write would strand
  // every later one — but the rejection still reaches this caller, because a
  // rejected autosave is the user's only signal that their work is off-disk.
  saving = done.catch(() => {});
  return done;
}

async function writeOpenChapter(seq) {
  // Captured once. Every await below is a window in which the user can close
  // this chapter or open another, and `app.pages` stops being what `ref`
  // describes the moment they do — so the identity of the ref is re-checked
  // after each one. A debounce already in flight cannot be cancelled; this is
  // what stops it writing an empty or foreign document over a real chapter.
  const ref = app.chapterRef;
  if (!ref) return;
  // …and the document in hand has to be that chapter's. The two are set together
  // and cleared together, so a disagreement means this save has arrived in the
  // middle of something — a chapter switch part-way through, a load abandoned by
  // a newer one — with `app.pages` already replaced. Writing then is the one
  // shape that puts a live chapter's document into another chapter's file.
  if (!loadedRef || loadedRef.projectId !== ref.projectId || loadedRef.chapterId !== ref.chapterId) {
    return;
  }
  const c = chapterById(ref.projectId, ref.chapterId);
  if (!c) return;
  const path = await fsx.join(c.dir, 'chapter.json');
  if (app.chapterRef !== ref) return;
  const record = await readJson(path);
  if (app.chapterRef !== ref) return;

  record.updatedAt = now();
  // The open chapter's mode is app state while it is open — that is how a switch
  // made from the project screen reaches a chapter already on screen — so the
  // record follows it here rather than the other way round.
  record.mode = app.chapterMode;
  // Blob URLs are runtime-only. `file` and `cleanedFile` are the durable
  // references and both are read off the page itself, so a document whose pages
  // were replaced or reordered in the editor can never hand one page's images
  // to another.
  record.pages = app.pages.map((pg) => ({
    id: pg.id,
    file: pg.file ?? '',
    cleaned: pg.cleanedFile ?? null,
    w: pg.w,
    h: pg.h,
    // $state.snapshot is a deep clone: the nested style objects inside boxes
    // and the detect geometry come out as plain data, never proxies.
    lines: $state.snapshot(pg.lines),
    detect: $state.snapshot(pg.detect),
    boxes: $state.snapshot(pg.boxes),
  }));
  // Serialised here, in the same synchronous breath as `record.pages` and from
  // the same document, so the two files can never describe different moments.
  // Read after the write below instead, it would be `app.pages` as it stands
  // once the disk has come back — which may by then be another chapter's.
  const text = buildTextJson(app.pages);
  await writeJson(path, record);
  // …and the translations beside it, on the same debounce. Every route into the
  // document already ends in `markUnsaved()` — detection, a queue edit, a
  // placement — so this file is refreshed 800ms after the last keystroke rather
  // than on a count of edits: no rule about "every two boxes" to get wrong, and
  // no burst of writes while someone is typing. It is a derived file and nothing
  // reads it back, so it cannot lose the user anything chapter.json above has
  // not already saved — but it is awaited and not swallowed, because a disk that
  // cannot take this one cannot take that one either, and the save indicator is
  // the only place that ever gets said.
  await writeTranslationsJson(c.dir, text);
  // Any write that lands ends the failure streak, whoever asked for it — the
  // debounced autosave included. The escape below is for a disk that keeps
  // failing, not for one that failed once an hour ago.
  saveFailures = 0;
  // …and lowers the save indicator's failed state for the same reason. This is
  // the only place it comes down: the chrome promises the user that the warning
  // stands until bytes actually reach the disk, and this is where they have.
  app.saveFailed = false;
  // The in-memory catalogue follows the disk, never leads it.
  // Re-resolve the live catalogue entry by id after disk awaits rather than
  // holding onto `c`: a concurrent scanLibrary can replace library.projects
  // during any await, which would leave `c` pointing at an orphaned object.
  const live = chapterById(ref.projectId, ref.chapterId) ?? c;
  live.updatedAt = record.updatedAt;
  live.pageCount = record.pages.length;
  live.typeset = isTypeset(record.pages);
  if (live !== c) {
    c.updatedAt = record.updatedAt;
    c.pageCount = record.pages.length;
    c.typeset = isTypeset(record.pages);
  }
  // Only the chapter still on screen can be declared saved — and only when no
  // later save is already queued behind this one. A newer call bumped saveSeq
  // the moment it was made, before it ever reached the write; if that has
  // happened, a newer snapshot exists that this write did not carry, and the
  // indicator has no business claiming everything is saved yet. The next save
  // in the chain will make that claim once it is truly the last one.
  if (app.chapterRef === ref && seq === saveSeq) markSaved();
}

export function closeChapter() {
  // Before the pages go, because the live page's stack is only in memory until
  // this runs — without it the last 800ms of records never reach disk. The id
  // comes off the page itself rather than `page()`, whose empty-document
  // stand-in answers to 0 and would file the stack under a page that does not
  // exist; a null hands the module back to its own record of which page is
  // live. Not awaited: this function is synchronous and the document's teardown
  // does not wait on the history's, which reports its own failures and swallows
  // them.
  closeHistory(app.pages[app.pageIndex]?.id ?? null);
  releaseAllPageImages();
  // Cleared before the pages are: a debounce that lands after this point finds
  // no chapterRef and is a no-op, rather than a write of stale state.
  app.chapterRef = null;
  loadedRef = null;
  app.pages = [];
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  // Cleared, not settled: a box left mid-edit is going away with the chapter,
  // and so is the history it would have been recorded into.
  clearPending();
  // No document is loaded any more, so the editor falls back to its empty
  // state instead of offering a canvas over the blank stand-in page.
  app.loaded = false;
  // Back to the default, because the mode belonged to the chapter that was open.
  // Left standing, a translate chapter closed to the library would keep the
  // editor stripped for the next chapter opened — and `openChapter` writes it
  // anyway, so this is only about what the app is between two chapters.
  app.chapterMode = 'typeset';
  // And so does the layout, for the same reason — it belonged to the project the
  // closed chapter was in.
  app.projectLayout = 'pages';
  // The failure streak belongs to the chapter that was open. Nothing is pending
  // any more, so the next chapter starts its own two-step from scratch.
  saveFailures = 0;
  // So does the save indicator's failed state: the pill presents it inside
  // `{project} · {chapter}`, as a fact about the open chapter. Carrying chapter
  // A's failure onto chapter B would blame the wrong document. With this, the
  // policy is whole: raised on any rejected save, lowered on any landed write,
  // lowered on close.
  app.saveFailed = false;
}

// ---------- putting the chapter away when the disk says no ----------

// Failing closed on the first attempt is right: the work is still on screen, the
// user may be able to fix the cause (free some space, plug the volume back in,
// re-grant the folder), and walking away would silently drop the very edits the
// flush exists to protect.
//
// But a full disk, a revoked permission or an unplugged volume fails EVERY time,
// and a chapter that cannot be closed inside a window that cannot be closed is a
// worse outcome than the paragraph being protected — the only way out would be
// the quit path, which drops the same work without asking. So the SECOND
// consecutive attempt says exactly what is about to be lost and lets the user
// through. Two deliberate requests, same shape as the two-step deletes on the
// home screens.
let saveFailures = 0;

const LEAVING = {
  editor: {
    refuse: (why) =>
      `Could not save — staying in the editor. ${why}. Your last edits are still on screen; ask to leave again to discard them and go back to the library.`,
    force: 'Left the editor. The last edits to this chapter were never written to disk.',
  },
  quit: {
    refuse: (why) =>
      `Could not save — not quitting. ${why}. Your last edits are still on screen; ask to quit again to close anyway and discard them.`,
    force: 'Quitting. The last edits to this chapter were never written to disk.',
  },
};

// Test-only: clear the streak without going through a chapter close.
export function resetSaveFailures() {
  saveFailures = 0;
}

// Wait for a promise, but not forever. Every failure inside the history's write
// is reported and swallowed, so the one thing left that can go wrong there is a
// call that never comes back — a network volume that has gone away, a wedged
// mount. Awaited unbounded, that would hang the quit for good: the close-request
// path is single-flight, so a second press of the red button would not even
// retry, and the window could never be closed again.
const HISTORY_WAIT_MS = 1500;
async function atMost(ms, p) {
  let t;
  try {
    await Promise.race([
      p,
      new Promise((r) => {
        t = setTimeout(r, ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

// Flush whatever the debounce is holding, on the way out of the chapter.
// `where` picks the wording — 'editor' for closing the chapter, 'quit' for
// closing the window. Resolves true when it is safe to go, false when the caller
// must stay put.
export async function flushBeforeLeaving(where) {
  const copy = LEAVING[where] ?? LEAVING.editor;
  // First of all, and synchronously: an edit still inside its settle window has
  // been applied to the document and will be written by the save below, while
  // the panel holding its record is about to be unmounted and throw it away.
  // The stack would then come back off disk a step short of the document, and
  // the next undo would rewind the edit before it while the last one stood —
  // the same shape as a settle landing on the wrong page, through a narrower
  // door. Here rather than after the flushes because the record has to exist
  // before the history's flush takes its snapshot, and while `app.pages` is
  // still the document the entry names.
  settleEdits();
  // The history's own flush belongs on this path — it is the only thing that
  // gets the last records out on the way to a quit, which destroys the window
  // the moment this resolves. Started alongside the document's save rather than
  // before it, and its result never consulted: whether the user may leave is
  // decided by the chapter reaching disk and by nothing else. It cannot reject
  // (every failure inside is reported once and swallowed) and is caught anyway,
  // so no future change to that can turn a failed history write into a window
  // that will not close.
  const history = flushHistory().catch(() => {});
  try {
    await flushSave();
    saveFailures = 0;
    return true;
  } catch (e) {
    saveFailures += 1;
    if (saveFailures < 2) {
      toast(copy.refuse(e?.message ?? e));
      return false;
    }
    // The escape is spent. A later attempt starts the two-step over rather than
    // inheriting a streak from a problem that may since have been fixed.
    saveFailures = 0;
    toast(copy.force);
    return true;
  } finally {
    // Only the quit path waits, and only for a bounded moment. Quitting
    // destroys the window as soon as this resolves, so the records have to have
    // landed by then; leaving the editor destroys nothing, and `closeChapter`
    // flushes again a moment later anyway. Neither can change the answer — a
    // `finally` does not overwrite a return.
    if (where === 'quit') await atMost(HISTORY_WAIT_MS, history);
  }
}

// Wire the store's autosave and the route's leave-editor flush to this module.
setSaver(saveOpenChapter);
setLeaveEditorHook(async () => {
  // Rethrowing keeps the route on the editor, so the work is still on screen and
  // the next edit will retry the save; leaving would close the chapter and drop
  // it. flushBeforeLeaving has already said why, and on a second consecutive
  // failure it returns true instead, which is the way out.
  if (!(await flushBeforeLeaving('editor'))) throw new Error('The chapter could not be saved');
  closeChapter();
});
