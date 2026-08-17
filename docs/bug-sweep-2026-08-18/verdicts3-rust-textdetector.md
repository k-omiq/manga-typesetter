1: CONFIRMED — Line quad centered at reading origin `(0, 0)` causes `len == 0.0` (`0.0 / 0.0 = NaN`) or float inexactness in collinear vectors yields `dot / (len * norm) > 1.0`, passing values outside `[-1.0, 1.0]` to `.acos()` and pushing `NaN` into `blk.distance` without clamping or zero-checks ([`src-tauri/src/detect/textblock.rs:281-282`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L281-L282)).

2: REFUTED — Guarded by caller construction invariant: `merge_textlines` is private and only invoked on `scattered_hor`/`scattered_ver`, whose blocks are always created with 1 line and processed by `examine_textblk`, guaranteeing `distance.len() == 1` ([`src-tauri/src/detect/textblock.rs:502-509`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L502-L509)).

3: REFUTED — Guarded by caller invariant: `try_merge_textline` is private and only called from `merge_textlines` on blocks with `distance.len() >= 1`; merges append distances synchronously with lines, so `distance` is never empty ([`src-tauri/src/detect/textblock.rs:396`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L396), [`src-tauri/src/detect/textblock.rs:502-509`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L502-L509)).

4: REFUTED — Guarded by font-size ratio check: when a block has `norm == 0.0`, its `font_size` is also `0.0`, causing `fntsize_div > 1.3 || 1.0 / fntsize_div > 1.3` to evaluate to `+inf > 1.3` (`true`) and return `false` before `cos_vec` is reached ([`src-tauri/src/detect/textblock.rs:378`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L378)).

5: REFUTED — Guarded by `intersect_area` bounds ([`src-tauri/src/detect/textblock.rs:147-156`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L147-L156)): intersection against a zero-area line quad `lb` is always `<= 0.0`, so `score` evaluates to `-inf` or `NaN`; float comparison `best < score` evaluates to `false` for both against initial `best = -1.0`, so `best > 0.4` is never satisfied and proposal 0 is never assigned ([`src-tauri/src/detect/textblock.rs:490-496`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L490-L496)).

6: REFUTED — Guarded by caller precondition: `want_split = blk.lines.len() > 1 && ...` ensures `split_textblk` is never called with `blk.lines.len() < 2` ([`src-tauri/src/detect/textblock.rs:527-529`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L527-L529)).

7: CONFIRMED — Calling `group_output` with `im_w == 0` (or `im_h == 0`) and an English horizontal block evaluates `.clamp(0.0, -1.0)` during Latin glyph padding, panicking with `assertion failed: min <= max` ([`src-tauri/src/detect/textblock.rs:554-555`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L554-L555)).

### Priority Summary
- **P1 (High)**: Finding 1 — `NaN` propagation from unchecked `.acos()` poisons line distances, disrupting reading order sorting downstream.
- **P3 (Low)**: Finding 7 — Direct calls to `group_output` with zero image width/height cause `.clamp()` panics during English padding.
- **Refuted (5 of 7)**: Findings 2, 3, 4, 5, and 6 are unreachable in execution due to caller preconditions, geometric bounds, and prior branch guards.
