1. [`src-tauri/src/detect/textblock.rs:282`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L282) — **HIGH** — Floating-point rounding or zero vector in `examine_textblk` passes values outside `[-1.0, 1.0]` (or `0.0 / 0.0`) to `.acos()`, inserting `NaN` into `blk.distance`.
   - **Failure scenario**: When a text line is aligned with the reading origin axis (e.g. horizontal text where `origin = (0.0, 0.0)` and line center `c = (100.0, 0.0)` with primary direction `(100.0, 0.0)`), float inexactness in `(d.0 * primary.0 + d.1 * primary.1) / (len * primary_norm)` can evaluate to `1.0000000000000002` (or `len == 0.0` at the origin produces `0.0 / 0.0`). `.acos()` returns `NaN`, poisoning `blk.distance`. Downstream, line sorting (`sort_lines`), column splitting (`split_textblk`), and stray line merging (`try_merge_textline`) receive `NaN` distances, corrupting line reading order and silently bypassing distance thresholds.
   - **One-line fix**: `let rad = if len * primary_norm == 0.0 { 0.0 } else { ((d.0 * primary.0 + d.1 * primary.1) / (len * primary_norm)).clamp(-1.0, 1.0).acos() };`

2. [`src-tauri/src/detect/textblock.rs:405`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L405) — **HIGH** — Direct indexing `a.distance[0]` in `merge_textlines` panics on empty `distance` arrays.
   - **Failure scenario**: When `merge_textlines` receives blocks that have not had `examine_textblk` populated or whose line list was empty when examined, `a.distance` is empty (`len == 0`). Calling `blks.sort_by(|a, b| a.distance[0].total_cmp(&b.distance[0]))` panics with `index out of bounds: the len is 0 but the index is 0`.
   - **One-line fix**: `blks.sort_by(|a, b| a.distance.first().copied().unwrap_or(0.0).total_cmp(&b.distance.first().copied().unwrap_or(0.0)));`

3. [`src-tauri/src/detect/textblock.rs:372`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L372) — **MED** — `try_merge_textline` accesses `a.distance` and `b.distance` without verifying they are non-empty.
   - **Failure scenario**: `try_merge_textline` checks `if a.lines.is_empty() || b.lines.is_empty()`, but does not verify `a.distance` or `b.distance`. If either block has an empty `distance` vector, `b.distance[b.distance.len() - 1]` underflows `usize` (`0 - 1`) in debug/release or panics on indexing.
   - **One-line fix**: `if b.merged || a.lines.is_empty() || b.lines.is_empty() || a.distance.is_empty() || b.distance.is_empty() { return false; }`

4. [`src-tauri/src/detect/textblock.rs:371`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L371) — **MED** — Division by zero when `a.norm == 0.0` or `b.norm == 0.0` yields `NaN` in `cos_vec`, silently bypassing orientation rejection in `try_merge_textline`.
   - **Failure scenario**: If either block has degenerate geometry (`norm == 0.0`), `cos_vec = vec_prod / a.norm / b.norm` evaluates to `NaN`. The orientation check `if cos_vec.abs() < 0.866 { return false; }` evaluates to `false` because `NaN < 0.866` is `false`, allowing non-parallel or degenerate blocks to merge into one.
   - **One-line fix**: `if a.norm <= 0.0 || b.norm <= 0.0 || b.font_size <= 0.0 { return false; }`

5. [`src-tauri/src/detect/textblock.rs:486`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L486) — **MED** — Division by zero when `line_area == 0.0` in `group_output` causes collapsed line quads to produce infinite score and attach to proposal 0.
   - **Failure scenario**: If a line quad collapses to a 1D line or point where `lb[2] == lb[0]` or `lb[3] == lb[1]`, `line_area` is `0.0`. `intersect_area(blk.xyxy, lb) / line_area` yields `+INFINITY` (or `NaN`), making `best > BBOX_SCORE_THRESH (0.4)` evaluate to `true` and pushing the invalid zero-area quad into `blk_list[0]`.
   - **One-line fix**: `if line_area <= 0.0 { continue; }`

6. [`src-tauri/src/detect/textblock.rs:309`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L309) — **LOW** — Unconditional `blk.lines[0]` in `split_textblk` panics on empty line blocks.
   - **Failure scenario**: If `split_textblk` is invoked on a block with `blk.lines.is_empty()`, `let l0 = blk.lines[0];` panics immediately with `index out of bounds`.
   - **One-line fix**: `if blk.lines.is_empty() { return (false, vec![blk.clone()]); }`

7. [`src-tauri/src/detect/textblock.rs:554`](file:///Users/caved/dev/manga-typesetter/src-tauri/src/detect/textblock.rs#L554) — **LOW** — `clamp(0.0, (im_w - 1) as f64)` in horizontal English padding panics if `im_w == 0` or `im_h == 0`.
   - **Failure scenario**: If `im_w == 0`, `im_w - 1` is `-1`. Calling `.clamp(0.0, -1.0)` panics with `min > max` in Rust's standard library.
   - **One-line fix**: `l[k][0] = (l[k][0] as f64 + dx).clamp(0.0, (im_w.max(1) - 1) as f64).trunc() as i32;`
