1: CONFIRMED (minimal trigger: drag rotation handle into bottom-left quadrant where `atan2` is in (90°, 180°]; `ang` evaluates to 180°..270° and clamps to 180°, freezing rotation and leaving -180°..-90° unreachable) — [`src/lib/TextBox.svelte:324`](file:///Users/caved/dev/manga-typesetter/src/lib/TextBox.svelte#L324)

2: CONFIRMED (minimal trigger: narrative rectangle with 1+ panel-border outlier rows; `build(ev.inliers)` uses outer `y0`/`y1` from `pts` instead of `ps`, keeping outlier rows in `alt.h` and preventing `coverage` from recovering above `minCoverage`) — [`src/lib/balloon.js:631`](file:///Users/caved/dev/manga-typesetter/src/lib/balloon.js#L631)

3: CONFIRMED (minimal trigger: curved text box with `s.uppercase: true` and lowercase input text; `TextBox.svelte` passes raw `text` to `arcLayout` while `textStyle` applies `text-transform: uppercase`, laying out wider uppercase glyphs using narrower lowercase measurements and diverging from export) — [`src/lib/TextBox.svelte:105`](file:///Users/caved/dev/manga-typesetter/src/lib/TextBox.svelte#L105)

4: CONFIRMED (minimal trigger: calling `arcLayout('test', { size: 0, letterSpacing: 0, curve: 50 }, 20)` or with `letterSpacing: undefined`; `ls` evaluates to `NaN`, making `total` `NaN` which bypasses `total <= 0` and produces character objects with `NaN` coordinates) — [`src/lib/measure.js:55-58`](file:///Users/caved/dev/manga-typesetter/src/lib/measure.js#L55-L58)

5: CONFIRMED (minimal trigger: calling `wrapLines` or `lineWidth` with a style omitting `letterSpacing` or with `size: 0`; `ls` evaluates to `NaN`, causing `wrapLines` to never break lines (`NaN > maxWidth` is false) and `lineWidth` to return `NaN` breaking dynamic programming in `typeset.js`) — [`src/lib/measure.js:82, 111, 161`](file:///Users/caved/dev/manga-typesetter/src/lib/measure.js#L82)

6: CONFIRMED (minimal trigger: `wrapLines('hello world   ', style, 20, 200)`; terminal line is pushed via `out.push(line)` without `.replace(/\s+$/, '')`, retaining trailing whitespace unlike wrapped lines and `wrapLinesDOM:147`) — [`src/lib/measure.js:97`](file:///Users/caved/dev/manga-typesetter/src/lib/measure.js#L97)

### Priority Summary
- **P1 (Immediate UX/Visual Fixes)**: #1 (fix rotation handle wrap-around in [`TextBox.svelte`](file:///Users/caved/dev/manga-typesetter/src/lib/TextBox.svelte#L324)) and #3 (wrap `text` with `applyCase(text, s)` in [`TextBox.svelte`](file:///Users/caved/dev/manga-typesetter/src/lib/TextBox.svelte#L105) to eliminate UI/export divergence).
- **P2 (Algorithm Correctness & Stability)**: #2 (derive `y0`/`y1` from `ps` in `fitRect` in [`balloon.js`](file:///Users/caved/dev/manga-typesetter/src/lib/balloon.js#L631)) and #4, #5 (add `?? 0` and `style.size > 0` guards for `letterSpacing`/`size` in [`measure.js`](file:///Users/caved/dev/manga-typesetter/src/lib/measure.js#L55)).
- **P3 (Formatting Parity)**: #6 (strip trailing whitespace on terminal lines in `wrapLines` in [`measure.js`](file:///Users/caved/dev/manga-typesetter/src/lib/measure.js#L97) to match `wrapLinesDOM`).
