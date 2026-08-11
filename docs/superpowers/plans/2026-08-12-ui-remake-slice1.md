# UI Remake Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dark indigo theme with a paper-toned greyscale design system and add a home screen that manages projects and chapters persisted to a library folder on disk.

**Architecture:** A new `library.svelte.js` owns the on-disk catalogue (Projects → Chapters → Pages) and every filesystem call; the existing `app` store in `store.svelte.js` is demoted to "the currently open chapter" and is hydrated/flushed on entering/leaving the editor. A dependency-free `route.svelte.js` holds a tagged-union route that `App.svelte` switches on. CSS custom properties in `src/styles.css` are renamed to the reference design's vocabulary and given light/dark values.

**Tech Stack:** Svelte 5 (runes), Vite 8, Tauri 2 (`@tauri-apps/plugin-fs`, `@tauri-apps/plugin-dialog`), Vitest (new).

**Spec:** `docs/superpowers/specs/2026-08-12-ui-remake-slice1-design.md`

## Global Constraints

- Svelte 5 runes only — `$state`, `$derived`, `$props`, `$bindable`. No `svelte/store`, no `writable`.
- Tauri-only runtime. There is no plain-browser code path and no second persistence backend. Run with `npm run tauri dev`.
- No new runtime dependencies in this slice. Vitest is a dev dependency only.
- Base font size is `12.5px`. `font-variant-numeric: tabular-nums` on `body` and on `button, input, select`.
- Monospace is reserved for filenames and file-ish labels. Everything else uses the system-UI stack.
- Artwork is the only colour on screen. No chrome element may introduce a hue. `--warn` (`#8a3f2a` light / `#d98b6a` dark) is the sole exception and is reserved for warnings and destructive confirmations.
- Existing code style: 2-space indent, single quotes, semicolons, trailing commas in multiline literals.
- Raw image files are copied byte-for-byte. No module in this slice may decode, re-encode, or otherwise transform a raw. Thumbnails are derived assets written to a separate path and are never written back over a raw.
- The editor's layout, tools, and interactions do not change in this slice. Only its colours change, plus a Home control and the project/chapter name in the top bar.

---

### Task 1: Vitest setup and path helpers

**Files:**
- Modify: `package.json`
- Modify: `vite.config.js`
- Create: `src/lib/paths.js`
- Test: `src/lib/paths.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `slugify(name: string) => string`
  - `uniqueSlug(name: string, taken: Set<string>) => string`
  - `chapterSlug(number: number, title: string) => string`

- [ ] **Step 1: Add Vitest**

Run:

```bash
npm install -D vitest@^3
```

- [ ] **Step 2: Add the test script**

In `package.json`, the `scripts` block becomes:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 3: Configure Vitest**

Replace `vite.config.js` entirely:

```js
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
```

- [ ] **Step 4: Write the failing test**

Create `src/lib/paths.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { slugify, uniqueSlug, chapterSlug } from './paths.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('One Piece')).toBe('one-piece');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify('Jojo!!  Part -- 7')).toBe('jojo-part-7');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  ~hello~  ')).toBe('hello');
  });

  it('keeps non-ASCII letters', () => {
    expect(slugify('ワンピース')).toBe('ワンピース');
  });

  it('falls back to "untitled" when nothing survives', () => {
    expect(slugify('!!!')).toBe('untitled');
  });

  it('truncates to 60 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });
});

describe('uniqueSlug', () => {
  it('returns the plain slug when free', () => {
    expect(uniqueSlug('Naruto', new Set())).toBe('naruto');
  });

  it('suffixes -2 on the first collision', () => {
    expect(uniqueSlug('Naruto', new Set(['naruto']))).toBe('naruto-2');
  });

  it('keeps counting past the first collision', () => {
    expect(uniqueSlug('Naruto', new Set(['naruto', 'naruto-2']))).toBe('naruto-3');
  });
});

describe('chapterSlug', () => {
  it('zero-pads the number to three digits', () => {
    expect(chapterSlug(7, 'The Duel')).toBe('007-the-duel');
  });

  it('omits the title when empty', () => {
    expect(chapterSlug(12, '')).toBe('012');
  });

  it('handles numbers past 999 without truncating', () => {
    expect(chapterSlug(1024, '')).toBe('1024');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./paths.js"`.

- [ ] **Step 6: Write the implementation**

Create `src/lib/paths.js`:

```js
// Filesystem-name helpers for the project library. Pure — no fs, no Tauri —
// so the naming rules can be tested on their own.

const MAX_SLUG = 60;

// Lowercase, punctuation collapsed to single hyphens. Letters and digits in any
// script survive, so a Japanese series name stays legible in Finder rather than
// becoming a row of hyphens.
export function slugify(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'untitled').slice(0, MAX_SLUG);
}

// Directory names must be unique within their parent. Identity lives in the
// JSON's `id`, so this only has to be stable enough to avoid a collision.
export function uniqueSlug(name, taken) {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Chapters sort naturally in a file browser when the number leads and is padded.
export function chapterSlug(number, title) {
  const n = String(number).padStart(3, '0');
  const t = title ? slugify(title) : '';
  return t ? `${n}-${t}` : n;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 12 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vite.config.js src/lib/paths.js src/lib/paths.test.js
git commit -m "feat: add Vitest and library path helpers"
```

---

### Task 2: Route module

**Files:**
- Create: `src/lib/route.svelte.js`
- Test: `src/lib/route.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `route` — `$state({ name, projectId, chapterId })`, `name` is `'library' | 'project' | 'editor'`
  - `goLibrary() => void`
  - `goProject(projectId: string) => void`
  - `goEditor(projectId: string, chapterId: string) => void`
  - `goBack() => void`
  - `setLeaveEditorHook(fn: (() => void | Promise<void>) | null) => void`
  - `resetRoute() => void` — test-only reset of route and history

The leave-editor hook exists so `library.svelte.js` can flush the open chapter without `route` importing `library` — that import would be circular, since the home screens navigate.

- [ ] **Step 1: Write the failing test**

Create `src/lib/route.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  route,
  goLibrary,
  goProject,
  goEditor,
  goBack,
  setLeaveEditorHook,
  resetRoute,
} from './route.svelte.js';

beforeEach(() => {
  setLeaveEditorHook(null);
  resetRoute();
});

describe('route', () => {
  it('starts at the library', () => {
    expect(route.name).toBe('library');
    expect(route.projectId).toBe(null);
    expect(route.chapterId).toBe(null);
  });

  it('carries ids into the project view', () => {
    goProject('p1');
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe(null);
  });

  it('carries both ids into the editor', () => {
    goEditor('p1', 'c1');
    expect(route.name).toBe('editor');
    expect(route.projectId).toBe('p1');
    expect(route.chapterId).toBe('c1');
  });

  it('goes back to the previous entry', () => {
    goProject('p1');
    goEditor('p1', 'c1');
    goBack();
    expect(route.name).toBe('project');
    expect(route.projectId).toBe('p1');
  });

  it('stays at the library when there is no history', () => {
    goBack();
    expect(route.name).toBe('library');
  });

  it('does not record a no-op navigation in history', () => {
    goProject('p1');
    goProject('p1');
    goBack();
    expect(route.name).toBe('library');
  });
});

describe('leave-editor hook', () => {
  it('fires when leaving the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goEditor('p1', 'c1');
    expect(hook).not.toHaveBeenCalled();
    await goLibrary();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not fire when navigating between non-editor views', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    await goProject('p1');
    await goLibrary();
    expect(hook).not.toHaveBeenCalled();
  });

  it('fires on goBack out of the editor', async () => {
    const hook = vi.fn();
    setLeaveEditorHook(hook);
    goProject('p1');
    goEditor('p1', 'c1');
    await goBack();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test src/lib/route.test.js`
Expected: FAIL — `Failed to resolve import "./route.svelte.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/route.svelte.js`:

```js
// ===== Where the app is =====
// A tagged union, not a set of booleans, so invalid combinations (an editor
// route with no chapter, say) cannot be represented.
//
//   { name: 'library' }
//   { name: 'project', projectId }
//   { name: 'editor',  projectId, chapterId }

export const route = $state({
  name: 'library',
  projectId: null,
  chapterId: null,
});

let history = [];

// Set by library.svelte.js. Lives here as a hook rather than an import because
// the home screens navigate, so route -> library would be circular.
let leaveEditorHook = null;
export function setLeaveEditorHook(fn) {
  leaveEditorHook = fn;
}

function same(a, b) {
  return a.name === b.name && a.projectId === b.projectId && a.chapterId === b.chapterId;
}

async function go(next, { record = true } = {}) {
  if (same(route, next)) return;
  if (route.name === 'editor' && leaveEditorHook) await leaveEditorHook();
  if (record) history.push({ name: route.name, projectId: route.projectId, chapterId: route.chapterId });
  route.name = next.name;
  route.projectId = next.projectId;
  route.chapterId = next.chapterId;
}

export function goLibrary() {
  return go({ name: 'library', projectId: null, chapterId: null });
}

export function goProject(projectId) {
  return go({ name: 'project', projectId, chapterId: null });
}

export function goEditor(projectId, chapterId) {
  return go({ name: 'editor', projectId, chapterId });
}

export function goBack() {
  const prev = history.pop();
  if (!prev) return Promise.resolve();
  return go(prev, { record: false });
}

// Test-only: return to a clean slate between cases.
export function resetRoute() {
  history = [];
  route.name = 'library';
  route.projectId = null;
  route.chapterId = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test src/lib/route.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/route.svelte.js src/lib/route.test.js
git commit -m "feat: add route module for library/project/editor views"
```

---

### Task 3: Design tokens and theming

**Files:**
- Modify: `src/styles.css` (all 504 lines — token block plus every rule referencing a renamed token)
- Create: `src/lib/theme.svelte.js`
- Modify: `src/App.svelte:12-26` (import and initialise the theme)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `theme` — `$state({ mode: 'light' | 'dark' })`
  - `initTheme() => void` — reads `localStorage`, applies `data-theme`
  - `setTheme(mode: 'light' | 'dark') => void`

There is no Vitest coverage here — this is a visual change, verified by running the app. The token rename is mechanical and the compiler catches nothing, so Step 5's grep is the real gate.

- [ ] **Step 1: Replace the token block**

In `src/styles.css`, replace lines 1–20 (the comment and the whole `:root{…}` block) with:

```css
/* ===== Manga Typesetter — warm-neutral greyscale desktop UI ===== */
:root{
  --bg:#e8e7e3; --sb:#e2e1dc; --panel:#f6f5f2; --panel2:#efeeea;
  --card:#fbfaf8; --surface:#fcfbf9; --paper:#fefdfb;
  --art:#e4e2dd; --art2:#dbd9d3;
  --line:rgba(42,38,32,.08); --line2:rgba(42,38,32,.15);
  --text:#22211e; --t2:rgba(34,33,30,.66); --t3:rgba(34,33,30,.55);
  --accent:#2c2b28; --accent-fg:#f8f7f4; --accent-soft:rgba(42,38,32,.075);
  --tint:rgba(34,33,30,.20); --tintline:rgba(34,33,30,.48); --warn:#8a3f2a;
  --edge:0 1px 1px rgba(42,38,32,.05), 0 5px 14px rgba(42,38,32,.07);
  --edge-soft:0 1px 2px rgba(42,38,32,.05);
  --topbar-h:46px;
  --status-h:26px;
  --radius:6px;
}
:root[data-theme="dark"]{
  --bg:#121313; --sb:#0d0e0e; --panel:#1a1b1c; --panel2:#202122;
  --card:#1a1b1c; --surface:#212223; --paper:#f6f5f2;
  --art:#e4e3df; --art2:#dbdad5;
  --line:rgba(255,255,255,.07); --line2:rgba(255,255,255,.13);
  --text:#e9e8e5; --t2:rgba(233,232,229,.64); --t3:rgba(233,232,229,.48);
  --accent:#e9e8e5; --accent-fg:#141514; --accent-soft:rgba(233,232,229,.10);
  --tint:rgba(246,245,242,.32); --tintline:rgba(255,255,255,.72); --warn:#d98b6a;
  --edge:0 0 0 1px rgba(255,255,255,.05), 0 6px 20px rgba(0,0,0,.42);
  --edge-soft:0 0 0 1px rgba(255,255,255,.05);
}
```

- [ ] **Step 2: Rewrite the body and scrollbar rules**

In `src/styles.css`, the `body` rule becomes:

```css
body{
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP","Microsoft YaHei",sans-serif;
  background:var(--bg); color:var(--text);
  font-size:12.5px; overflow:hidden;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
  user-select:none; -webkit-user-select:none;
}
button,input,select{ font:inherit; color:inherit; font-variant-numeric:tabular-nums; }
```

Delete the old `button{ font-family:inherit; color:inherit; }` rule it replaces.

The scrollbar rules become:

```css
::-webkit-scrollbar-thumb{ background:var(--line2); border-radius:5px; border:2px solid transparent; background-clip:padding-box; }
::-webkit-scrollbar-thumb:hover{ background:var(--t3); background-clip:padding-box; }
```

- [ ] **Step 3: Apply the token rename across the file**

Work through `src/styles.css` and apply this mapping to every `var()` reference. There are 139 of them.

| Old | New |
| --- | --- |
| `var(--surface-2)` | `var(--panel2)` |
| `var(--border)` | `var(--line)` |
| `var(--border-light)` | `var(--line2)` |
| `var(--muted)` | `var(--t2)` |
| `var(--muted-2)` | `var(--t3)` |
| `var(--accent-hi)` | `var(--accent)` |
| `var(--accent-dim)` | `var(--accent-soft)` |
| `var(--backdrop)` | `var(--art)` |
| `var(--danger)` | `var(--warn)` |
| `var(--ok)` | `var(--text)` |

`var(--panel)`, `var(--surface)`, `var(--text)`, `var(--accent)`, `var(--radius)`, `var(--topbar-h)`, and `var(--status-h)` keep their names — their values changed in Step 1.

Then fix the remaining literals:

- `.brand .logo` — delete `background:linear-gradient(135deg,var(--accent),#8b5cf6);` and its `box-shadow:0 2px 6px rgba(99,102,241,.4);`. Replace with `background:var(--accent); color:var(--accent-fg);` and delete the `color:#fff` on that rule.
- `.pagenav .indicator b{ color:#fff; }` becomes `.pagenav .indicator b{ color:var(--text); }`.
- Any button using the accent as a fill needs `color:var(--accent-fg)` so its label stays legible — in light theme the accent is near-black, in dark it is near-white.

- [ ] **Step 4: Write the theme module**

Create `src/lib/theme.svelte.js`:

```js
// ===== Light / dark =====
// The preference is explicit and persisted; there is deliberately no
// prefers-color-scheme fallback, so the app never changes appearance underfoot.

const KEY = 'mt.theme';

export const theme = $state({ mode: 'light' });

function apply(mode) {
  document.documentElement.dataset.theme = mode;
}

export function setTheme(mode) {
  theme.mode = mode === 'dark' ? 'dark' : 'light';
  apply(theme.mode);
  try {
    localStorage.setItem(KEY, theme.mode);
  } catch {
    /* ignore — a missing preference just means the default next launch */
  }
}

export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  setTheme(saved === 'dark' ? 'dark' : 'light');
}
```

- [ ] **Step 5: Verify no old token survives**

Run:

```bash
grep -rnE '\-\-(muted|border|surface-2|accent-hi|accent-dim|backdrop|danger|ok)\b|#161616|#6366f1|#8b5cf6|Inter' src/
```

Expected: no output. Any hit is an unconverted reference — fix it and re-run.

- [ ] **Step 6: Initialise the theme on mount**

In `src/App.svelte`, add to the imports:

```js
  import { initTheme } from './lib/theme.svelte.js';
```

and make `initTheme()` the first line of the existing `onMount` callback, before `restoreFonts()`.

- [ ] **Step 7: Verify visually**

Run: `npm run tauri dev`

Expected: the editor renders on paper tones with a near-black accent; no indigo anywhere; text is `12.5px`; numbers in the page indicator are tabular. Then in the devtools console run `document.documentElement.dataset.theme = 'dark'` and confirm every surface flips with no element left unthemed.

- [ ] **Step 8: Commit**

```bash
git add src/styles.css src/lib/theme.svelte.js src/App.svelte
git commit -m "feat: replace dark indigo theme with paper greyscale tokens"
```

---

### Task 4: Filesystem facade

**Files:**
- Create: `src/lib/fsx.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `fsx` — an object with `readDir`, `readTextFile`, `writeTextFile`, `readFile`, `writeFile`, `mkdir`, `remove`, `exists`, `copyFile`, `join`, `homeDir`.

This exists so `library.svelte.js` has one seam to mock in tests, and so the Tauri plugin imports stay out of the module graph until first use — matching the dynamic-import pattern already used in `src/lib/importer.js:136-154`.

- [ ] **Step 1: Write the implementation**

Create `src/lib/fsx.js`:

```js
// ===== Filesystem facade =====
// Every library filesystem call goes through here. One seam to mock in tests,
// and the Tauri plugins stay lazily imported (same pattern as importer.js).

let fsMod = null;
let pathMod = null;

async function fs() {
  if (!fsMod) fsMod = await import('@tauri-apps/plugin-fs');
  return fsMod;
}

async function path() {
  if (!pathMod) pathMod = await import('@tauri-apps/api/path');
  return pathMod;
}

export const fsx = {
  async readDir(p) {
    return (await fs()).readDir(p);
  },
  async readTextFile(p) {
    return (await fs()).readTextFile(p);
  },
  async writeTextFile(p, contents) {
    return (await fs()).writeTextFile(p, contents);
  },
  async readFile(p) {
    return (await fs()).readFile(p);
  },
  async writeFile(p, bytes) {
    return (await fs()).writeFile(p, bytes);
  },
  async mkdir(p) {
    return (await fs()).mkdir(p, { recursive: true });
  },
  async remove(p) {
    return (await fs()).remove(p, { recursive: true });
  },
  async exists(p) {
    return (await fs()).exists(p);
  },
  // Byte-for-byte. Never decodes, never re-encodes — raws must survive a copy
  // unchanged, including bit depth, colour type, and any ICC profile.
  async copyFile(from, to) {
    const m = await fs();
    await m.writeFile(to, await m.readFile(from));
  },
  async join(...parts) {
    return (await path()).join(...parts);
  },
  async homeDir() {
    return (await path()).homeDir();
  },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/fsx.js
git commit -m "feat: add filesystem facade for the project library"
```

---

### Task 5: Library store — scan, create, delete

**Files:**
- Create: `src/lib/library.svelte.js`
- Test: `src/lib/library.test.js`

**Interfaces:**
- Consumes: `fsx` from `src/lib/fsx.js`, `slugify`/`uniqueSlug`/`chapterSlug` from `src/lib/paths.js`.
- Produces:
  - `library` — `$state({ root, projects, loading, error })`, where `projects` is an array of `{ id, name, slug, dir, createdAt, updatedAt, coverChapterId, coverPageId, chapters, unreadable }` and each chapter is `{ id, number, title, slug, dir, createdAt, updatedAt, pageCount }`
  - `defaultRoot() => Promise<string>`
  - `setRoot(path: string) => Promise<void>`
  - `scanLibrary() => Promise<void>`
  - `createProject(name: string) => Promise<Project>`
  - `deleteProject(projectId: string) => Promise<void>`
  - `deleteChapter(projectId: string, chapterId: string) => Promise<void>`
  - `projectById(id: string) => Project | undefined`
  - `chapterById(projectId: string, chapterId: string) => Chapter | undefined`

Chapter creation and open/save land in Tasks 6 and 8 respectively — this task is the catalogue only, so it can be reviewed against a fixture tree without any image handling in play.

- [ ] **Step 1: Write the failing test**

Create `src/lib/library.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  return {
    fsx: {
      _tree: tree,
      async readDir(p) {
        const prefix = p.endsWith('/') ? p : p + '/';
        const names = new Set();
        for (const d of tree.dirs) {
          if (d.startsWith(prefix)) {
            const rest = d.slice(prefix.length);
            if (rest && !rest.includes('/')) names.add(rest);
          }
        }
        return [...names].map((name) => ({ name, isDirectory: true, isFile: false }));
      },
      async readTextFile(p) {
        if (!tree.files.has(p)) throw new Error('ENOENT ' + p);
        return tree.files.get(p);
      },
      async writeTextFile(p, c) {
        tree.files.set(p, c);
      },
      async mkdir(p) {
        tree.dirs.add(p);
      },
      async remove(p) {
        for (const d of [...tree.dirs]) if (d === p || d.startsWith(p + '/')) tree.dirs.delete(d);
        for (const f of [...tree.files.keys()]) if (f.startsWith(p + '/')) tree.files.delete(f);
      },
      async exists(p) {
        return tree.dirs.has(p) || tree.files.has(p);
      },
      async join(...parts) {
        return parts.join('/');
      },
      async homeDir() {
        return '/home/u';
      },
      async readFile() {
        return new Uint8Array();
      },
      async writeFile() {},
      async copyFile() {},
    },
  };
});

const { fsx } = await import('./fsx.js');
const { library, setRoot, scanLibrary, createProject, deleteProject, projectById } = await import(
  './library.svelte.js'
);

function seedProject(slug, json, chapters = []) {
  fsx._tree.dirs.add(`/lib/${slug}`);
  fsx._tree.files.set(`/lib/${slug}/project.json`, json);
  for (const [cslug, cjson] of chapters) {
    fsx._tree.dirs.add(`/lib/${slug}/${cslug}`);
    fsx._tree.files.set(`/lib/${slug}/${cslug}/chapter.json`, cjson);
  }
}

const PROJECT = (id, name) =>
  JSON.stringify({ schema: 1, id, name, createdAt: 'T0', updatedAt: 'T0', coverChapterId: null, coverPageId: null });

const CHAPTER = (id, number, pages) =>
  JSON.stringify({ schema: 1, id, number, title: '', createdAt: 'T0', updatedAt: 'T0', pages });

beforeEach(async () => {
  fsx._tree.dirs.clear();
  fsx._tree.files.clear();
  fsx._tree.dirs.add('/lib');
  await setRoot('/lib');
});

describe('scanLibrary', () => {
  it('finds projects and their chapters', async () => {
    seedProject('one-piece', PROJECT('p1', 'One Piece'), [['001', CHAPTER('c1', 1, [{ id: 1 }, { id: 2 }])]]);
    await scanLibrary();
    expect(library.projects).toHaveLength(1);
    expect(library.projects[0].name).toBe('One Piece');
    expect(library.projects[0].chapters[0].pageCount).toBe(2);
  });

  it('skips a corrupt project.json without failing the scan', async () => {
    seedProject('good', PROJECT('p1', 'Good'));
    fsx._tree.dirs.add('/lib/bad');
    fsx._tree.files.set('/lib/bad/project.json', '{ this is not json');
    await scanLibrary();
    expect(library.projects.filter((p) => !p.unreadable)).toHaveLength(1);
    expect(library.projects.filter((p) => p.unreadable)).toHaveLength(1);
    expect(library.error).toBeTruthy();
  });

  it('ignores directories with no project.json', async () => {
    fsx._tree.dirs.add('/lib/.DS_Store_dir');
    await scanLibrary();
    expect(library.projects).toHaveLength(0);
  });

  it('sorts chapters by number', async () => {
    seedProject('x', PROJECT('p1', 'X'), [
      ['010', CHAPTER('c10', 10, [])],
      ['002', CHAPTER('c2', 2, [])],
    ]);
    await scanLibrary();
    expect(library.projects[0].chapters.map((c) => c.number)).toEqual([2, 10]);
  });
});

describe('createProject', () => {
  it('writes project.json and appears in the catalogue', async () => {
    const p = await createProject('New Series');
    expect(p.slug).toBe('new-series');
    expect(fsx._tree.files.has('/lib/new-series/project.json')).toBe(true);
    expect(projectById(p.id)).toBeTruthy();
  });

  it('avoids a directory collision on a duplicate name', async () => {
    await createProject('Dup');
    const second = await createProject('Dup');
    expect(second.slug).toBe('dup-2');
  });
});

describe('deleteProject', () => {
  it('removes the directory and the catalogue entry', async () => {
    const p = await createProject('Gone');
    await deleteProject(p.id);
    expect(fsx._tree.dirs.has('/lib/gone')).toBe(false);
    expect(projectById(p.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test src/lib/library.test.js`
Expected: FAIL — `Failed to resolve import "./library.svelte.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/library.svelte.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test src/lib/library.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/library.svelte.js src/lib/library.test.js
git commit -m "feat: add project library catalogue with disk scan"
```

---

### Task 6: Chapter creation — copy raws and write chapter.json

**Files:**
- Modify: `src/lib/library.svelte.js` (append)
- Modify: `src/lib/library.test.js` (append)

**Interfaces:**
- Consumes: everything from Task 5, plus `chapterSlug` from `src/lib/paths.js`.
- Produces:
  - `createChapter({ projectId, number, title, files }) => Promise<Chapter>` where `files` is an array of `File`
  - `makeThumb(bytes: Uint8Array) => Promise<Uint8Array>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/library.test.js`:

```js
const { createChapter } = await import('./library.svelte.js');

function fakeFile(name, byte) {
  return { name, arrayBuffer: async () => new Uint8Array([byte]).buffer };
}

describe('createChapter', () => {
  it('writes chapter.json with one page per file, in natural order', async () => {
    const p = await createProject('Series');
    const c = await createChapter({
      projectId: p.id,
      number: 3,
      title: 'The Duel',
      files: [fakeFile('page10.png', 10), fakeFile('page2.png', 2)],
    });
    expect(c.slug).toBe('003-the-duel');
    const json = JSON.parse(fsx._tree.files.get(`${c.dir}/chapter.json`));
    expect(json.pages.map((pg) => pg.file)).toEqual(['page2.png', 'page10.png']);
  });

  it('appears in the project catalogue immediately', async () => {
    const p = await createProject('Series');
    await createChapter({ projectId: p.id, number: 1, title: '', files: [fakeFile('a.png', 1)] });
    expect(projectById(p.id).chapters).toHaveLength(1);
  });

  it('rolls back the directory when a copy fails', async () => {
    const p = await createProject('Series');
    const broken = { name: 'bad.png', arrayBuffer: async () => { throw new Error('read failed'); } };
    await expect(
      createChapter({ projectId: p.id, number: 1, title: '', files: [broken] }),
    ).rejects.toThrow();
    expect(fsx._tree.dirs.has(`${p.dir}/001`)).toBe(false);
    expect(projectById(p.id).chapters).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test src/lib/library.test.js`
Expected: FAIL — `createChapter is not a function`.

- [ ] **Step 3: Write the implementation**

Add `chapterSlug` to the existing `paths.js` import at the top of `src/lib/library.svelte.js`:

```js
import { slugify, uniqueSlug, chapterSlug } from './paths.js';
```

Then append to `src/lib/library.svelte.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test src/lib/library.test.js`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/library.svelte.js src/lib/library.test.js
git commit -m "feat: create chapters by copying raws byte-for-byte"
```

---

### Task 7: Open and save a chapter

**Files:**
- Modify: `src/lib/store.svelte.js:92-120` (state), `:172-177` (save indicator)
- Modify: `src/lib/library.svelte.js` (append)
- Modify: `src/lib/data.js:66-68` (drop the seed page)

**Interfaces:**
- Consumes: `loadProjectPages`, `app`, `markSaved` from `src/lib/store.svelte.js`; `setLeaveEditorHook` from `src/lib/route.svelte.js`.
- Produces:
  - `openChapter(projectId, chapterId) => Promise<void>`
  - `saveOpenChapter() => Promise<void>`
  - `closeChapter() => void`
  - `app.chapterRef` — `{ projectId, chapterId } | null`
  - `setSaver(fn)` in `store.svelte.js` — registers the debounced saver

- [ ] **Step 1: Drop the demo seed**

In `src/lib/data.js`, replace lines 64–68 with:

```js
// No seed pages. `app.pages` is empty until a chapter is opened from the
// library; the editor is only routed to once one has been.
export const PAGES = [];
```

- [ ] **Step 2: Make the store hold a chapter reference and a debounced saver**

In `src/lib/store.svelte.js`, add to the `app` state object (after `detectBatch`):

```js
  chapterRef: null, // { projectId, chapterId } while a chapter is open
```

Replace the save-indicator section (`markUnsaved` / `markSaved`) with:

```js
// ---------- save indicator + autosave ----------
// The saver is registered by library.svelte.js rather than imported, so the
// store stays unaware of the filesystem and the two modules do not cycle.
let saver = null;
let saveT;
export function setSaver(fn) {
  saver = fn;
}
export function markUnsaved() {
  app.saved = false;
  if (!saver || !app.chapterRef) return;
  clearTimeout(saveT);
  saveT = setTimeout(() => saver(), 800);
}
export function markSaved() {
  app.saved = true;
}
export function flushSave() {
  clearTimeout(saveT);
  return saver && app.chapterRef ? saver() : Promise.resolve();
}
```

- [ ] **Step 3: Guard `page()` against an empty chapter**

In `src/lib/store.svelte.js`, replace the `page` helper with:

```js
// A blank stand-in keeps every consumer total while no chapter is open. The
// editor is only routed to with pages loaded, so this is a safety net, not a
// code path with a UI.
const NO_PAGE = { id: 0, raw: null, cleaned: null, w: PAGE_W, h: PAGE_H, lines: [], detect: null, boxes: [], activeLineN: null };
export const page = () => app.pages[app.pageIndex] ?? NO_PAGE;
```

- [ ] **Step 4: Write the open/save implementation**

Append to `src/lib/library.svelte.js`:

```js
// ---------- open / save the editor's chapter ----------

import { app, loadProjectPages, markSaved, setSaver, flushSave } from './store.svelte.js';
import { setLeaveEditorHook } from './route.svelte.js';

let openUrls = [];

function revokeOpenUrls() {
  for (const u of openUrls) URL.revokeObjectURL(u);
  openUrls = [];
}

export async function openChapter(projectId, chapterId) {
  const p = projectById(projectId);
  const c = chapterById(projectId, chapterId);
  if (!p || !c) throw new Error('No such chapter');

  const record = await readJson(await fsx.join(c.dir, 'chapter.json'));
  const rawsDir = await fsx.join(c.dir, 'raws');

  revokeOpenUrls();
  const pages = [];
  for (const pg of record.pages ?? []) {
    let url = null;
    try {
      const bytes = await fsx.readFile(await fsx.join(rawsDir, pg.file));
      url = URL.createObjectURL(new Blob([bytes]));
      openUrls.push(url);
    } catch {
      // A missing raw must not discard the typesetting that references it.
      url = null;
    }
    pages.push({ ...pg, raw: url, cleaned: null });
  }

  loadProjectPages(pages);
  app.chapterRef = { projectId, chapterId };
  markSaved();
}

export async function saveOpenChapter() {
  const ref = app.chapterRef;
  if (!ref) return;
  const c = chapterById(ref.projectId, ref.chapterId);
  if (!c) return;
  const record = await readJson(await fsx.join(c.dir, 'chapter.json'));
  record.updatedAt = now();
  // Blob URLs are runtime-only; `file` is the durable reference.
  record.pages = app.pages.map((pg, i) => ({
    id: pg.id,
    file: record.pages[i]?.file ?? '',
    w: pg.w,
    h: pg.h,
    lines: $state.snapshot(pg.lines),
    detect: $state.snapshot(pg.detect),
    boxes: $state.snapshot(pg.boxes),
  }));
  await writeJson(await fsx.join(c.dir, 'chapter.json'), record);
  c.updatedAt = record.updatedAt;
  c.pageCount = record.pages.length;
  markSaved();
}

export function closeChapter() {
  revokeOpenUrls();
  app.chapterRef = null;
  app.pages = [];
  app.pageIndex = 0;
  app.selectedId = null;
  app.editingId = null;
}

// Wire the store's autosave and the route's leave-editor flush to this module.
setSaver(saveOpenChapter);
setLeaveEditorHook(async () => {
  await flushSave();
  closeChapter();
});
```

- [ ] **Step 5: Verify the existing tests still pass**

Run: `npm test`
Expected: PASS — 31 tests (12 paths, 9 route, 10 library). The `library.test.js` mock already stubs `readFile`/`writeFile`, and `openChapter` is not exercised there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.svelte.js src/lib/library.svelte.js src/lib/data.js
git commit -m "feat: open and autosave chapters from the library"
```

---

### Task 8: Home screens

**Files:**
- Create: `src/lib/home/HomeFrame.svelte`
- Create: `src/lib/home/ProjectCard.svelte`
- Create: `src/lib/home/LibraryView.svelte`
- Create: `src/lib/home/ProjectView.svelte`
- Modify: `src/styles.css` (append the home-screen rules)

**Interfaces:**
- Consumes: `library`, `scanLibrary`, `createProject`, `deleteProject`, `deleteChapter`, `projectById` from `src/lib/library.svelte.js`; `route`, `goProject`, `goLibrary`, `goEditor` from `src/lib/route.svelte.js`.
- Produces: four components. `LibraryView` and `ProjectView` take no props. `HomeFrame` takes a `children` snippet plus an `onSettings` callback. `ProjectCard` takes `{ project, onOpen, onDelete }`.

The New-chapter dialog is Task 9; in this task both **New chapter** buttons call a `onNewChapter` prop that `App.svelte` will wire up next task. Until then it is passed as a no-op.

- [ ] **Step 1: Write the shared frame**

Create `src/lib/home/HomeFrame.svelte`:

```svelte
<script>
  // The scrolling page frame shared by the library and project screens.
  let { onSettings, children } = $props();
</script>

<div class="home-scroll">
  <div class="home-frame">
    <header class="home-head">
      <div class="wordmark">MANGA TYPESETTER</div>
      <div class="spacer"></div>
      <button class="soft-btn" onclick={onSettings}>Settings</button>
    </header>
    {@render children()}
  </div>
</div>
```

- [ ] **Step 2: Write the project card**

Create `src/lib/home/ProjectCard.svelte`:

```svelte
<script>
  import { convertFileSrc } from '@tauri-apps/api/core';

  let { project, onOpen, onDelete } = $props();

  const thumb = $derived(convertFileSrc(`${project.dir}/thumb.png`));
  const chapterLine = $derived(
    project.chapters.length === 1 ? '1 chapter' : `${project.chapters.length} chapters`,
  );
  const pageCount = $derived(project.chapters.reduce((n, c) => n + c.pageCount, 0));
</script>

<div class="pcard" class:unreadable={project.unreadable}>
  <button class="pcard-cover" onclick={() => onOpen(project)} disabled={project.unreadable}>
    {#if !project.unreadable}
      <img src={thumb} alt="" onerror={(e) => (e.currentTarget.style.visibility = 'hidden')} />
    {/if}
  </button>
  <div class="pcard-meta">
    <div class="pcard-name">{project.name}</div>
    {#if project.unreadable}
      <div class="pcard-sub warn">Unreadable — check this folder</div>
    {:else}
      <div class="pcard-sub">{chapterLine}</div>
      <div class="pcard-sub small">{pageCount} pages</div>
    {/if}
  </div>
  <button class="pcard-del" onclick={() => onDelete(project)} title="Delete project">Delete</button>
</div>
```

- [ ] **Step 3: Write the library view**

Create `src/lib/home/LibraryView.svelte`:

```svelte
<script>
  import { onMount } from 'svelte';
  import { library, scanLibrary, createProject, deleteProject } from '../library.svelte.js';
  import { goProject } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';
  import ProjectCard from './ProjectCard.svelte';

  let { onNewChapter } = $props();

  let confirmingId = $state(null); // inline two-step delete confirm
  let naming = $state(false);
  let newName = $state('');

  onMount(scanLibrary);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    naming = false;
    newName = '';
    const p = await createProject(name);
    goProject(p.id);
  }

  async function onDelete(project) {
    if (confirmingId !== project.id) {
      confirmingId = project.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteProject(project.id);
      toast(`Deleted ${project.name}`);
    } catch (e) {
      toast(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

<div class="home-actions">
  <button class="accent-btn" onclick={onNewChapter}>New chapter</button>
  {#if naming}
    <input
      class="name-input"
      placeholder="Project name"
      bind:value={newName}
      onkeydown={(e) => e.key === 'Enter' && onCreate()}
      autofocus
    />
    <button class="soft-btn wide" onclick={onCreate}>Create</button>
  {:else}
    <button class="soft-btn wide" onclick={() => (naming = true)}>New project</button>
  {/if}
</div>

<div class="section-label">PROJECTS</div>

{#if library.error}
  <div class="home-error">{library.error}</div>
{/if}

{#if library.projects.length}
  <div class="pgrid">
    {#each library.projects as project (project.id)}
      <ProjectCard
        {project}
        onOpen={(p) => goProject(p.id)}
        onDelete={onDelete}
      />
      {#if confirmingId === project.id}
        <div class="confirm-note warn">
          Deletes the folder and every chapter in it. No undo. Click Delete again to confirm.
        </div>
      {/if}
    {/each}
  </div>
{:else if !library.loading}
  <div class="home-empty">
    <div>No projects yet.</div>
    <div>Start a chapter and the raws you pick will be copied into your library.</div>
  </div>
{/if}
```

- [ ] **Step 4: Write the project view**

Create `src/lib/home/ProjectView.svelte`:

```svelte
<script>
  import { projectById, deleteChapter } from '../library.svelte.js';
  import { route, goLibrary, goEditor } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';

  let { onNewChapter } = $props();

  const project = $derived(projectById(route.projectId));
  const pageTotal = $derived((project?.chapters ?? []).reduce((n, c) => n + c.pageCount, 0));

  let confirmingId = $state(null);

  async function onDelete(chapter) {
    if (confirmingId !== chapter.id) {
      confirmingId = chapter.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteChapter(project.id, chapter.id);
      toast(`Deleted chapter ${chapter.number}`);
    } catch (e) {
      toast(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

{#if project}
  <button class="back-link" onclick={goLibrary}>← Projects</button>

  <div class="project-head">
    <div class="project-title">
      <div class="project-name">{project.name}</div>
      <div class="project-meta">
        {project.chapters.length} chapters · {pageTotal} pages
      </div>
    </div>
    <button class="soft-btn" onclick={() => onNewChapter(project.id)}>New chapter</button>
  </div>

  <div class="section-label spaced">CHAPTERS</div>

  <div class="chapter-table">
    {#each project.chapters as c (c.id)}
      <div class="chapter-row">
        <button class="chapter-open" onclick={() => goEditor(project.id, c.id)}>
          <div class="chapter-num">{c.number}</div>
          <div class="chapter-title">
            <div>{c.title || `Chapter ${c.number}`}</div>
            <div class="chapter-sub">{c.pageCount} pages</div>
          </div>
        </button>
        <button class="chapter-del" onclick={() => onDelete(c)}>Delete</button>
      </div>
      {#if confirmingId === c.id}
        <div class="confirm-note warn">
          Deletes this chapter's folder, including its {c.pageCount} copied raws. No undo. Click Delete again to confirm.
        </div>
      {/if}
    {:else}
      <div class="home-empty">No chapters yet.</div>
    {/each}
  </div>
{:else}
  <div class="home-empty">That project is no longer in the library.</div>
{/if}
```

- [ ] **Step 5: Append the home-screen styles**

Append to `src/styles.css`:

```css
/* ---------- home screens ---------- */
.home-scroll{ height:100vh; overflow-y:auto; overflow-x:hidden; background:var(--bg); }
.home-frame{ min-height:100vh; display:flex; flex-direction:column; padding:26px 34px 64px; }
.home-head{ display:flex; align-items:center; gap:16px; flex:none; }
.home-head .spacer{ flex:1; }
.wordmark{ font-size:12.5px; font-weight:600; letter-spacing:.3em; }

.soft-btn{
  height:28px; padding:0 12px; border:1px solid transparent; border-radius:7px;
  background:var(--accent-soft); font-size:11.5px; color:var(--t2); cursor:pointer; white-space:nowrap;
}
.soft-btn.wide{ width:212px; height:40px; font-size:12.5px; color:var(--text); border-radius:8px; }
.accent-btn{
  width:212px; height:40px; border:none; border-radius:8px;
  background:var(--accent); color:var(--accent-fg);
  font-size:12.5px; font-weight:600; letter-spacing:.02em; cursor:pointer;
}
.name-input{
  width:212px; height:40px; padding:0 12px; border:1px solid var(--line2); border-radius:8px;
  background:var(--surface); color:var(--text); font-size:12.5px;
}

.home-actions{ display:flex; flex-direction:column; align-items:center; gap:10px; padding:168px 0 152px; }
.section-label{ font-size:10.5px; letter-spacing:.22em; color:var(--t3); margin-bottom:18px; }
.section-label.spaced{ margin:56px 0 4px; }
.home-empty{ padding:52px 0; font-size:12px; color:var(--t3); line-height:1.7; }
.home-error{ padding:12px 0 20px; font-size:11.5px; color:var(--warn); }
.confirm-note{ grid-column:1/-1; padding:8px 0 14px; font-size:11px; line-height:1.6; }
.warn{ color:var(--warn); }

.pgrid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:32px 20px; }
.pcard{ display:flex; flex-direction:column; min-width:0; }
.pcard-cover{
  position:relative; aspect-ratio:2/3; width:100%; padding:0;
  background:var(--card); border:none; border-radius:3px; box-shadow:var(--edge);
  overflow:hidden; cursor:pointer;
}
.pcard-cover img{ width:100%; height:100%; object-fit:cover; display:block; }
.pcard-meta{ padding-top:11px; min-width:0; }
.pcard-name{ font-size:13px; font-weight:500; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pcard-sub{ font-size:11px; color:var(--t3); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pcard-sub.small{ font-size:10.5px; margin-top:5px; }
.pcard-del{
  align-self:flex-start; margin-top:8px; padding:0; border:none; background:transparent;
  font-size:10.5px; color:var(--t3); cursor:pointer;
}
.pcard-del:hover{ color:var(--warn); }
.pcard.unreadable .pcard-cover{ cursor:default; opacity:.5; }

.back-link{ border:none; background:transparent; padding:0; font-size:11.5px; color:var(--t3); cursor:pointer; letter-spacing:.04em; }
.project-head{ display:flex; align-items:flex-end; gap:24px; margin-top:22px; }
.project-title{ flex:1; min-width:0; }
.project-name{ font-size:27px; font-weight:500; letter-spacing:-.02em; line-height:1.1; }
.project-meta{ font-size:11.5px; color:var(--t3); margin-top:9px; }

.chapter-table{ border-top:1px solid var(--line); }
.chapter-row{ display:flex; align-items:center; border-bottom:1px solid var(--line); }
.chapter-open{
  flex:1; display:flex; align-items:center; gap:16px; min-width:0;
  padding:14px 0; border:none; background:transparent; color:inherit; text-align:left; cursor:pointer;
}
.chapter-open:hover{ background:var(--accent-soft); }
.chapter-num{ width:72px; flex:none; font-size:13px; padding-left:8px; }
.chapter-title{ flex:1; min-width:0; font-size:13px; }
.chapter-sub{ font-size:11px; color:var(--t3); margin-top:4px; }
.chapter-del{ border:none; background:transparent; font-size:10.5px; color:var(--t3); cursor:pointer; padding:0 8px; }
.chapter-del:hover{ color:var(--warn); }
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run build`
Expected: build succeeds. The screens are not routed to yet — Task 9 wires them.

- [ ] **Step 7: Commit**

```bash
git add src/lib/home src/styles.css
git commit -m "feat: add library and project home screens"
```

---

### Task 9: Wire routing, the new-chapter dialog, and Settings

**Files:**
- Create: `src/lib/home/NewChapterDialog.svelte`
- Modify: `src/App.svelte` (whole file)
- Modify: `src/lib/TopBar.svelte:16-21` (Home control and chapter name)
- Modify: `src/lib/SettingsModal.svelte` (theme control, library root, scoped-palette cleanup)

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 5, 6, 7, 8.
- Produces: a running app that boots to the library.

- [ ] **Step 1: Write the new-chapter dialog**

Create `src/lib/home/NewChapterDialog.svelte`:

```svelte
<script>
  // Reachable from both the library root and a project screen, so it can create
  // the project too — otherwise the library's primary button is dead on an
  // empty library.
  import { library, createProject, createChapter } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickFilesTauri } from '../importer.js';
  import { toast } from '../store.svelte.js';

  let { open = $bindable(), projectId = null } = $props();

  let target = $state('');
  let newProjectName = $state('');
  let number = $state(1);
  let title = $state('');
  let files = $state([]);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (open) {
      target = projectId ?? library.projects.find((p) => !p.unreadable)?.id ?? '__new__';
      const p = library.projects.find((x) => x.id === target);
      number = p ? (p.chapters.at(-1)?.number ?? 0) + 1 : 1;
      title = '';
      files = [];
      error = '';
      newProjectName = '';
    }
  });

  async function pickRaws() {
    const picked = await pickFilesTauri({
      name: 'Images',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
      multiple: true,
    });
    if (picked) files = [...picked];
  }

  async function submit() {
    error = '';
    if (!files.length) {
      error = 'Pick at least one raw page.';
      return;
    }
    if (target === '__new__' && !newProjectName.trim()) {
      error = 'Name the new project.';
      return;
    }
    busy = true;
    try {
      const pid =
        target === '__new__' ? (await createProject(newProjectName.trim())).id : target;
      const chapter = await createChapter({ projectId: pid, number: Number(number), title, files });
      open = false;
      toast(`Created chapter ${chapter.number} · ${files.length} pages copied`);
      goEditor(pid, chapter.id);
    } catch (e) {
      error = `Could not create the chapter — ${e?.message ?? e}`;
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && (open = false)}
  >
    <div class="modal dialog-narrow">
      <div class="modal-head">New chapter</div>

      <label class="field">
        <span>Project</span>
        <select bind:value={target}>
          {#each library.projects.filter((p) => !p.unreadable) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="__new__">New project…</option>
        </select>
      </label>

      {#if target === '__new__'}
        <label class="field">
          <span>Project name</span>
          <input bind:value={newProjectName} placeholder="Series name" />
        </label>
      {/if}

      <label class="field">
        <span>Chapter number</span>
        <input type="number" min="0" bind:value={number} />
      </label>

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Optional" />
      </label>

      <div class="field">
        <span>Raw pages</span>
        <button class="soft-btn" onclick={pickRaws}>
          {files.length ? `${files.length} selected — change` : 'Choose files…'}
        </button>
      </div>

      {#if error}<div class="home-error">{error}</div>{/if}

      <div class="modal-foot">
        <button class="soft-btn" onclick={() => (open = false)} disabled={busy}>Cancel</button>
        <button class="accent-btn narrow" onclick={submit} disabled={busy}>
          {busy ? 'Copying…' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}
```

- [ ] **Step 2: Add the dialog's styles**

Append to `src/styles.css`:

```css
/* ---------- new chapter dialog ---------- */
.dialog-narrow{ width:380px; max-width:92vw; }
.modal-head{ font-size:13px; font-weight:600; margin-bottom:18px; }
.field{ display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.field > span{ width:110px; flex:none; font-size:11.5px; color:var(--t2); }
.field input,.field select{
  flex:1; min-width:0; height:30px; padding:0 9px;
  border:1px solid var(--line2); border-radius:6px;
  background:var(--surface); color:var(--text); font-size:12px;
}
.modal-foot{ display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
.accent-btn.narrow{ width:auto; height:30px; padding:0 16px; font-size:12px; }
```

- [ ] **Step 3: Rewrite `App.svelte` to switch on the route**

Replace `src/App.svelte` entirely:

```svelte
<script>
  import TopBar from './lib/TopBar.svelte';
  import RawPanel from './lib/RawPanel.svelte';
  import Editor from './lib/Editor.svelte';
  import RightPanel from './lib/RightPanel.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import FontModal from './lib/FontModal.svelte';
  import SettingsModal from './lib/SettingsModal.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import Toast from './lib/Toast.svelte';
  import Resizer from './lib/Resizer.svelte';
  import HomeFrame from './lib/home/HomeFrame.svelte';
  import LibraryView from './lib/home/LibraryView.svelte';
  import ProjectView from './lib/home/ProjectView.svelte';
  import NewChapterDialog from './lib/home/NewChapterDialog.svelte';
  import { onMount } from 'svelte';
  import { app, deleteBox, deselect, nextPage, prevPage, setTool, closeBulk, toast } from './lib/store.svelte.js';
  import { restoreFonts } from './lib/fonts.js';
  import { checkSidecar } from './lib/sidecar.js';
  import { initTheme } from './lib/theme.svelte.js';
  import { initRoot, openChapter } from './lib/library.svelte.js';
  import { route, goBack } from './lib/route.svelte.js';

  let fontModalOpen = $state(false);
  let settingsOpen = $state(false);
  let newChapterOpen = $state(false);
  let newChapterProject = $state(null);

  onMount(async () => {
    initTheme();
    await initRoot();
    restoreFonts();
    // Probe the Python sidecar (only meaningful under Tauri; no-op in the browser).
    checkSidecar().then((h) => {
      if (h) toast(`Sidecar ready · ${h.device}`);
    });
  });

  // Hydrate the editor whenever the route lands on a chapter.
  $effect(() => {
    if (route.name !== 'editor') return;
    const { projectId, chapterId } = route;
    if (app.chapterRef?.chapterId === chapterId) return;
    openChapter(projectId, chapterId).catch((e) => {
      toast(`Could not open that chapter — ${e?.message ?? e}`);
      goBack();
    });
  });

  function openNewChapter(projectId = null) {
    newChapterProject = projectId;
    newChapterOpen = true;
  }

  function onKeydown(e) {
    const t = e.target;
    if (t instanceof Element && t.matches('input,textarea,select')) return;
    // ignore shortcuts while inline-editing a text box
    if (app.editingId) return;
    if (e.key === 'Escape') {
      if (newChapterOpen) return (newChapterOpen = false);
      if (app.exportOpen) return (app.exportOpen = false);
      if (app.bulk.active) return closeBulk();
      if (settingsOpen) return (settingsOpen = false);
      if (fontModalOpen) return (fontModalOpen = false);
      return deselect();
    }
    if (route.name !== 'editor') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId) {
      e.preventDefault();
      deleteBox(app.selectedId);
    }
    if (e.key === 'v' || e.key === 'V') setTool('place');
    if (e.key === 't' || e.key === 'T') setTool('text');
    if (e.key === 'ArrowRight' && !e.shiftKey) nextPage();
    if (e.key === 'ArrowLeft' && !e.shiftKey) prevPage();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if route.name === 'editor'}
  <div class="app">
    <TopBar onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />

    <div class="main">
      <!-- Raw reference: the original page alongside the one you're typesetting. -->
      <RawPanel />
      <Resizer side="left" />
      <Editor />
      <Resizer side="right" />
      <RightPanel />
    </div>

    <StatusBar />
  </div>
{:else}
  <HomeFrame onSettings={() => (settingsOpen = true)}>
    {#if route.name === 'project'}
      <ProjectView onNewChapter={openNewChapter} />
    {:else}
      <LibraryView onNewChapter={() => openNewChapter(null)} />
    {/if}
  </HomeFrame>
{/if}

<NewChapterDialog bind:open={newChapterOpen} projectId={newChapterProject} />
<FontModal bind:open={fontModalOpen} />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
```

- [ ] **Step 4: Add the Home control and chapter name to the top bar**

In `src/lib/TopBar.svelte`, add to the imports:

```js
  import { goProject } from './route.svelte.js';
  import { projectById, chapterById } from './library.svelte.js';
```

and add the derived label:

```js
  const label = $derived.by(() => {
    const ref = app.chapterRef;
    if (!ref) return 'Untitled';
    const p = projectById(ref.projectId);
    const c = chapterById(ref.projectId, ref.chapterId);
    if (!p || !c) return 'Untitled';
    return `${p.name} · ${c.title || 'Chapter ' + c.number}`;
  });
```

Replace the `.brand` block (lines 17–20) with:

```svelte
  <div class="brand">
    <button class="logo-btn" onclick={() => goProject(app.chapterRef?.projectId)} title="Back to the project">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 7.4 8 3l5.4 4.4" /><path d="M4.3 6.9v6.3h7.4V6.9" /></svg>
    </button>
    <div class="name">{label}</div>
  </div>
```

Then in `src/styles.css`, replace the `.brand .logo` rule with:

```css
.logo-btn{
  width:24px; height:24px; flex:none; display:grid; place-items:center;
  border:none; border-radius:6px; background:var(--accent-soft); color:var(--t2); cursor:pointer;
}
.logo-btn:hover{ color:var(--text); }
```

- [ ] **Step 5: Add the theme and library controls to Settings**

In `src/lib/SettingsModal.svelte`, add to the imports:

```js
  import { theme, setTheme } from './theme.svelte.js';
  import { library, setRoot, scanLibrary } from './library.svelte.js';
```

Add this handler alongside the existing ones:

```js
  async function chooseRoot() {
    const { open: pick } = await import('@tauri-apps/plugin-dialog');
    const dir = await pick({ directory: true, defaultPath: library.root });
    if (!dir) return;
    await setRoot(dir);
    await scanLibrary();
    toast('Library folder changed');
  }
```

Add this section as the first block inside the modal body, above the existing model-cache section:

```svelte
      <div class="settings-section">
        <div class="settings-title">Appearance</div>
        <div class="field">
          <span>Theme</span>
          <div class="seg">
            <button class:on={theme.mode === 'light'} onclick={() => setTheme('light')}>Light</button>
            <button class:on={theme.mode === 'dark'} onclick={() => setTheme('dark')}>Dark</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-title">Library</div>
        <div class="field">
          <span>Folder</span>
          <code class="path">{library.root}</code>
        </div>
        <button class="soft-btn" onclick={chooseRoot}>Change folder…</button>
      </div>
```

Then delete the hardcoded colour literals in that file's scoped `<style>` block — `#555b6b`, `#5fcf86`, `#e06f6f`, `#2b2f3a`, `#b9c0d0` and any others — replacing them with `var(--t3)`, `var(--text)`, `var(--warn)`, `var(--panel2)`, and `var(--t2)` respectively.

Append the new rules to `src/styles.css`:

```css
.settings-section{ margin-bottom:22px; }
.settings-title{ font-size:10.5px; letter-spacing:.22em; color:var(--t3); margin-bottom:12px; }
.seg{ display:flex; gap:3px; padding:3px; background:var(--panel2); border-radius:7px; }
.seg button{
  height:24px; padding:0 12px; border:none; border-radius:5px;
  background:transparent; color:var(--t2); font-size:11.5px; cursor:pointer;
}
.seg button.on{ background:var(--accent); color:var(--accent-fg); }
.path{
  flex:1; min-width:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px; color:var(--t2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
```

- [ ] **Step 6: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS — 31 tests.

- [ ] **Step 7: Verify the app end to end**

Run: `npm run tauri dev`

Walk this path and confirm each step:

1. The app opens on the library, not the editor.
2. **New chapter** → *New project…* → name it, pick a folder of real raws, Create.
3. The editor opens with those pages; the top bar shows `Project · Chapter 1`.
4. Place a text box, then click the Home control.
5. The project screen lists one chapter with the right page count.
6. Re-open the chapter — the text box is still there.
7. In a terminal, `cmp` one file in `<library>/<project>/<chapter>/raws/` against its source. Expect no difference.
8. Settings → Dark. Every screen (library, project, editor) flips with nothing left unthemed. Relaunch: still dark.
9. Delete the chapter, then the project. Confirm both folders are gone from disk.

- [ ] **Step 8: Commit**

```bash
git add src/App.svelte src/lib/TopBar.svelte src/lib/SettingsModal.svelte src/lib/home src/styles.css
git commit -m "feat: boot to the project library and route into the editor"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-08-12-ui-remake-slice1-design.md`:

- Every spec decision maps to a task: tokens and theming → Task 3; disk layout and scan → Task 5; raw copying → Task 6; store split and autosave → Task 7; screens → Task 8; routing, dialog, Settings → Task 9.
- The spec's "cover thumbnail" is generated in Task 6 and consumed in Task 8's `ProjectCard`.
- The spec's error-handling cases are covered: missing root (Task 5, `scanLibrary` creates it), corrupt JSON (Task 5, tested), copy failure rollback (Task 6, tested), save failure (Task 7, indicator stays lit), missing raws on open (Task 7, page keeps its typesetting with a null URL).
- The spec's "Continue" affordance on a card and the status chip are **not** implemented — there is no per-chapter progress model in slice 1 to drive them. Cards show name, chapter count, and page count. This is a deliberate reduction; if you want them, they need a progress field on `chapter.json` first.
- Names are consistent across tasks: `scanLibrary`, `createProject`, `createChapter`, `openChapter`, `saveOpenChapter`, `closeChapter`, `projectById`, `chapterById`, `setSaver`, `flushSave`, `setLeaveEditorHook`.
