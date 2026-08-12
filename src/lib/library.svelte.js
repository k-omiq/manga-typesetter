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
import { slugify, uniqueSlug, chapterSlug } from './paths.js';

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

async function readProject(root, slug, problems) {
  const dir = await fsx.join(root, slug);
  const raw = await readJson(await fsx.join(dir, 'project.json'));
  const chapters = [];
  for (const cslug of await subdirs(dir)) {
    const marker = await fsx.join(dir, cslug, 'chapter.json');
    if (!(await fsx.exists(marker))) continue; // not a chapter directory
    try {
      chapters.push(await readChapter(dir, cslug));
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
  library.loading = true;
  library.error = '';
  const found = [];
  const problems = [];
  try {
    if (!(await fsx.exists(library.root))) await fsx.mkdir(library.root);
    for (const slug of await subdirs(library.root)) {
      const marker = await fsx.join(library.root, slug, 'project.json');
      if (!(await fsx.exists(marker))) continue; // not a project directory
      try {
        found.push(await readProject(library.root, slug, problems));
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
    if (problems.length) library.error = `Could not read: ${problems.join(', ')}`;
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

export async function createProject(name) {
  const taken = new Set(library.projects.map((p) => p.slug));
  const slug = uniqueSlug(name, taken);
  const dir = await fsx.join(library.root, slug);
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

export async function renameProject(projectId, name) {
  const p = projectById(projectId);
  if (!p) return;
  p.name = String(name).trim() || p.name;
  p.updatedAt = now();
  await writeJson(await fsx.join(p.dir, 'project.json'), {
    schema: SCHEMA,
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    coverChapterId: p.coverChapterId,
    coverPageId: p.coverPageId,
  });
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

  const taken = new Set(p.chapters.map((c) => c.slug));
  const slug = uniqueSlug(chapterSlug(number, title ?? ''), taken);
  const dir = await fsx.join(p.dir, slug);
  const rawsDir = await fsx.join(dir, 'raws');

  const ordered = [...files].sort(naturalSort);

  try {
    await fsx.mkdir(rawsDir);

    const pages = [];
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i];
      const bytes = new Uint8Array(await f.arrayBuffer());
      await fsx.writeFile(await fsx.join(rawsDir, f.name), bytes);
      pages.push({ id: i + 1, file: f.name, w: 0, h: 0, lines: [], detect: null, boxes: [] });
      if (i === 0 && !p.coverChapterId) {
        try {
          await fsx.writeFile(await fsx.join(p.dir, 'thumb.png'), await makeThumb(bytes));
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
    p.chapters = [...p.chapters, chapter].sort((a, b) => a.number - b.number);
    if (!p.coverChapterId) {
      p.coverChapterId = chapter.id;
      p.coverPageId = pages[0]?.id ?? null;
    }
    p.updatedAt = now();
    await renameProject(p.id, p.name); // rewrites project.json with the new cover + timestamp
    return chapter;
  } catch (e) {
    // No half-written chapter is left behind for the scan to find.
    try {
      await fsx.remove(dir);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
