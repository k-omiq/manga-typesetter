# Slice 2b — Editor Wireframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the editor's chrome to `docs/wireframe-editor.png` — a full-bleed canvas with floating chrome, a tool rail that doubles as the sidebar resizer, two draggable/resizable/hideable panels persisted per user, and a bounded five-step per-page undo/redo spilled to disk.

**Architecture:** The editor becomes one fixed-position root with five layers (canvas, sidebar, rail, chrome, panels). Panel geometry lives in a pure state module backed by `localStorage`. Undo/redo is a registry of plain-data command records, recorded through a `setRecorder` seam on the store — the same shape as the existing `setSaver` seam — and spilled per page to `<chapter>/logs/history.json`.

**Tech Stack:** Svelte 5 runes, Tauri 2, Vitest (node environment). No new dependencies.

Spec: `docs/superpowers/specs/2026-08-13-slice2b-editor-wireframe-design.md`. The wireframe is the authority above both.

## Global Constraints

- **Svelte 5 runes only.** No `svelte/store`, no `export let`, no `on:click`. Props via `$props()`, events via `onclick={...}`.
- **Every colour from a token.** No hex literals, no `rgba()` literals in component or stylesheet code outside the `:root` blocks that define the tokens themselves.
- **`--warn` is for warnings and destructive actions only.** In this slice it appears exactly once: the failed-save state on the project pill.
- **Both themes must work**, light and dark. Chrome drawn over the near-white `--paper` page surface uses `--tint`/`--tintline` (which do not invert); chrome drawn over the `--art` canvas backdrop uses the panel vocabulary (`--panel`, `--surface`, `--line2`, `--edge`) and does invert.
- **Style:** 2-space indent, single quotes, semicolons, trailing commas in multiline literals.
- **No new dependencies.** `package.json` must be unchanged at the end of this plan.
- **Typesetting must not regress.** Placing, moving, resizing, rotating, inline editing, bulk style, the queue, detection and export all keep working.
- Tests: `npm test` (Vitest, node environment, `src/**/*.test.js`). Build: `npm run build`. Rust: `cargo check` in `src-tauri`.
- Commit after every task. Commit messages are normal prose, not caveman.

---

### Task 1: Stable box ids across sessions

`chapter.json` persists `boxes[].id` but `loadProjectPages` discards it, so nothing may address a box by id across a relaunch. The history in Task 4 does exactly that, so this lands first.

**Files:**
- Modify: `src/lib/store.svelte.js` (`loadProjectPages`, lines 21–59)
- Create: `src/lib/store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadProjectPages(rawPages)` keeps each box's `id` when it is a non-empty string that has not already been taken in the same load; `boxSeq` is seeded past the highest `b<n>` in the document.

- [ ] **Step 1: Write the failing test**

Create `src/lib/store.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { app, loadProjectPages, addEmptyBox } from './store.svelte.js';

const pageWith = (boxes) => ({
  id: 1,
  w: 800,
  h: 1200,
  lines: [],
  boxes,
});
const box = (id, extra = {}) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, ...extra });

describe('loadProjectPages box identity', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('keeps ids that came off disk', () => {
    loadProjectPages([pageWith([box('b7'), box('b9')])]);
    expect(app.pages[0].boxes.map((b) => b.id)).toEqual(['b7', 'b9']);
  });

  it('mints a fresh id for a box that has none', () => {
    loadProjectPages([pageWith([box('b3'), box(undefined)])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b3');
    expect(ids[1]).toMatch(/^b\d+$/);
    expect(ids[1]).not.toBe('b3');
  });

  it('remints a duplicate id rather than loading two boxes that answer to it', () => {
    loadProjectPages([pageWith([box('b4'), box('b4')])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b4');
    expect(ids[1]).not.toBe('b4');
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints an id a kept box already owns, across pages', () => {
    loadProjectPages([
      { ...pageWith([box('b40')]), id: 1 },
      { ...pageWith([box(undefined)]), id: 2 },
    ]);
    const minted = app.pages[1].boxes[0].id;
    expect(minted).toBe('b41');
  });

  it('seeds the counter so a box added after the load cannot collide', () => {
    loadProjectPages([pageWith([box('b120')])]);
    const id = addEmptyBox(100, 100);
    expect(id).toBe('b121');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/store.test.js`
Expected: FAIL — every id comes back as `b1`, `b2`, … because the loader remints.

- [ ] **Step 3: Implement**

In `src/lib/store.svelte.js`, replace the body of `loadProjectPages` down to the `app.pages = ...` assignment:

```js
// Box ids are persisted in chapter.json and are addressed by the undo history
// across sessions, so a load keeps the id it was given. A fresh one is minted
// only when there is none, or when the file names one box twice — two boxes
// answering to one id would confuse selection, deletion and undo alike.
const idNum = (id) => (typeof id === 'string' && /^b\d+$/.test(id) ? Number(id.slice(1)) : 0);

export function loadProjectPages(rawPages) {
  const taken = new Set();
  for (const p of rawPages) {
    for (const b of p.boxes ?? []) {
      const n = idNum(b.id);
      if (n >= boxSeq) boxSeq = n + 1;
    }
  }
  app.pages = rawPages.map((p) => {
    const cp = {
      // ... unchanged fields ...
      boxes: (p.boxes ?? []).map((b) => {
        const keep = typeof b.id === 'string' && b.id !== '' && !taken.has(b.id);
        const id = keep ? b.id : 'b' + boxSeq++;
        taken.add(id);
        return {
          id,
          lineN: b.lineN,
          text: b.text ?? null,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          style: normalizeStyle(b.style),
        };
      }),
      activeLineN: null,
    };
    cp.activeLineN = firstUnplaced(cp);
    return cp;
  });
  // ... unchanged tail ...
}
```

Keep every other field of the mapped page exactly as it is today. Only the `boxes` mapping and the new pre-pass change.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including the existing 120.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.svelte.js src/lib/store.test.js
git commit -m "fix: keep persisted box ids when a chapter loads"
```

---

### Task 2: Floating panel geometry module

**Files:**
- Create: `src/lib/editor/panels.svelte.js`
- Create: `src/lib/editor/panels.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PANEL_IDS = ['options', 'queue']`
  - `panels` — `$state({ options: {x,y,w,h,hidden,z}, queue: {…} })`
  - `MIN_W = 220`, `MIN_H = 160`
  - `defaultGeometry(vw)` → `{ options, queue }`
  - `clampPanel(g, vw, vh)` → clamped `{x,y,w,h,hidden,z}`
  - `sanitize(stored, vw, vh)` → full geometry; per-panel fallback to defaults
  - `loadPanels(storage, vw, vh)`, `movePanel(id,x,y)`, `resizePanel(id,w,h)`, `setHidden(id,hidden)`, `raisePanel(id)`, `clampAll(vw,vh)`, `resetPanels(vw,vh)`, `serializePanels()`

- [ ] **Step 1: Write the failing test**

Create `src/lib/editor/panels.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
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

  it('has an id list the UI can iterate', () => {
    expect(PANEL_IDS).toEqual(['options', 'queue']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/editor/panels.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/editor/panels.svelte.js`:

```js
// ===== Floating panel geometry =====
// The two right-hand editor panels are windows, not columns: the user drags,
// resizes and hides them, and the layout they leave behind is theirs across
// relaunches. This module owns nothing but that geometry — no DOM, no pointer
// handling — so the rules that are easy to get wrong (a window that shrank
// between sessions, a corrupt preference) are testable without a browser.

export const PANEL_IDS = ['options', 'queue'];

export const MIN_W = 220;
export const MIN_H = 160;
const DEF_W = 320;
const GAP = 16;
// However far a panel is dragged, this much of it stays inside the window. It
// is the difference between a layout the user can undo by hand and one that
// needs the reset button.
const KEEP_X = 120;
const KEEP_Y = 32;

const KEY = 'mt.panels';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function defaultGeometry(vw) {
  const x = Math.max(GAP, vw - DEF_W - GAP);
  return {
    options: { x, y: 52, w: DEF_W, h: 420, hidden: false, z: 1 },
    queue: { x, y: 488, w: DEF_W, h: 360, hidden: false, z: 2 },
  };
}

export function clampPanel(g, vw, vh) {
  const w = clamp(num(g.w) ?? DEF_W, MIN_W, Math.max(MIN_W, vw - GAP));
  const h = clamp(num(g.h) ?? MIN_H, MIN_H, Math.max(MIN_H, vh - GAP));
  return {
    x: clamp(num(g.x) ?? 0, 0, Math.max(0, vw - KEEP_X)),
    y: clamp(num(g.y) ?? 0, 0, Math.max(0, vh - KEEP_Y)),
    w,
    h,
    hidden: g.hidden === true,
    z: num(g.z) ?? 1,
  };
}

// A stored layout is user data of the least important kind. Anything that does
// not parse, or does not carry the right types, is replaced by the default for
// that panel alone — a broken half never costs the good half.
export function sanitize(stored, vw, vh) {
  const defs = defaultGeometry(vw);
  let raw = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const out = {};
  for (const id of PANEL_IDS) {
    const g = raw && typeof raw === 'object' ? raw[id] : null;
    const usable =
      g &&
      typeof g === 'object' &&
      num(g.x) !== null &&
      num(g.y) !== null &&
      num(g.w) !== null &&
      num(g.h) !== null &&
      typeof g.hidden === 'boolean';
    out[id] = usable ? clampPanel(g, vw, vh) : { ...defs[id] };
  }
  return out;
}

export const panels = $state(defaultGeometry(1440));

let store = null;
let saveT = null;

function assign(next) {
  for (const id of PANEL_IDS) Object.assign(panels[id], next[id]);
}

export function loadPanels(storage, vw, vh) {
  store = storage;
  let stored = null;
  try {
    stored = storage?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  assign(sanitize(stored, vw, vh));
}

export function serializePanels() {
  const out = {};
  for (const id of PANEL_IDS) out[id] = { ...panels[id] };
  return JSON.stringify(out);
}

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      store?.setItem(KEY, serializePanels());
    } catch {
      /* a layout preference is not worth a message */
    }
  }, 200);
}

export function movePanel(id, x, y) {
  panels[id].x = x;
  panels[id].y = y;
  save();
}

export function resizePanel(id, w, h) {
  panels[id].w = Math.max(MIN_W, w);
  panels[id].h = Math.max(MIN_H, h);
  save();
}

export function setHidden(id, hidden) {
  panels[id].hidden = hidden;
  save();
}

// Clicking a panel brings it forward. Two panels only, so the z values stay
// small and never need normalising.
export function raisePanel(id) {
  const top = Math.max(...PANEL_IDS.map((p) => panels[p].z));
  if (panels[id].z === top) return;
  panels[id].z = top + 1;
  save();
}

export function clampAll(vw, vh) {
  for (const id of PANEL_IDS) Object.assign(panels[id], clampPanel(panels[id], vw, vh));
  save();
}

export function resetPanels(vw, vh) {
  assign(defaultGeometry(vw));
  clampAll(vw, vh);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/panels.svelte.js src/lib/editor/panels.test.js
git commit -m "feat: floating panel geometry, clamped and persisted"
```

---

### Task 3: The floating panel component

**Files:**
- Create: `src/lib/editor/FloatingPanel.svelte`
- Modify: `src/styles.css` (append a `/* ---------- floating panels ---------- */` block)

**Interfaces:**
- Consumes: `panels`, `movePanel`, `resizePanel`, `setHidden`, `raisePanel`, `MIN_W`, `MIN_H` from `./panels.svelte.js`.
- Produces: `<FloatingPanel id="options" title="Text box options" count={…}>{#snippet children()}…{/snippet}</FloatingPanel>`. Props: `id` (string, a `PANEL_IDS` member), `title` (string), `count` (string | null, a small right-aligned label in the header), `children` (snippet).

- [ ] **Step 1: Write the component**

Create `src/lib/editor/FloatingPanel.svelte`:

```svelte
<script>
  import { panels, movePanel, resizePanel, setHidden, raisePanel, MIN_W, MIN_H } from './panels.svelte.js';

  let { id, title, count = null, children } = $props();

  const g = $derived(panels[id]);

  function drag(e, kind) {
    if (e.button !== 0) return;
    e.preventDefault();
    raisePanel(id);
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === 'move') {
        // Clamped on drop rather than per-frame: clamping while the pointer is
        // down fights the cursor, and clampAll runs on every window resize
        // anyway, so nothing can be stranded.
        movePanel(id, o.x + dx, o.y + dy);
      } else {
        resizePanel(id, Math.max(MIN_W, o.w + dx), Math.max(MIN_H, o.h + dy));
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
</script>

{#if g.hidden}
  <button
    class="panel-stub"
    style="left:{g.x}px; top:{g.y}px; z-index:{g.z}"
    onclick={() => { setHidden(id, false); raisePanel(id); }}
    title="Show {title}"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6" /></svg>
    {title}
  </button>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="fpanel"
    style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px; z-index:{g.z}"
    onpointerdown={() => raisePanel(id)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="fpanel-head" onpointerdown={(e) => drag(e, 'move')}>
      <span class="fpanel-title">{title}</span>
      {#if count}<span class="fpanel-count">{count}</span>{/if}
      <button class="fpanel-hide" onclick={() => setHidden(id, true)} title="Hide {title}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </header>
    <div class="fpanel-body">{@render children()}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fpanel-grip" onpointerdown={(e) => drag(e, 'resize')}></div>
  </section>
{/if}
```

- [ ] **Step 2: Style it**

Append to `src/styles.css`. Every colour is a token; the panels sit over `--art`, so they use the panel vocabulary.

```css
/* ---------- floating panels ---------- */
.fpanel{
  position:fixed; display:flex; flex-direction:column; min-height:0;
  background:var(--panel); border:1px solid var(--line2); border-radius:var(--radius);
  box-shadow:var(--edge); overflow:hidden;
}
.fpanel-head{
  flex:0 0 auto; height:32px; display:flex; align-items:center; gap:8px; padding:0 6px 0 12px;
  border-bottom:1px solid var(--line); cursor:grab; user-select:none;
  font-size:11px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; color:var(--t2);
}
.fpanel-head:active{ cursor:grabbing; }
.fpanel-title{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fpanel-count{
  margin-left:auto; font-size:11px; font-weight:500; letter-spacing:0; text-transform:none;
  color:var(--t2); background:var(--surface); border:1px solid var(--line); padding:1px 7px; border-radius:10px;
}
.fpanel-hide{
  margin-left:auto; width:24px; height:24px; border:none; background:transparent; color:var(--t2);
  border-radius:5px; cursor:pointer; display:grid; place-items:center; flex:0 0 auto;
}
.fpanel-count + .fpanel-hide{ margin-left:0; }
.fpanel-hide:hover{ background:var(--panel2); color:var(--text); }
.fpanel-hide svg{ width:15px; height:15px; }
.fpanel-body{ flex:1 1 auto; min-height:0; overflow:auto; }
.fpanel-grip{ position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize; }
.fpanel-grip::after{
  content:""; position:absolute; right:3px; bottom:3px; width:8px; height:8px;
  border-right:1.5px solid var(--t3); border-bottom:1.5px solid var(--t3);
}
.panel-stub{
  position:fixed; display:flex; align-items:center; gap:7px; height:30px; padding:0 12px;
  background:var(--panel); border:1px solid var(--line2); border-radius:15px; box-shadow:var(--edge);
  color:var(--t2); font-size:11px; font-weight:600; letter-spacing:.4px; text-transform:uppercase;
  cursor:pointer; white-space:nowrap;
  animation:stub-in .18s ease-out;
}
.panel-stub:hover{ color:var(--text); border-color:var(--t3); }
.panel-stub svg{ width:14px; height:14px; }
@keyframes stub-in{ from{ transform:scale(.9); opacity:0 } to{ transform:scale(1); opacity:1 } }
@media (prefers-reduced-motion: reduce){ .panel-stub{ animation:none } }
```

- [ ] **Step 3: Prove it compiles**

Run: `npm run build`
Expected: clean. (The component is not mounted yet; the build is the check that the Svelte 5 syntax is right.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/editor/FloatingPanel.svelte src/styles.css
git commit -m "feat: draggable, resizable, hideable floating panel"
```

---

### Task 4: Undo/redo core

**Files:**
- Modify: `src/lib/store.svelte.js` (add the recorder seam and `pageById`)
- Create: `src/lib/editor/history.svelte.js`
- Create: `src/lib/editor/history.test.js`

**Interfaces:**
- Consumes: `app`, `page`, `markUnsaved`, `toast`, `selectBox`, `cloneStyle` from `../store.svelte.js`; `setRecorder` (new).
- Produces:
  - store: `export function setRecorder(fn)`, `export function pageById(id)`, and `recordEdit(entry)` called at every mutation site.
  - history: `MAX_STEPS = 5`, `history` (`$state({ canUndo, canRedo, pageId })`), `record(entry)`, `undo()`, `redo()`, `loadStack(pageId, stack)`, `takeStack()`, `peekStack()`, `setHistorySink(fn)`, `resetHistory()`, `initHistory()`.

- [ ] **Step 1: Add the recorder seam to the store**

In `src/lib/store.svelte.js`, beside `setSaver`:

```js
// ---------- edit recorder (undo/redo) ----------
// The store stays unaware of the history the same way it stays unaware of the
// filesystem: the history module registers itself, and a build with no history
// records nothing and behaves exactly as before.
let recorder = null;
export function setRecorder(fn) {
  recorder = fn;
}
export function recordEdit(entry) {
  if (recorder) recorder(entry);
}
export const pageById = (id) => app.pages.find((p) => p.id === id) ?? null;
```

Then record at each mutation site. `$state.snapshot` everywhere a stored value could be a proxy:

- `placeActiveAt`, after `p.boxes.push(b)`:
  ```js
  recordEdit({ t: 'place', pageId: p.id, index: p.boxes.length - 1, box: $state.snapshot(b) });
  ```
- `addEmptyBox`, after `p.boxes.push(b)`: the same, with the box it just pushed.
- `deleteBox`, capturing before the filter:
  ```js
  const index = p.boxes.findIndex((x) => x.id === id);
  const snap = $state.snapshot(b);
  // … existing removal …
  recordEdit({ t: 'delete', pageId: p.id, index, box: snap });
  ```
- `applyBulk`, collecting per-box before/after inside the loop:
  ```js
  const items = [];
  for (const id of app.bulk.targets) {
    const b = p.boxes.find((x) => x.id === id);
    if (b) {
      items.push({ boxId: id, before: cloneStyle(b.style), after: cloneStyle(app.bulk.style) });
      b.style = cloneStyle(app.bulk.style);
      n++;
    }
  }
  if (items.length) recordEdit({ t: 'bulk', pageId: p.id, items });
  ```
- `endEdit`, when `commitText` differs from what was there — the caller passes the before value:
  ```js
  export function endEdit(commitText, beforeText) {
    // … existing …
    if (commitText != null && commitText !== beforeText) {
      recordEdit({ t: 'text', pageId: page().id, boxId: id, before: beforeText ?? null, after: commitText });
    }
  }
  ```
  `beforeText` is optional; when it is `undefined` nothing is recorded, so existing callers keep working until Task 6 updates them.

Move and resize are recorded from `TextBox.svelte` in Task 6, because only the component knows when a drag ends. Inspector style edits are recorded in Task 6 for the same reason.

- [ ] **Step 2: Write the failing test**

Create `src/lib/editor/history.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { app, loadProjectPages, deleteBox, placeActiveAt, page } from '../store.svelte.js';
import { history, record, undo, redo, resetHistory, initHistory, MAX_STEPS, takeStack, loadStack } from './history.svelte.js';

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }],
    boxes: [
      { id: 'b1', lineN: null, text: 'one', x: 10, y: 10, w: 100, h: 40, style: null },
      { id: 'b2', lineN: null, text: 'two', x: 50, y: 50, w: 100, h: 40, style: null },
    ],
  },
];

beforeEach(() => {
  initHistory();
  resetHistory();
  loadProjectPages(doc());
});

describe('command records', () => {
  it('undoes a move and redoes it', () => {
    const b = page().boxes[0];
    b.x = 200;
    b.y = 300;
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 10, y: 10 }, after: { x: 200, y: 300 } });
    undo();
    expect(page().boxes[0].x).toBe(10);
    redo();
    expect(page().boxes[0].x).toBe(200);
  });

  it('undoes a resize', () => {
    record({
      t: 'resize',
      pageId: 1,
      boxId: 'b1',
      before: { x: 10, y: 10, w: 100, h: 40, size: 20 },
      after: { x: 12, y: 12, w: 260, h: 90, size: 40 },
    });
    undo();
    const b = page().boxes[0];
    expect([b.w, b.h]).toEqual([100, 40]);
  });

  it('undoes a delete back into its old position in the stack', () => {
    deleteBox('b1');
    expect(page().boxes.map((b) => b.id)).toEqual(['b2']);
    undo();
    expect(page().boxes.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('undoes a place by removing the box', () => {
    page().activeLineN = 1;
    placeActiveAt(400, 400);
    expect(page().boxes.length).toBe(3);
    undo();
    expect(page().boxes.length).toBe(2);
  });

  it('undoes a bulk apply as one step', () => {
    record({
      t: 'bulk',
      pageId: 1,
      items: [
        { boxId: 'b1', before: { size: 10 }, after: { size: 30 } },
        { boxId: 'b2', before: { size: 12 }, after: { size: 30 } },
      ],
    });
    undo();
    expect(page().boxes[0].style.size).toBe(10);
    expect(page().boxes[1].style.size).toBe(12);
    expect(history.canUndo).toBe(false);
  });

  it('undoes a text edit', () => {
    page().boxes[0].text = 'changed';
    record({ t: 'text', pageId: 1, boxId: 'b1', before: 'one', after: 'changed' });
    undo();
    expect(page().boxes[0].text).toBe('one');
  });
});

describe('bounds', () => {
  const move = (n) => record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: n, y: 0 }, after: { x: n + 1, y: 0 } });

  it('holds five and drops the oldest at six', () => {
    for (let i = 0; i < MAX_STEPS + 1; i++) move(i);
    let count = 0;
    while (history.canUndo) {
      undo();
      count++;
    }
    expect(count).toBe(MAX_STEPS);
    // the oldest was dropped, so the earliest state reachable is the second move's
    expect(page().boxes[0].x).toBe(1);
  });

  it('a new record clears redo', () => {
    move(0);
    undo();
    expect(history.canRedo).toBe(true);
    move(9);
    expect(history.canRedo).toBe(false);
  });
});

describe('failure', () => {
  it('refuses an entry whose box is gone, drops it, and carries on', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    record({ t: 'move', pageId: 1, boxId: 'ghost', before: { x: 0, y: 0 }, after: { x: 9, y: 9 } });
    undo(); // the ghost — refused and dropped
    expect(app.toast.msg).toMatch(/gone/i);
    expect(history.canUndo).toBe(true);
    undo(); // the real one still works
    expect(page().boxes[0].x).toBe(0);
  });

  it('refuses an entry for a page that is gone', () => {
    record({ t: 'move', pageId: 99, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    undo();
    expect(history.canUndo).toBe(false);
    expect(app.toast.msg).toMatch(/gone/i);
  });
});

describe('per-page stacks', () => {
  it('hands its stack over and takes another back', () => {
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 5, y: 5 } });
    const out = takeStack();
    expect(out.undo.length).toBe(1);
    expect(history.canUndo).toBe(false);
    loadStack(1, out);
    expect(history.canUndo).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/lib/editor/history.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement**

Create `src/lib/editor/history.svelte.js`:

```js
// ===== Bounded undo/redo =====
// Five steps, per page, as command records rather than document snapshots: an
// entry is plain data describing one edit and its inverse, so it costs tens of
// bytes and serialises to JSON without ceremony. Only the page on screen keeps
// its stack in memory; every other page's lives in the chapter's history file
// (see history-file.svelte.js).
import {
  app,
  page,
  pageById,
  markUnsaved,
  toast,
  selectBox,
  setRecorder,
  cloneStyle,
} from '../store.svelte.js';

export const MAX_STEPS = 5;

export const history = $state({ canUndo: false, canRedo: false, pageId: null });

let undoStack = [];
let redoStack = [];
// While an entry is being applied the store's mutations must not be recorded —
// an undo is not an edit.
let applying = false;

function sync() {
  history.canUndo = undoStack.length > 0;
  history.canRedo = redoStack.length > 0;
}

const boxOf = (entry) => {
  const p = pageById(entry.pageId);
  if (!p) return null;
  return p.boxes.find((b) => b.id === entry.boxId) ?? null;
};

const setFields = (b, from) => {
  for (const k of Object.keys(from)) {
    if (k === 'size') b.style.size = from.size;
    else b[k] = from[k];
  }
};

// Every command type, and how to walk it in each direction. `apply` throws a
// plain Error when the document no longer matches; the caller turns that into
// a message and drops the entry.
const KINDS = {
  place: {
    label: 'that placement',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
      } else {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
      }
    },
  },
  delete: {
    label: 'that deletion',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      if (dir === 'undo') {
        if (p.boxes.some((b) => b.id === e.box.id)) throw new Error('the text box is back already');
        p.boxes.splice(Math.min(e.index, p.boxes.length), 0, structuredClone(e.box));
      } else {
        const i = p.boxes.findIndex((b) => b.id === e.box.id);
        if (i === -1) throw new Error('the text box is gone');
        p.boxes.splice(i, 1);
      }
    },
  },
  move: {
    label: 'that move',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');
      setFields(b, dir === 'undo' ? e.before : e.after);
    },
  },
  resize: {
    label: 'that resize',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');
      setFields(b, dir === 'undo' ? e.before : e.after);
    },
  },
  style: {
    label: 'that style change',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');
      b.style = cloneStyle(dir === 'undo' ? e.before : e.after);
    },
  },
  text: {
    label: 'that text edit',
    apply(e, dir) {
      const b = boxOf(e);
      if (!b) throw new Error(pageById(e.pageId) ? 'the text box is gone' : 'the page is gone');
      b.text = dir === 'undo' ? e.before : e.after;
    },
  },
  bulk: {
    label: 'that bulk style',
    apply(e, dir) {
      const p = pageById(e.pageId);
      if (!p) throw new Error('the page is gone');
      let hit = 0;
      for (const item of e.items) {
        const b = p.boxes.find((x) => x.id === item.boxId);
        if (!b) continue;
        b.style = cloneStyle(dir === 'undo' ? item.before : item.after);
        hit++;
      }
      // A bulk that touched five boxes is still worth undoing when one has
      // since been deleted; it is only a failure when none of them are left.
      if (!hit) throw new Error('those text boxes are gone');
    },
  },
};

// The history file registers itself here so a new entry can schedule its own
// write. Without it the live page's stack would only reach disk on a page
// switch, and an edit made and then abandoned would be lost on quit.
let sink = null;
export function setHistorySink(fn) {
  sink = fn;
}

export function record(entry) {
  if (applying) return;
  if (!KINDS[entry.t]) return;
  undoStack.push(entry);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack = [];
  history.pageId = entry.pageId;
  sync();
  sink?.(entry.pageId);
}

function step(from, to, dir) {
  while (from.length) {
    const entry = from.pop();
    try {
      applying = true;
      KINDS[entry.t].apply(entry, dir);
      applying = false;
    } catch (err) {
      applying = false;
      // Replay and fail loudly: the entry is dropped, the user is told what it
      // was, and the stack carries on to whatever is still valid beneath it.
      toast(`Could not ${dir} ${KINDS[entry.t].label} — ${err.message}`);
      sync();
      return false;
    }
    to.push(entry);
    if (entry.boxId && pageById(entry.pageId)?.boxes.some((b) => b.id === entry.boxId)) {
      selectBox(entry.boxId);
    }
    markUnsaved();
    sync();
    return true;
  }
  return false;
}

export const undo = () => step(undoStack, redoStack, 'undo');
export const redo = () => step(redoStack, undoStack, 'redo');

// A copy of the live stack, for a write that must not disturb it.
export function peekStack() {
  return { undo: undoStack.slice(), redo: redoStack.slice() };
}

// The live page hands its stack over on a page switch and takes another back.
export function takeStack() {
  const out = { undo: undoStack, redo: redoStack };
  undoStack = [];
  redoStack = [];
  sync();
  return out;
}

export function loadStack(pageId, stack) {
  undoStack = Array.isArray(stack?.undo) ? stack.undo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS) : [];
  redoStack = Array.isArray(stack?.redo) ? stack.redo.filter((e) => KINDS[e?.t]).slice(-MAX_STEPS) : [];
  history.pageId = pageId;
  sync();
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
  history.pageId = null;
  sync();
}

// Registered once, at boot. Idempotent.
export function initHistory() {
  setRecorder(record);
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.svelte.js src/lib/editor/history.svelte.js src/lib/editor/history.test.js
git commit -m "feat: bounded five-step undo/redo as command records"
```

---

### Task 5: Spilling history to the chapter's log file

**Files:**
- Create: `src/lib/editor/history-file.svelte.js`
- Create: `src/lib/editor/history-file.test.js`
- Modify: `src/lib/library.svelte.js` (export the open chapter's directory)

**Interfaces:**
- Consumes: `fsx` from `../fsx.js`; `takeStack`, `loadStack`, `resetHistory` from `./history.svelte.js`; `app`, `toast` from `../store.svelte.js`; `chapterById` from `../library.svelte.js`.
- Produces: `openHistory(chapterDir, pageId)`, `switchHistoryPage(fromPageId, toPageId)`, `closeHistory(pageId)`, `flushHistory()`, `__setDir(dir)` (test seam), and the pure helpers `emptyDoc()`, `mergeStack(doc, pageId, stack)`, `stackFrom(doc, pageId)`.

File shape:

```json
{ "version": 1, "pages": { "3": { "undo": [ … ], "redo": [ … ] } } }
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/editor/history-file.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeStack, stackFrom, emptyDoc } from './history-file.svelte.js';

describe('the history document', () => {
  it('starts empty and versioned', () => {
    expect(emptyDoc()).toEqual({ version: 1, pages: {} });
  });

  it('stores a page stack under its id as a string key', () => {
    const doc = mergeStack(emptyDoc(), 3, { undo: [{ t: 'move' }], redo: [] });
    expect(Object.keys(doc.pages)).toEqual(['3']);
    expect(doc.pages['3'].undo.length).toBe(1);
  });

  it('drops a page whose stack is empty rather than growing the file forever', () => {
    let doc = mergeStack(emptyDoc(), 3, { undo: [{ t: 'move' }], redo: [] });
    doc = mergeStack(doc, 3, { undo: [], redo: [] });
    expect(doc.pages['3']).toBeUndefined();
  });

  it('reads a stack back, and an unknown page reads as empty', () => {
    const doc = mergeStack(emptyDoc(), 7, { undo: [{ t: 'move' }], redo: [{ t: 'text' }] });
    expect(stackFrom(doc, 7).undo.length).toBe(1);
    expect(stackFrom(doc, 8)).toEqual({ undo: [], redo: [] });
  });

  it('treats a corrupt document as empty', () => {
    expect(stackFrom(null, 1)).toEqual({ undo: [], redo: [] });
    expect(stackFrom({ version: 99 }, 1)).toEqual({ undo: [], redo: [] });
  });
});
```

Then, in the same file, the filesystem half against a mocked `fsx`:

```js
vi.mock('../fsx.js', () => {
  const files = new Map();
  return {
    files,
    fsx: {
      join: async (...p) => p.join('/'),
      mkdir: async () => {},
      exists: async (p) => files.has(p),
      readTextFile: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      writeTextFileAtomic: async (p, c) => void files.set(p, c),
    },
  };
});

describe('the file on disk', () => {
  beforeEach(async () => {
    const { files } = await import('../fsx.js');
    files.clear();
  });

  it('writes what it was given and reads it back', async () => {
    const { __setDir, switchHistoryPage, flushHistory, openHistory } = await import('./history-file.svelte.js');
    const { record, loadStack, history } = await import('./history.svelte.js');
    __setDir('/lib/proj/ch1');
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 1, y: 1 } });
    await switchHistoryPage(1, 2);
    expect(history.canUndo).toBe(false);
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
    await flushHistory();
    const { files } = await import('../fsx.js');
    expect(files.has('/lib/proj/ch1/logs/history.json')).toBe(true);
  });

  it('survives a disk that refuses', async () => {
    const { fsx } = await import('../fsx.js');
    const boom = vi.spyOn(fsx, 'writeTextFileAtomic').mockRejectedValue(new Error('read-only'));
    const { __setDir, flushHistory } = await import('./history-file.svelte.js');
    __setDir('/lib/proj/ch1');
    await expect(flushHistory()).resolves.toBeUndefined();
    boom.mockRestore();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/editor/history-file.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/editor/history-file.svelte.js`:

```js
// ===== The history file =====
// Only the page on screen keeps its undo stack in memory. Every other page's
// lives here, in the chapter's own directory, so a chapter with two hundred
// pages costs five entries of RAM rather than a thousand — and so undo survives
// a relaunch.
//
// History is a convenience. Nothing in this module may be able to fail an edit,
// a save or a page turn: every disk error is reported once and swallowed.
import { fsx } from '../fsx.js';
import { toast } from '../store.svelte.js';
import { takeStack, peekStack, loadStack, resetHistory, setHistorySink } from './history.svelte.js';

export const emptyDoc = () => ({ version: 1, pages: {} });

export function mergeStack(doc, pageId, stack) {
  const next = doc && doc.version === 1 && doc.pages ? { ...doc, pages: { ...doc.pages } } : emptyDoc();
  const key = String(pageId);
  const undo = stack?.undo ?? [];
  const redo = stack?.redo ?? [];
  if (!undo.length && !redo.length) delete next.pages[key];
  else next.pages[key] = { undo, redo };
  return next;
}

export function stackFrom(doc, pageId) {
  if (!doc || doc.version !== 1 || !doc.pages) return { undo: [], redo: [] };
  const s = doc.pages[String(pageId)];
  return { undo: s?.undo ?? [], redo: s?.redo ?? [] };
}

let dir = null;
let doc = emptyDoc();
let saveT = null;
let told = false;
// The id of the page whose stack is live in memory. Every write merges it in
// first, so an edit reaches disk on its own debounce rather than waiting for a
// page switch that may never come.
let livePageId = null;

setHistorySink((pageId) => {
  livePageId = pageId;
  schedule();
});

// Test seam. The app reaches this through openHistory.
export function __setDir(d) {
  dir = d;
  doc = emptyDoc();
  told = false;
}

async function filePath() {
  const logs = await fsx.join(dir, 'logs');
  return { logs, file: await fsx.join(logs, 'history.json') };
}

function complainOnce(e) {
  if (told) return;
  told = true;
  toast(`Undo history is not being saved — ${e?.message ?? e}`);
}

export async function openHistory(chapterDir, pageId) {
  dir = chapterDir;
  doc = emptyDoc();
  told = false;
  livePageId = pageId;
  resetHistory();
  if (!dir) return;
  try {
    const { file } = await filePath();
    if (await fsx.exists(file)) {
      const parsed = JSON.parse(await fsx.readTextFile(file));
      if (parsed && parsed.version === 1 && parsed.pages) doc = parsed;
    }
  } catch {
    // A corrupt or unreadable history file costs undo and nothing else. It is
    // replaced by the next write.
    doc = emptyDoc();
  }
  loadStack(pageId, stackFrom(doc, pageId));
}

export async function switchHistoryPage(fromPageId, toPageId) {
  if (fromPageId != null) doc = mergeStack(doc, fromPageId, takeStack());
  loadStack(toPageId, stackFrom(doc, toPageId));
  livePageId = toPageId;
  schedule();
}

function schedule() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    flushHistory();
  }, 800);
}

export async function flushHistory() {
  clearTimeout(saveT);
  if (!dir) return;
  // The live page's stack is only in memory until this point.
  if (livePageId != null) doc = mergeStack(doc, livePageId, peekStack());
  try {
    const { logs, file } = await filePath();
    await fsx.mkdir(logs);
    await fsx.writeTextFileAtomic(file, JSON.stringify(doc));
  } catch (e) {
    complainOnce(e);
  }
}

export async function closeHistory(pageId) {
  if (pageId != null) doc = mergeStack(doc, pageId, takeStack());
  livePageId = null;
  await flushHistory();
  dir = null;
  doc = emptyDoc();
  resetHistory();
}
```

In `src/lib/library.svelte.js`, export a way to reach the open chapter's directory (there is already `chapterById`; add this beside it if it does not exist):

```js
export function openChapterDir() {
  const ref = app.chapterRef;
  if (!ref) return null;
  return chapterById(ref.projectId, ref.chapterId)?.dir ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/history-file.svelte.js src/lib/editor/history-file.test.js src/lib/library.svelte.js
git commit -m "feat: spill per-page undo history to the chapter's log file"
```

---

### Task 6: Wire the history into the editing surfaces

**Files:**
- Modify: `src/lib/TextBox.svelte` (move, resize, inline text)
- Modify: `src/lib/Inspector.svelte` (style edits)
- Modify: `src/lib/store.svelte.js` (`gotoPage` hook, `closeChapter` hook via library)
- Modify: `src/lib/library.svelte.js` (`openChapter` opens the history; `closeChapter` closes it)
- Modify: `src/App.svelte` (keyboard shortcuts, `initHistory()` at boot)

**Interfaces:**
- Consumes: `record` from `./editor/history.svelte.js`, `openHistory`, `switchHistoryPage`, `closeHistory` from `./editor/history-file.svelte.js`.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Record moves and resizes in `TextBox.svelte`**

In `startMove`, capture before the drag and record on pointer-up:

```js
const before = { x: box.x, y: box.y };
// … existing move handler …
const up = () => {
  // … existing teardown …
  if (box.x !== before.x || box.y !== before.y) {
    record({ t: 'move', pageId: page().id, boxId: box.id, before, after: { x: box.x, y: box.y } });
  }
};
```

In `startTransform`, the same shape with the five fields the transform touches:

```js
const before = { x: box.x, y: box.y, w: box.w, h: box.h, size: s.size };
// … existing transform handler …
const up = () => {
  // … existing teardown …
  const after = { x: box.x, y: box.y, w: box.w, h: box.h, size: box.style.size };
  if (Object.keys(after).some((k) => after[k] !== before[k])) {
    record({ t: 'resize', pageId: page().id, boxId: box.id, before, after });
  }
};
```

Inline editing: capture the text when the edit begins and hand it to `endEdit` as the second argument, so `endEdit` records one entry per session rather than one per keystroke.

- [ ] **Step 2: Record style edits in `Inspector.svelte`**

`touch()` runs after every style change, including each drag of a range input, so it must coalesce. Capture the style when the control is first touched and record when it settles:

```js
let pending = null;
function touch() {
  if (!pending && box) pending = { boxId: box.id, before: cloneStyle(box.style) };
  markUnsaved();
  rememberStyle(box);
  clearTimeout(settleT);
  settleT = setTimeout(commitStyle, 400);
}
function commitStyle() {
  if (!pending || !box || box.id !== pending.boxId) return (pending = null);
  const after = cloneStyle(box.style);
  if (JSON.stringify(after) !== JSON.stringify(pending.before)) {
    record({ t: 'style', pageId: page().id, boxId: box.id, before: pending.before, after });
  }
  pending = null;
}
```

400ms after the last change is one step per adjustment, not one per pixel of a slider.

- [ ] **Step 3: Hook the page switch and the chapter lifecycle**

`gotoPage` in the store must not import the history (the store stays a leaf). Instead, add a page-switch listener seam beside `setRecorder`:

```js
let pageSwitchHook = null;
export function setPageSwitchHook(fn) {
  pageSwitchHook = fn;
}
```

and call it inside `gotoPage` after the index moves:

```js
export function gotoPage(i) {
  if (i < 0 || i > app.pages.length - 1) return;
  const from = page().id;
  app.pageIndex = i;
  app.selectedId = null;
  const p = page();
  if (p.activeLineN == null) p.activeLineN = firstUnplaced(p);
  if (pageSwitchHook) pageSwitchHook(from, p.id);
}
```

In `src/lib/library.svelte.js`: `openChapter` calls `openHistory(c.dir, app.pages[0]?.id ?? null)` after the pages are hydrated; `closeChapter` calls `closeHistory(page().id)` before it clears `app.pages`; `flushBeforeLeaving` awaits `flushHistory()` alongside the document save, and never fails the leave because of it.

- [ ] **Step 4: Shortcuts and boot in `App.svelte`**

In `onMount`, after `initTheme()`:

```js
initHistory();
setPageSwitchHook(switchHistoryPage);
```

In `onKeydown`, before the existing single-letter tool shortcuts (which must not fire while a modifier is held):

```js
const mod = e.metaKey || e.ctrlKey;
if (mod && (e.key === 'z' || e.key === 'Z')) {
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
  return;
}
if (mod && (e.key === 'y' || e.key === 'Y')) {
  e.preventDefault();
  redo();
  return;
}
```

The existing guards already return early for inputs, textareas and inline box edits, so the browser's own text undo inside a field is untouched.

- [ ] **Step 5: Verify by hand in the running app**

Run: `npm run tauri dev`
Open a chapter, place a box, move it, resize it, restyle it, delete it, undo each one, redo each one. Make six edits and confirm the sixth undo is unavailable. Switch pages and back; confirm the stack came with the page.

- [ ] **Step 6: Run the tests and commit**

```bash
npm test && npm run build
git add -A
git commit -m "feat: record canvas edits into the undo history"
```

---

### Task 7: Chrome pills, the detect menu, and the format select's new home

**Files:**
- Create: `src/lib/editor/ChromePills.svelte`
- Create: `src/lib/editor/DetectMenu.svelte`
- Modify: `src/lib/ExportDialog.svelte` (gains the format select)
- Modify: `src/styles.css` (a `/* ---------- floating chrome ---------- */` block)

**Interfaces:**
- Consumes: `app`, `goProject`/`goLibrary`, `projectById`/`chapterById`, `sidecarReady`, `detectCurrentPage`, `detectAllPages`, `buildTextJson` (via a new `saveDetectionJson` in `src/lib/exporter.js`).
- Produces: `<ChromePills onFontLib={…} onSettings={…} />`.

- [ ] **Step 1: Build the pills**

`ChromePills.svelte` renders four groups, all `position: fixed`:

- `.pill-row.left` at `top:12px; left:16px` — the Home pill (house glyph, `goHome`, keeping `TopBar.svelte`'s `leaving` single-flight guard verbatim) and the project pill (`{project} · {chapter}` from `projectById`/`chapterById`, plus the save dot).
- `.pill-row.canvas-right` at `top:12px; right:calc(var(--panel-col) + 24px)` — the detect icon button and the export pill.
- `.pill-row.far-right` at `top:12px; right:16px` — font library and settings icon buttons.

The save dot has three states and is the only `--warn` in the editor:

```svelte
<span class="save-dot" class:saved={app.saved} class:failed={app.saveFailed} title={saveTitle}></span>
```

`app.saveFailed` is a new store field, set true when the autosave rejects and false when a write lands. Set it in the two places `src/lib/store.svelte.js` and `src/lib/library.svelte.js` already handle that: the `.catch` in `markUnsaved`'s debounce, and `saveOpenChapter`'s `saveFailures = 0` line.

- [ ] **Step 2: Build the detect menu**

`DetectMenu.svelte` is a small popover anchored under the detect pill, closed on Escape, on outside pointerdown, and on choosing an item:

```
This page            detectCurrentPage()
Whole chapter        detectAllPages()
─────────────────
Save detection JSON… saveDetectionJson(scope)
```

The first two are disabled unless `sidecarReady() && !app.detecting`. The third is disabled unless some page in scope carries `detect`.

There must be exactly one writer for that JSON. `exportImages` already contains the whole JSON branch inline (`src/lib/exporter.js:507-523`). Lift it out verbatim into an exported function and have `exportImages` call it, so the detect menu and the export dialog run identical code:

```js
// The detected/typeset text for a scope: one document, not one file per page,
// and the same document the export dialog's JSON format produces.
export async function exportTextJson(scope) {
  const pages = scope === 'all' ? app.pages : [page()];
  const suffix = scope === 'all' ? 'text' : `${pages[0].id}-text`;
  const items = [
    {
      name: `${app.exportName}-${suffix}.json`,
      blob: new Blob([buildTextJson(pages)], { type: MIME.JSON }),
      page: pages[0],
    },
  ];
  if (isTauri()) {
    // Always the single-file save dialog — 'all' is still one document.
    await saveNative(items, 'current', 'JSON');
  } else {
    downloadBlob(items[0].blob, items[0].name);
    toast(`Exported text for ${pages.length} page(s) as JSON (browser download)`);
  }
  return true;
}
```

and in `exportImages`, the branch becomes:

```js
if (fmt === 'JSON') return await exportTextJson(scope);
```

`exportTextJson` needs `app.exporting` set the way `exportImages` sets it, so the detect menu wraps its call the same way:

```js
app.exporting = true;
try {
  await exportTextJson(scope);
} finally {
  app.exporting = false;
}
```

- [ ] **Step 3: Move the format select into the export dialog**

Delete the `.export-combo` markup from the top bar's future replacement (the top bar itself goes in Task 10). In `ExportDialog.svelte`, add above the file-name group:

```svelte
<div class="grp">
  <label class="lbl" for="exp-fmt">Format</label>
  <select id="exp-fmt" bind:value={app.fmt}>
    <option>PNG</option><option>JPG</option><option>WebP</option><option>PSD</option><option>JSON</option>
  </select>
</div>
```

- [ ] **Step 4: Style**

Add the chrome block to `src/styles.css`. Pills sit over `--art`: `background:var(--panel); border:1px solid var(--line2); border-radius:16px; box-shadow:var(--edge); height:32px`. The save dot: `background:var(--t3)` unsaved, `var(--text)` saved, `var(--warn)` failed. Define `--panel-col:352px` and `--chrome-top:52px` in both `:root` blocks.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm test
git add -A
git commit -m "feat: floating chrome pills, detect menu, export format in the dialog"
```

---

### Task 8: The zoom dock and the pager

**Files:**
- Create: `src/lib/editor/ZoomDock.svelte`
- Create: `src/lib/editor/Pager.svelte`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `app`, `setZoom`, `zoomReset`, `gotoPage`, `nextPage`, `prevPage`; `history`, `undo`, `redo`.
- Produces: `<ZoomDock onFit={…} />` where `onFit` is the canvas's `computeFit(true)`; `<Pager />`.

- [ ] **Step 1: ZoomDock**

`Fit · − · {zoom}% · + | ↶ ↷`, reusing today's `.zoomdock` class and markup from `Editor.svelte:170-176`, plus two buttons bound to `undo`/`redo` and `disabled={!history.canUndo}` / `!history.canRedo`. Position: `position:fixed; bottom:16px; left:calc(50% + var(--dock-shift)/2)` is fragile — instead the dock and the pager are laid out together by the canvas layer (Task 10) inside one `.ed-dockrow` at `bottom:16px`, horizontally centred within the canvas viewport.

- [ ] **Step 2: Pager**

```svelte
<div class="pager">
  <button onclick={prevPage} disabled={app.pageIndex === 0} aria-label="Previous page">‹</button>
  {#if editing}
    <input class="pnum" type="text" bind:value={draft} onblur={commit} onkeydown={onKey} />
  {:else}
    <button class="pnum" onclick={begin}>{app.pages.length ? app.pageIndex + 1 : 0}</button>
  {/if}
  <span class="pof">/ {app.pages.length}</span>
  <button onclick={nextPage} disabled={app.pageIndex >= app.pages.length - 1} aria-label="Next page">›</button>
</div>
```

`commit` parses the draft, ignores anything that is not a number in `1..pages.length`, and calls `gotoPage(n - 1)`. Enter commits, Escape abandons.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add -A
git commit -m "feat: floating zoom/undo dock and a typeable pager"
```

---

### Task 9: The reference sidebar and the tool rail

**Files:**
- Create: `src/lib/editor/RefSidebar.svelte` (from `RawPanel.svelte`)
- Create: `src/lib/editor/RailTools.svelte`
- Modify: `src/lib/store.svelte.js` (`app.sidebarHidden`, persistence of `leftWidth`)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `app`, `page`, `rawZoomIn`, `rawZoomOut`, `setTool`, `openBulk`.
- Produces: `<RefSidebar />`, `<RailTools />`. Store gains `app.sidebarHidden` (boolean) and reads/writes `mt.sidebar` = `{ width, hidden }`.

- [ ] **Step 1: RefSidebar**

`RawPanel.svelte`'s body without the `.panel-head`: the scroll area and the zoom bar (`−`, label, `+`) pinned to the bottom, per the wireframe. Same `rawZoom` behaviour.

- [ ] **Step 2: RailTools**

Three tool buttons — place (`setTool('place')`), text (`setTool('text')`, keeping `ondblclick={openBulk}`), bulk style (`openBulk()`, `class:on={app.bulk.active}`) — with the existing SVGs, plus a caret at the top toggling `app.sidebarHidden`.

Dragging the rail resizes the sidebar. The 4px threshold keeps a click on a button from being read as a drag:

```js
function onRailPointerDown(e) {
  if (app.sidebarHidden) return;
  const startX = e.clientX;
  const startW = app.leftWidth;
  let dragging = false;
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
    dragging = true;
    app.leftWidth = Math.max(200, Math.min(460, startW + (ev.clientX - startX)));
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (dragging) saveSidebar();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
```

Put the handler on the rail element itself, not on the buttons; the buttons stop propagation on `pointerdown`.

- [ ] **Step 3: Persist**

In `src/lib/store.svelte.js`, beside the existing `mt.export` block, read `mt.sidebar` at module load into `app.leftWidth` / `app.sidebarHidden`, and export `saveSidebar()` that writes both. Same defensive `try`/`catch` the export prefs use.

- [ ] **Step 4: Build and commit**

```bash
npm run build && npm test
git add -A
git commit -m "feat: reference sidebar and the tool rail that resizes it"
```

---

### Task 10: The editor shell — full-bleed canvas, and the deletions

This is the task that changes the layout. It lands last among the build tasks because everything it composes now exists.

**Files:**
- Create: `src/lib/editor/EditorRoot.svelte`
- Create: `src/lib/editor/Canvas.svelte` (from `src/lib/Editor.svelte`)
- Delete: `src/lib/TopBar.svelte`, `src/lib/StatusBar.svelte`, `src/lib/Resizer.svelte`, `src/lib/RightPanel.svelte`, `src/lib/Editor.svelte`, `src/lib/RawPanel.svelte`
- Modify: `src/App.svelte`, `src/styles.css`, `src/lib/store.svelte.js`

**Interfaces:**
- Consumes: every component from Tasks 3, 7, 8, 9, plus `Inspector.svelte` and `Queue.svelte` unchanged.
- Produces: `<EditorRoot onFontLib={…} onSettings={…} />` — the editor route's single child.

- [ ] **Step 1: Canvas**

Copy `src/lib/Editor.svelte` to `src/lib/editor/Canvas.svelte` and remove: the `.panel-head`, the `.tooldock` (now the rail), the `.zoomdock` (now `ZoomDock`), the `onmousemove` handler and every reference to `app.cursor`. Export `computeFit` upward so the dock's Fit button can call it:

```svelte
let { onReady } = $props();
onMount(() => { onReady?.({ fit: () => computeFit(true) }); /* … existing … */ });
```

The scroll container fills the canvas layer, which is `position:absolute; inset:0 0 0 var(--canvas-left)`. `--canvas-left` is set inline by `EditorRoot` from the sidebar width and the rail width, so fit-to-window measures the canvas viewport and nothing else — the floating panels are ignored by design.

- [ ] **Step 2: EditorRoot**

```svelte
<div class="ed-root" style="--canvas-left:{canvasLeft}px">
  <div class="ed-canvas"><Canvas onReady={(api) => (canvas = api)} /></div>
  {#if !app.sidebarHidden}<RefSidebar />{/if}
  <RailTools />
  <ChromePills {onFontLib} {onSettings} />
  <div class="ed-dockrow"><ZoomDock onFit={() => canvas?.fit()} /><Pager /></div>
  <FloatingPanel id="options" title="Text box options"><Inspector /></FloatingPanel>
  <FloatingPanel id="queue" title="Text queue" count="{placed} / {total} placed"><Queue /></FloatingPanel>
  <BulkStylePanel />
</div>
```

`canvasLeft = (app.sidebarHidden ? 0 : app.leftWidth) + RAIL_W`. On mount and on `window.resize`, call `loadPanels(localStorage, innerWidth, innerHeight)` once and `clampAll(innerWidth, innerHeight)` thereafter.

- [ ] **Step 3: Rewire `App.svelte`**

The editor branch becomes:

```svelte
{#if route.name === 'editor'}
  <EditorRoot onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />
{:else if booted}
```

Delete the `TopBar`, `RawPanel`, `Editor`, `RightPanel`, `StatusBar`, `Resizer` imports and the `.app`/`.main` wrapper.

- [ ] **Step 4: Delete the old components and their CSS**

Remove the six files listed above. From `src/styles.css`, delete `.app`, `.main`, `.col`, `.col-left`, `.col-center`, `.col-right`, `.panel-head`, `.resizer`, `.topbar`, `.brand`, `.pagenav`, `.topbar-right`, `.export-combo`, `.statusbar`, `.rpanel`, `.section*`, `.raw-*` (rehomed into the sidebar's own rules), and the `--topbar-h` / `--status-h` tokens. Remove `app.collapsed`, `app.rightWidth` and `app.cursor` from the store, and `selectBox`'s `app.collapsed.inspector = false` line.

- [ ] **Step 5: Verify nothing dangles**

```bash
grep -rn "TopBar\|StatusBar\|RightPanel\|Resizer\|app.cursor\|app.collapsed\|rightWidth\|topbar-h\|status-h" src/
```
Expected: no matches outside this plan's own history.

- [ ] **Step 6: Build, test, run**

```bash
npm test && npm run build && (cd src-tauri && cargo check)
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: full-bleed editor shell; delete the top bar, status bar and column resizers"
```

---

### Task 11: Translating a line in the queue

**Files:**
- Modify: `src/lib/Queue.svelte`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `page`, `activateLine`, `lineText`, `markUnsaved`.
- Produces: no new exports.

- [ ] **Step 1: Expand the active row**

Inside the `{#each}`, after the existing row, when `line.n === p.activeLineN`:

```svelte
{#if line.n === p.activeLineN}
  <div class="qedit">
    {#if line.jp}<div class="qedit-jp">{line.jp}</div>{/if}
    <textarea
      rows="2"
      placeholder="English…"
      value={line.en ?? ''}
      oninput={(e) => { line.en = e.currentTarget.value; markUnsaved(); }}
    ></textarea>
  </div>
{/if}
```

A box placed from this line carries `text: null` and resolves through `lineText`, so the canvas updates as the user types with no extra wiring. Queue edits are deliberately outside the undo history.

- [ ] **Step 2: Style**

`.qedit{ padding:2px 8px 8px 34px; }` and a textarea using `--surface` / `--line2` / `--text`, matching `.insp textarea`.

- [ ] **Step 3: Build and commit**

```bash
npm run build
git add -A
git commit -m "feat: translate a queue line in place"
```

---

### Task 12: Stylesheet sweep and both themes

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Hunt literals**

```bash
grep -nE "#[0-9a-fA-F]{3,8}|rgba?\(" src/styles.css | grep -vE "^(2[0-9]|3[0-9]|4[0-4]):"
grep -rnE "#[0-9a-fA-F]{3,8}|rgba?\(" src/lib src/App.svelte
```
The first excludes the `:root` blocks that define the tokens. Expected: no matches. `rgba()` inside `TextBox.svelte`'s `rgba(hex, a)` helper is user-chosen text colour, not chrome, and stays.

- [ ] **Step 2: Confirm `--warn` is used once**

```bash
grep -rn "var(--warn)" src/
```
Expected: the save dot, plus the pre-existing `.btn-danger`, `.font-card .del:hover` and the browser-preview notice. Nothing new.

- [ ] **Step 3: Both themes, every screen**

Run `npm run tauri dev` and check, in light and dark: the pills, the rail, the sidebar and its zoom bar, the zoom dock, the pager, both panels open, both panels hidden as buttons, the detect menu, a selected box on the page (handles and outline still dark on `--paper` in both themes), and the bulk-target ring.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "style: sweep the editor stylesheet after the chrome rebuild"
```

---

## Verification (run by the orchestrator, not a task subagent)

1. `npm test` — passes, and the count has grown by the three new suites.
2. `npm run build` — clean.
3. `cd src-tauri && cargo check` — clean.
4. **Prove the build under test is this worktree's.** Put a temporary marker in the project pill's label, launch `npm run tauri dev`, confirm the marker on screen, then revert it.
5. Drive the app: drag, resize, hide and restore both panels; quit and relaunch; confirm the layout came back. Undo and redo to the cap and past it. Switch pages and confirm the stack follows. Place, move, resize, rotate, inline-edit, bulk-style, detect and export, and confirm nothing regressed. Both themes on every screen.
