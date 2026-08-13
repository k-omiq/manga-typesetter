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
  markSaved,
  markUnsaved,
  setSaver,
  flushSave,
  toast,
} from './store.svelte.js';
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
export async function withinHome(dir) {
  const trim = (s) => String(s).replace(/\/+$/, '');
  const home = trim(await fsx.homeDir());
  const d = trim(dir);
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

export async function createProject(name) {
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

export async function deleteChapter(projectId, chapterId) {
  const p = projectById(projectId);
  const c = p?.chapters.find((x) => x.id === chapterId);
  if (!p || !c) return;
  await fsx.remove(c.dir);
  p.chapters = p.chapters.filter((x) => x.id !== chapterId);
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
async function buildChapter(p, number, title, copy) {
  // Same hole as createProject, and here it fires on the FAILURE path: the
  // rollback below is a recursive remove, and it must never be pointed at a
  // directory this run did not bring into being.
  const taken = new Set(p.chapters.map((c) => c.slug));
  const { slug, dir } = await freeDir(p.dir, chapterSlug(number, title ?? ''), taken);

  const willHaveCover = !p.coverChapterId;
  let thumbWritten = false;
  let dirCreated = false;

  try {
    await fsx.mkdir(dir);
    dirCreated = true;

    const cover = {
      async offer(bytes) {
        if (!willHaveCover || thumbWritten || !bytes) return;
        try {
          await fsx.writeFile(await fsx.join(p.dir, 'thumb.png'), await makeThumb(bytes));
          thumbWritten = true;
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
      createdAt: now(),
      updatedAt: now(),
      pages,
    };
    await writeJson(await fsx.join(dir, 'chapter.json'), record);

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
      unreadable: false,
    };

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
    });

    p.chapters = [...p.chapters, chapter].sort((a, b) => a.number - b.number);
    p.coverChapterId = coverChapterId;
    p.coverPageId = coverPageId;
    p.updatedAt = updatedAt;
    return chapter;
  } catch (e) {
    // No half-written chapter is left behind for the scan to find, and no
    // thumbnail is left orphaned for a chapter that never came into being.
    if (thumbWritten) {
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
      pages.push({
        id: i + 1,
        file,
        cleaned: null,
        w: 0,
        h: 0,
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
      }
    }
    return pages;
  });
}

// A chapter rebuilt from PSDs. The one place a raw is not a byte-for-byte copy:
// a PSD carries rasters, not the original files, so its pages arrive as PNG
// bytes the caller has already encoded. The dialog says so before importing.
//
// Each input page: { rawName, rawBytes, cleanedName, cleanedBytes, w, h,
// lines, boxes, detect }. A page with no raster is not accepted — it would
// persist with an empty `file`, unrenderable and impossible to remove.
export async function createChapterFromPages({ projectId, number, title, pages: input }) {
  const p = projectById(projectId);
  if (!p) throw new Error('No such project');
  if (!input?.length) throw new Error('Nothing to import');
  if (input.some((pg) => !pg.rawBytes)) throw new Error('A page arrived with no image');

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
  if (app.chapterRef?.chapterId === chapterId) {
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
async function commitPages(c, path, record, pages) {
  record.updatedAt = now();
  record.pages = pages;
  await writeJson(path, record);
  c.updatedAt = record.updatedAt;
  c.pageCount = pages.length;
  c.typeset = isTypeset(pages);
}

// Unlink the cleaned files nothing points at any more. Only names that came out
// of the record, only inside this chapter's own `cleaned/`, and only once the
// record no longer references them — so a failure here leaves a stray file,
// never a page pointing at one that is gone.
// A name that could resolve anywhere but inside cleaned/. `fsx.remove` is
// recursive, and chapter.json is an ordinary file on disk that a half-written
// save, a hand edit or a foreign tool can put anything into — so a separator or
// a dot-dot in a `cleaned` value would aim a recursive delete at a directory
// this app never created. Such a name is not one of ours; it is left alone.
const isPlainFileName = (name) =>
  !!name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';

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
      copied.push({ index: i, name: await copyInto(cleanedDir, ordered[i].name, bytes, used) });
    } catch (e) {
      failure = { page: i + 1, e };
      break;
    }
  }

  if (copied.length) {
    const previous = copied.map(({ index }) => pages[index].cleaned);
    const next = pages.map((pg) => ({ ...pg }));
    for (const { index, name } of copied) next[index].cleaned = name;
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
  await commitPages(c, path, record, next);
  await dropCleaned(await fsx.join(c.dir, 'cleaned'), [previous], next);
}

export async function removeAllCleaned(projectId, chapterId) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const previous = pages.map((pg) => pg.cleaned).filter(Boolean);
  if (!previous.length) return 0;
  const next = pages.map((pg) => ({ ...pg, cleaned: null }));
  await commitPages(c, path, record, next);
  await dropCleaned(await fsx.join(c.dir, 'cleaned'), previous, next);
  return previous.length;
}

// Lines for the pages a translations file covers. It says what is on pages
// 1..N; it says nothing about whether the chapter has pages after that, so it
// never shortens the chapter and never appends to it.
export async function applyTranslations(projectId, chapterId, parsed) {
  const { c, path } = await chapterFile(projectId, chapterId);
  const record = await readJson(path);
  const pages = record.pages ?? [];
  const covered = Math.min(parsed.length, pages.length);
  const next = pages.map((pg, i) => (i < covered ? { ...pg, lines: parsed[i].lines } : pg));
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

// ---------- open / save the editor's chapter ----------

// Blob URLs minted for the open chapter's raws. Held here so closing or
// switching chapters can revoke them — leaking these keeps whole page images
// alive for as long as the app runs.
let openUrls = [];

function revokeOpenUrls() {
  for (const u of openUrls) URL.revokeObjectURL(u);
  openUrls = [];
}

export async function openChapter(projectId, chapterId) {
  const p = projectById(projectId);
  const c = chapterById(projectId, chapterId);
  if (!p || !c) throw new Error('No such chapter');
  // A scan stub for an unparseable chapter.json carries no pages. Loading one
  // would present an empty document that the next save would write back over
  // whatever is really in that file.
  if (c.unreadable) throw new Error('This chapter could not be read');

  // Write anything still pending for the chapter being replaced — and cancel
  // its debounce either way — before app.pages stops being that chapter.
  await flushSave();

  const record = await readJson(await fsx.join(c.dir, 'chapter.json'));
  const rawsDir = await fsx.join(c.dir, 'raws');
  const cleanedDir = await fsx.join(c.dir, 'cleaned');

  const urls = [];
  // A missing image must not discard the typesetting that references it, and
  // must not drop the name either — a page that came back with cleaned:null
  // would have its cleaned page unlinked by the very next save.
  const mint = async (dir, name) => {
    if (!name) return null;
    try {
      const bytes = await fsx.readFile(await fsx.join(dir, name));
      const url = URL.createObjectURL(new Blob([bytes]));
      urls.push(url);
      return url;
    } catch {
      return null;
    }
  };

  const pages = [];
  try {
    for (const pg of record.pages ?? []) {
      // `file` and `cleaned` are the deduped on-disk names chosen at import;
      // they are the only things that resolve a page back to its images. Both
      // travel onto the store page, so nothing downstream pairs by position.
      // A slice 1 chapter.json has no `cleaned` key at all: absent reads null.
      pages.push({
        ...pg,
        file: pg.file ?? null,
        cleanedFile: pg.cleaned ?? null,
        raw: await mint(rawsDir, pg.file),
        cleaned: await mint(cleanedDir, pg.cleaned),
      });
    }
  } catch (e) {
    // Nothing was swapped in, so these URLs have no owner to revoke them.
    for (const u of urls) URL.revokeObjectURL(u);
    throw e;
  }

  // Swap last: the chapter on screen stays intact until the new one is ready.
  revokeOpenUrls();
  openUrls = urls;
  const minted = loadProjectPages(pages);
  // Order matters. loadProjectPages ends in markUnsaved(), which only schedules
  // a save while a chapterRef is set; setting the ref after it, then marking
  // saved, means opening a chapter never schedules a write of what it just read.
  app.chapterRef = { projectId, chapterId };
  // Unless the load had to mint ids, because then what is in memory is not what
  // is in the file. Those ids come off counters whose value depends on what else
  // was opened this session, so a repair that never reaches disk is redone
  // differently on every open, and the undo history has no stable box to address.
  // Mark it dirty instead and let the debounce write the repair now.
  if (minted) markUnsaved();
  else markSaved();
}

export async function saveOpenChapter() {
  // Captured once. Every await below is a window in which the user can close
  // this chapter or open another, and `app.pages` stops being what `ref`
  // describes the moment they do — so the identity of the ref is re-checked
  // after each one. A debounce already in flight cannot be cancelled; this is
  // what stops it writing an empty or foreign document over a real chapter.
  const ref = app.chapterRef;
  if (!ref) return;
  const c = chapterById(ref.projectId, ref.chapterId);
  if (!c) return;
  const path = await fsx.join(c.dir, 'chapter.json');
  if (app.chapterRef !== ref) return;
  const record = await readJson(path);
  if (app.chapterRef !== ref) return;

  record.updatedAt = now();
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
  await writeJson(path, record);
  // Any write that lands ends the failure streak, whoever asked for it — the
  // debounced autosave included. The escape below is for a disk that keeps
  // failing, not for one that failed once an hour ago.
  saveFailures = 0;
  // The in-memory catalogue follows the disk, never leads it.
  c.updatedAt = record.updatedAt;
  c.pageCount = record.pages.length;
  c.typeset = isTypeset(record.pages);
  // Only the chapter still on screen can be declared saved.
  if (app.chapterRef === ref) markSaved();
}

export function closeChapter() {
  revokeOpenUrls();
  // Cleared before the pages are: a debounce that lands after this point finds
  // no chapterRef and is a no-op, rather than a write of stale state.
  app.chapterRef = null;
  app.pages = [];
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
  // No document is loaded any more, so the editor falls back to its empty
  // state instead of offering a canvas over the blank stand-in page.
  app.loaded = false;
  // The failure streak belongs to the chapter that was open. Nothing is pending
  // any more, so the next chapter starts its own two-step from scratch.
  saveFailures = 0;
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

// Flush whatever the debounce is holding, on the way out of the chapter.
// `where` picks the wording — 'editor' for closing the chapter, 'quit' for
// closing the window. Resolves true when it is safe to go, false when the caller
// must stay put.
export async function flushBeforeLeaving(where) {
  const copy = LEAVING[where] ?? LEAVING.editor;
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
