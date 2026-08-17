Looking into the codebase and running test suites.
Waiting for vitest to complete.
I will wait for the test run to finish.
Waiting for the test task to complete.
Waiting for the test to complete.
Waiting for vitest to finish.
Waiting for vitest to finish.
Waiting for vitest to finish.
Waiting for vitest.
Waiting for vitest.
Waiting for test to finish.
Waiting for vitest.
Waiting for vitest.
Waiting for vitest.
Waiting for vitest.
Waiting for vitest.
### Bug Hunt Findings

1. [`src/lib/exporter.js:344`](file:///Users/caved/dev/manga-typesetter/src/lib/exporter.js#L344) — **SEVERITY(low)** — `renderPageCanvas` throws an uncaught `TypeError` if invoked on a page object missing the `boxes` property — **DEMONSTRATED**: `await renderPageCanvas({ id: 1, w: 800, h: 1200 })` throws `TypeError: Cannot read properties of undefined (reading Symbol(Symbol.iterator))` because line 344 lacks the fallback present in `renderStripSliceCanvas` (line 582) — **Fix**: Change `for (const box of p.boxes)` to `for (const box of p.boxes ?? [])`.

---

### Verified Clean Target Invariants (Demonstrated via Probes & Proofs in `/tmp`)

- **Cut-planner nontermination / overlap on adversarial bands**: **CLEAN (DEMONSTRATED)**. Tested with 10,000 randomized fuzz trials and adversarial inputs (negative box heights, bands spanning past strip ends, dense wall of boxes, full-strip band coverage). `push(y)` enforces `Math.max(Math.round(y), prev + 1)`, ensuring strictly monotonic `prev` advancement by $\ge 1\text{px}$ per iteration, guaranteeing finite termination in $\le \lceil\text{total}\rceil + 1$ iterations. Tail collapsing logic (`cuts.pop()`) prevents duplicates or overlapping cuts.
- **Rotated-box bound calculations**: **CLEAN (DEMONSTRATED)**. `boxSpanY(box)` calculates vertical half-extent `(|sin(a)|*w + |cos(a)|*h)/2` around `cy = y + h/2`, matching the center-pivot transform in `paintBoxOnPage` across all quadrant rotations and mirror flips.
- **Slice canvas coordinate drift vs `stripOffsets`**: **CLEAN (REASONED & DEMONSTRATED)**. `measureStrip` measures unmeasured pages prior to computing `stripOffsets`, passing integer whole-pixel cut bounds `y0, y1` to `renderStripSliceCanvas`, ensuring page positions `top - y0` align across adjacent slice seams without fractional resampling drift.
- **Pin leaks in nested `withPagesImages` on throw**: **CLEAN (DEMONSTRATED)**. Nested `withPageImages` calls properly manage per-page refcounts within individual `try ... finally` blocks; exceptions thrown during slice rendering unwind and trigger `releasePageImages` cleanly without pin leaks.
- **Filename padding collisions for >99 slices**: **CLEAN (DEMONSTRATED)**. `exportStripImages` calculates `digits = Math.max(2, String(n).length)`. For 150 slices, it correctly formats 3-digit zero-padded names (`ch01-strip-001.png` through `ch01-strip-150.png`) with no collisions.
- **Zero-page or single-short-page chapters**: **CLEAN (DEMONSTRATED)**. Zero-page/0-height projects return `{ cuts: [], warnings: [] }` and cleanly notify the user with `"Nothing to export — this chapter has no page art to slice."`. Chapters shorter than `targetHeight` cleanly yield a single slice spanning `[0, total]`.
