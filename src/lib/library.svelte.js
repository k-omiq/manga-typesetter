// ===== The project library =====
// Owns the on-disk catalogue and every filesystem call that touches it.
// The layout is discovered by scanning for marker files rather than kept in a
// central index, so moving a folder in Finder cannot desynchronise anything.
//
//   <root>/<project-slug>/project.json
//   <root>/<project-slug>/thumb.png
//   <root>/<project-slug>/<chapter-slug>/chapter.json
//   <root>/<project-slug>/<chapter-slug>/raws/

import { fsx } from './fsx.js';
import { uniqueSlug, chapterSlug } from './paths.js';
import { app, loadProjectPages, markSaved, setSaver, flushSave, toast } from './store.svelte.js';
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

async function writeJson(path, value) {
  await fsx.writeTextFile(path, JSON.stringify(value, null, 2));
}

async function subdirs(dir) {
  const entries = await fsx.readDir(dir);
  return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

// ---------- scan ----------

async function readChapter(projectDir, slug) {
  const dir = await fsx.join(projectDir, slug);
  const raw = await readJson(await fsx.join(dir, 'chapter.json'));
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title ?? '',
    slug,
    dir,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    pageCount: (raw.pages ?? []).length,
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

export async function scanLibrary() {
  // No root means initRoot never finished. Scanning '' would either fail with
  // something unrecognisable or read the wrong place, and clearing the error
  // would throw away the only explanation the user has — including across the
  // retry button, which lands back here.
  if (!library.root) {
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
    if (!(await fsx.exists(library.root))) await fsx.mkdir(library.root);
    for (const slug of await subdirs(library.root)) {
      const marker = await fsx.join(library.root, slug, 'project.json');
      if (!(await fsx.exists(marker))) continue; // not a project directory
      try {
        const project = await readProject(library.root, slug, problems, dupes);
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
          dir: await fsx.join(library.root, slug),
          chapters: [],
          unreadable: true,
        });
      }
    }
    found.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
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
    library.projects = [];
    library.error = `Could not read the library at ${library.root} — ${e?.message ?? e}`;
  } finally {
    library.loading = false;
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

export async function createChapter({ projectId, number, title, files }) {
  const p = projectById(projectId);
  if (!p) throw new Error('No such project');

  // Same hole as createProject, and here it fires on the FAILURE path: the
  // rollback below is a recursive remove, and it must never be pointed at a
  // directory this run did not bring into being.
  const taken = new Set(p.chapters.map((c) => c.slug));
  const { slug, dir } = await freeDir(p.dir, chapterSlug(number, title ?? ''), taken);
  const rawsDir = await fsx.join(dir, 'raws');

  const ordered = [...files].sort(naturalSort);
  const willHaveCover = !p.coverChapterId;
  let thumbWritten = false;
  let dirCreated = false;

  try {
    await fsx.mkdir(rawsDir);
    dirCreated = true;

    const usedNames = new Set();
    const pages = [];
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i];
      const bytes = new Uint8Array(await f.arrayBuffer());
      const fileName = uniqueFileName(f.name, usedNames);
      usedNames.add(fileName);
      await fsx.writeFile(await fsx.join(rawsDir, fileName), bytes);
      pages.push({ id: i + 1, file: fileName, w: 0, h: 0, lines: [], detect: null, boxes: [] });
      if (i === 0 && willHaveCover) {
        try {
          await fsx.writeFile(await fsx.join(p.dir, 'thumb.png'), await makeThumb(bytes));
          thumbWritten = true;
        } catch {
          /* a missing cover is cosmetic; never fail chapter creation over it */
        }
      }
    }

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

  const urls = [];
  const pages = [];
  try {
    for (const pg of record.pages ?? []) {
      let url = null;
      try {
        // `file` is the deduped on-disk name chosen at import; it is the only
        // thing that resolves a page back to its raw.
        const bytes = await fsx.readFile(await fsx.join(rawsDir, pg.file));
        url = URL.createObjectURL(new Blob([bytes]));
        urls.push(url);
      } catch {
        // A missing raw must not discard the typesetting that references it.
        url = null;
      }
      // `file` travels onto the store page: from here on the page carries its
      // own raw's name, so nothing downstream has to pair by position.
      pages.push({ ...pg, file: pg.file ?? null, raw: url, cleaned: null });
    }
  } catch (e) {
    // Nothing was swapped in, so these URLs have no owner to revoke them.
    for (const u of urls) URL.revokeObjectURL(u);
    throw e;
  }

  // Swap last: the chapter on screen stays intact until the new one is ready.
  revokeOpenUrls();
  openUrls = urls;
  loadProjectPages(pages);
  // Order matters. loadProjectPages ends in markUnsaved(), which only schedules
  // a save while a chapterRef is set; setting the ref after it, then marking
  // saved, means opening a chapter never schedules a write of what it just read.
  app.chapterRef = { projectId, chapterId };
  markSaved();
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
  // Blob URLs are runtime-only. `file` is the durable reference and it is read
  // off the page itself, so a document whose pages were replaced or reordered
  // in the editor can never hand one page's raw to another.
  record.pages = app.pages.map((pg) => ({
    id: pg.id,
    file: pg.file ?? '',
    w: pg.w,
    h: pg.h,
    // $state.snapshot is a deep clone: the nested style objects inside boxes
    // and the detect geometry come out as plain data, never proxies.
    lines: $state.snapshot(pg.lines),
    detect: $state.snapshot(pg.detect),
    boxes: $state.snapshot(pg.boxes),
  }));
  await writeJson(path, record);
  // The in-memory catalogue follows the disk, never leads it.
  c.updatedAt = record.updatedAt;
  c.pageCount = record.pages.length;
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
}

// Wire the store's autosave and the route's leave-editor flush to this module.
setSaver(saveOpenChapter);
setLeaveEditorHook(async () => {
  try {
    await flushSave();
  } catch (e) {
    // Fail closed, and say so. Rethrowing keeps the route on the editor, so the
    // work is still on screen and the next edit will retry the save; leaving
    // would close the chapter and drop it.
    toast(`Could not save — staying in the editor. ${e?.message ?? e}`);
    throw e;
  }
  closeChapter();
});
