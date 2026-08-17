1: **CONFIRMED** — `pageIndexAtCenter` evaluates `center >= tops[i]` which is true for all zero-height pages (`tops = [0, 0, ...]`), returning `n - 1` on unmeasured chapters and jumping `app.pageIndex` to chapter end on startup ([`src/lib/editor/strip.js:55`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/strip.js#L55)).

2: **CONFIRMED** — In longstrip mode, clicking/editing a box on a visible adjacent page calls `focusPage(pg)`, but any subsequent scroll or queued frame in `syncStrip` recalculates `pageIndexAtCenter`, invoking `gotoPage()` and clearing `app.selectedId` and `app.editingId` ([`src/lib/editor/Canvas.svelte:448`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/Canvas.svelte#L448)).

3: **CONFIRMED** — `pages.map(p => (p.h ?? 0) * zoom)` runs inside `untrack(() => ...)`, so Svelte 5 does not track property reads on `p.h`; when image decodes populate page heights via `setPageDims`, the effect never re-runs and resident prefetch radius stays stuck at `max = 12` ([`src/lib/editor/EditorRoot.svelte:106`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/EditorRoot.svelte#L106)).

4: **REFUTED** — `syncStrip` explicitly constrains reads to `const n = app.pages.length` and checks `if (!frameEls[i]) return;` ([`src/lib/editor/Canvas.svelte:435-441`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/Canvas.svelte#L435-L441)), safely ignoring any trailing elements from longer chapters.

5: **REFUTED** — Rotate handles are only rendered when `selected` is true (`{#if selected && !editing && !bulkOn}` at [`src/lib/TextBox.svelte:527`](file:///Users/caved/dev/manga-typesetter/src/lib/TextBox.svelte#L527)), so user pointer interaction can only occur post-mount after `bind:this={frameEls[i]}` in [`src/lib/editor/Canvas.svelte:557`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/Canvas.svelte#L557) has already populated `pageFrameEl`.

6: **CONFIRMED** — When creating an empty box on an unmeasured page (`p.w === 0, p.h === 0`), `Math.max(0, p.w - w)` evaluates to 0, forcing `clamp(imgX - w / 2, 0, 0)` to return 0 and collapsing the new box coordinates to `(0, 0)` ([`src/lib/store.svelte.js:1745`](file:///Users/caved/dev/manga-typesetter/src/lib/store.svelte.js#L1745)).

7: **CONFIRMED** — The scroll sync `$effect` depends solely on `stripScroll.seq` and `scrollEl`; when page dimensions decode and update `ratioOf(pg)` in the DOM, `scrollEl.scrollHeight` changes without triggering the effect, leaving `scrollEl.scrollTop` desynchronized until Canvas is scrolled ([`src/lib/editor/RefSidebar.svelte:41`](file:///Users/caved/dev/manga-typesetter/src/lib/editor/RefSidebar.svelte#L41)).

---

### Priority Summary
- **P1 (High / Core UX):** Findings 1 & 2 (startup jump to the last page on unmeasured longstrips, and scroll-triggered abort of inline editing/selection on adjacent slices).
- **P2 (Medium / State integrity):** Findings 3 & 6 (prefetch window stuck at max radius 12 due to untracked height reads, and `addEmptyBox` collapsing to `(0,0)` on unmeasured pages).
- **P3 (Low / Visual alignment):** Finding 7 (reference sidebar scroll offset lag when placeholder aspect ratios resolve to real image proportions).
