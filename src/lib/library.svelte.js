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
import { slugify, uniqueSlug } from './paths.js';

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
  };
}

async function readProject(root, slug) {
  const dir = await fsx.join(root, slug);
  const raw = await readJson(await fsx.join(dir, 'project.json'));
  const chapters = [];
  for (const cslug of await subdirs(dir)) {
    try {
      chapters.push(await readChapter(dir, cslug));
    } catch {
      /* a directory without a readable chapter.json is not a chapter */
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
        found.push(await readProject(library.root, slug));
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
