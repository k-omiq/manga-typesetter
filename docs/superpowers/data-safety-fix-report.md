# Data-safety fixes — three findings from the final audit

Branch `strip-clean`, on top of `49abcc2`. Three commits, one per finding:

| Finding | Commit | Subject |
| --- | --- | --- |
| 1 — stale scan clobbers a newer one | `3c3cf1e` | fix: let a stale library scan lose to the newer one |
| 2 — JSON import destroys typesetting | `d560667` | fix: stop a JSON import from deleting the pages it says nothing about |
| 3 — non-atomic `chapter.json` write | `59cb747` | fix: write the library's record files atomically |

---

## Finding 1 — `scanLibrary` had no in-flight guard

### What was wrong

`scanLibrary` read the live `library.root` across its awaits and assigned
`library.projects`, `library.error` and `library.loading` unconditionally at the end.
A scan blocked on a macOS folder-permission prompt therefore came back long after the
user had taken the app's own documented recovery — Settings ▸ Change folder — and
blanked the catalogue the newer scan had already painted, under a message that named
the *new* root against the *old* root's error.

### What I did

`src/lib/library.svelte.js`:

- Every scan takes a monotonic ticket (`const token = ++scanSeq`) and captures
  `const root = library.root` **once, at entry**. Every subsequent read of the root —
  the `exists`/`mkdir`, the `subdirs`, the marker joins, the unreadable-project stub,
  and the failure message — uses the captured value. The message can no longer name
  one path against another path's failure, by construction rather than by care.
- Two ownership predicates, deliberately different:
  - `isNewest()` — `scanSeq === token`. Gates `library.loading` only. The newest scan
    owns the flag whichever root it is reading, so a superseded scan cannot clear a
    spinner the live one still needs.
  - `owns()` — `isNewest() && library.root === root`. Gates `library.projects` and
    `library.error`, in both the success and the failure path. A result is only
    applied while the root it describes is still the one on screen.

I chose a scan token over, say, an AbortController or a single-flight lock because the
work here is a series of plain filesystem reads with no cancellation primitive
available through `fsx`, and because the failure mode is entirely about *who writes
last*, not about wasted work. A token is the smallest thing that answers "am I still
the current scan?" at each assignment point.

### Test

`src/lib/library.test.js` › `scanLibrary` › *lets the newer scan win when a blocked one
settles late*. Scan A is blocked on the very first call it makes (`fsx.exists` on the
old root, standing in for the permission prompt); the root is changed and scan B runs
to completion; scan A is then rejected with the real macOS wording. Asserts scan B's
projects survive, `library.error` is `''`, and `library.loading` is `false`.

A second case — *names the root it actually read when a scan fails* — pins the captured
root in the error message.

Verified the test reproduces the defect: with `src/lib/library.svelte.js` reverted, it
fails with `expected [] to deeply equal [ 'kept' ]` — i.e. the stale scan wiping the
catalogue, exactly as the auditor saw. (My first draft of this test passed against the
buggy code, because the root changed during a microtask gap *before* the old code read
it; blocking the first call is what makes it faithful.)

---

## Finding 2 — a JSON import could destroy typesetting in one click

### What was wrong

`importJsonFile` did `app.pages = parsed.map(...)`. A translations JSON with fewer pages
than the open chapter deleted every page past its end and every box on those pages, with
no confirm — and since leaving the editor flushes unconditionally, the truncation reached
`chapter.json` and orphaned the raws of the dropped pages.

### The approach, and why

I took option **(a): refuse to shrink**, which the finding preferred and which I agree
is the coherent one. A translations file is source material *for pages that exist*. It
says what the lines on page 1..N are; it says nothing about whether the chapter has
pages after that, so it has no business deleting them. A confirm dialog would have made
the destruction deliberate, but it would still have offered the user a destructive
answer to a question the file never asked. The rule now is:

- Pages the JSON **covers** take its lines and keep everything else — their `raw`,
  their `file`, their `detect`, and every box already placed on them (`blankPage`
  already carried all of that; it just was not being reached for the surviving pages).
- Pages **past the JSON's end** are left exactly as they are, carried across by object
  identity rather than rebuilt.
- Pages **past the end of the document** are appended only when no chapter is open —
  outside a chapter that is the one way a document gets created at all. Inside a
  chapter they are ignored, because a page appended there carries no `file`, and the
  known defect at this same seam (`importer.js:64` / `library.svelte.js:539`) would
  persist it as `file: ''`: a page that can never render and can never be removed.

The user is informed rather than surprised: the toast now reads
`Imported N page(s), M line(s) — K later page(s) left unchanged` and, when a JSON runs
past the chapter, `— J page(s) past the end of the chapter ignored — add pages in the
library`.

One deliberate addition: the covered pages now call `markUnsaved()`. The import is a
real edit to the open chapter, and it should be saved by the autosave like any other
edit, rather than depending on whatever happens to flush next.

The JSON button stays enabled inside a chapter, unlike Cleaned/Raw. That is now correct
rather than an oversight: re-importing updated translations is what the button is *for*,
and it can no longer remove a page or a box.

### Tests

New describe block in `src/lib/library.test.js` — *a JSON import never shortens the
chapter* — over a three-page chapter typeset on the last page:

- *keeps the pages a shorter JSON does not cover, and their boxes* — 3 pages in memory
  and on disk after a save, page 3's box and line intact.
- *updates the lines on the pages the JSON does cover* — `['One', 'Two', 'End']` on disk.
- *does not append pages that would persist with no raw* — a five-page JSON over a
  three-page chapter leaves three pages, files unchanged, and says so.
- *saves the imported lines itself rather than waiting for the way out* — the debounce
  writes the imported lines.

Two existing cases were rewritten because they encoded the old truncating behaviour
(*keeps every covered page on its own raw…* now asserts both files survive; *warns that
pages were dropped* became *says how many later pages it left alone*).

Verified against the pre-fix importer: all six of those cases fail (`expected 1 to be
2`, `1 page(s) dropped from the chapter`, etc.).

---

## Finding 3 — `chapter.json` was written non-atomically

### What I did, and where

`fsx` grew `writeTextFileAtomic(path, contents)`: write to a temp file, `rename` it over
the target, remove the temp on any failure. `writeJson` in `library.svelte.js` calls it,
so both `chapter.json` and `project.json` get the guarantee.

**Why the facade and not `writeJson`:** the temp-and-rename dance is three filesystem
calls that have to stay behind the one module allowed to make them — putting it in
`writeJson` would either mean `library.svelte.js` composing raw fsx calls into a
durability protocol it does not own, or a second seam that only some writes go through.

The temp path is the target's own path plus a suffix (`chapter.json.3.tmp`), which makes
it a **file**, in the **same directory**, by construction — no path parsing, and rename
within a directory is atomic on APFS/HFS+. A leftover cannot be mistaken for a project
or a chapter because the scan only ever considers directory entries
(`subdirs` filters `e.isDirectory`) and only descends into directories carrying a
marker file. It is removed on failure regardless. The suffix carries a per-process
counter so two overlapping writes to one path (a debounced autosave and a flush) never
share a temp file, and one cleaning up cannot delete the other's.

`src-tauri/capabilities/default.json` gains `fs:allow-rename`. The `fs:scope` allow/deny
lists are untouched, so the asset-protocol scope in `tauri.conf.json` still mirrors them
and did not need editing.

### Tests

New `src/lib/fsx.test.js`, mocking `@tauri-apps/plugin-fs` with a filesystem that can be
told to die partway:

- lands the new contents and leaves no temp file behind;
- writes the temp file beside the target, never over it (same directory, `.tmp` suffix);
- **leaves the target untouched when the write dies partway** — the target still parses
  as JSON and still holds the previous contents;
- leaves the target untouched when the rename fails;
- gives concurrent writes to one path their own temp files.

Verified by temporarily reducing `writeTextFileAtomic` to a plain `writeTextFile`: four
of the five fail, and the truncation case reports the target holding
`'{"schema":1,"pages":[{"id":1,"bo'` — the half-written chapter this fix exists to
prevent.

The `fsx` mock in `library.test.js` models `writeTextFileAtomic` by its *contract*
(delegating to its own `writeTextFile`, so the target ends up holding either the old or
the new contents) rather than its mechanics. That keeps the existing broken-disk tests
meaningful — they swap in a `writeTextFile` that throws, and still break the write they
mean to break.

---

## Verification

### `npm test`

```
 RUN  v3.2.7 /Users/caved/dev/manga-typesetter/.claude/worktrees/strip-clean

 ✓ src/lib/paths.test.js (12 tests) 7ms
 ✓ src/lib/route.test.js (9 tests) 4ms
 ✓ src/lib/format.test.js (10 tests) 4ms
 ✓ src/lib/fsx.test.js (5 tests) 6ms
 ✓ src/lib/library.test.js (53 tests) 74ms

 Test Files  5 passed (5)
      Tests  89 passed (89)
```

78 → 89. New: 2 scan-race cases, 4 JSON-import cases, 5 atomic-write cases; 2 existing
JSON cases rewritten.

### `npm run build`

```
dist/index.html                    0.89 kB │ gzip:   0.47 kB
dist/assets/index-BmC2tYgT.css    32.43 kB │ gzip:   6.68 kB
dist/assets/dist-js-BjC5nr15.js    1.24 kB │ gzip:   0.48 kB
dist/assets/dpi-DDPM0Im7.js        2.57 kB │ gzip:   0.68 kB
dist/assets/path-CDhkFOpO.js       3.75 kB │ gzip:   0.90 kB
dist/assets/dist-js-BpseaGKC.js    6.69 kB │ gzip:   1.71 kB
dist/assets/menu-jY2gvsH2.js       8.42 kB │ gzip:   1.79 kB
dist/assets/window-TvOOZ8-J.js    11.72 kB │ gzip:   2.97 kB
dist/assets/index-BQSNNn7I.js    447.94 kB │ gzip: 139.98 kB
✓ built in 718ms
```

(The two `INEFFECTIVE_DYNAMIC_IMPORT` notices are pre-existing and unrelated.)

### `cargo check`

```
    Checking tauri v2.11.2
    Checking tauri-plugin-fs v2.5.1
    Checking tauri-plugin-log v2.8.0
    Checking tauri-plugin-dialog v2.7.1
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 20.44s
```

Clean, including the new `fs:allow-rename` capability (`tauri-build` validates the
capability file, so an invalid identifier would have failed here).

---

## Exercising Finding 2 — what I actually did, and what I did not

### Build identity, and why the GUI walkthrough did not happen

I built a **temporary, distinctly-named bundle from this worktree** so it could not be
confused with any packaged build already on the machine: `productName` →
`MangaTypesetter STRIPCLEAN 7Q4`, bundle identifier →
`com.mangatypesetter.stripclean7q4`, window title → `Manga Typesetter — STRIP-CLEAN LIVE
7Q4`. `npm run tauri build -- --debug --bundles app` produced
`src-tauri/target/debug/bundle/macos/MangaTypesetter STRIPCLEAN 7Q4.app`, and it
launched — its process was
`…/strip-clean/src-tauri/target/debug/bundle/macos/MangaTypesetter STRIPCLEAN
7Q4.app/Contents/MacOS/app`, i.e. this worktree's path.

**I never saw its window.** Screen-control access for that app was requested twice and
denied both times, and screenshots are impossible without it. So I did **not** visually
confirm the marker on screen, and I am not claiming a GUI walkthrough. The identity
evidence I do have is the bundle name, the bundle identifier, and the running process
path — all of which point at this worktree — not a screenshot.

An earlier `npm run tauri dev` from this worktree also compiled and ran
(`target/debug/app` alive), but its process is named `app`, which the access system
cannot resolve, so that route was a dead end for the same reason.

### What I exercised instead: the shipped modules against the real filesystem

A temporary Vitest file (written, run, then deleted — it is not in the suite) drove the
**real** `library.svelte.js`, `store.svelte.js` and `importer.js` against the **real**
filesystem, mocking only `@tauri-apps/plugin-fs` and `@tauri-apps/api/path` — the exact
boundary the Rust side implements — with `node:fs`. Real directories, real byte copies,
a real `rename`. Library root: `~/Documents/MangaTypesetter-STRIPCLEAN-7Q4-live`.

The walkthrough, matching the requested scenario:

1. Scan an empty root, create project **Live Check**.
2. Create chapter 1 "Live" from four real PNGs (`page1..4.png`, generated as fixtures).
3. Open the chapter, go to page 3 and page 4, put a line on each and **place a box** via
   the editor's own `placeActiveAt`.
4. Flush. On disk: `boxes` per page = `[0, 0, 1, 1]`.
5. Import `short.json` — a translations file covering **only the first two pages**.
6. Flush and close the chapter (the flush the route performs on the way out), rescan the
   library, and **reopen the chapter from disk**.

Observed:

```
TOAST: Imported 2 page(s), 2 line(s) — 2 later page(s) left unchanged
CATALOGUE: 4 pages, typeset = true
ON DISK:
 [ { file: page1.png, lines: ["PAGE ONE FROM JSON"],  boxes: 0 },
   { file: page2.png, lines: ["PAGE TWO FROM JSON"],  boxes: 0 },
   { file: page3.png, lines: ["HAND-PLACED PAGE 3"],  boxes: 1 },
   { file: page4.png, lines: ["HAND-PLACED PAGE 4"],  boxes: 1 } ]
CHAPTER DIR: chapter.json, raws
RAWS DIR: page1.png, page2.png, page3.png, page4.png
PROJECT DIR: 001-live, project.json
```

Pages 3 and 4 kept their boxes through the import, the navigation and the reopen; their
raws resolved again on reopen; the imported lines landed on pages 1 and 2; all four raws
compared **byte-identical** to the source PNGs; and no `*.tmp` file was left anywhere
under the root (`find … -name '*.tmp' | wc -l` → `0`), so the atomic write cleaned up
after itself across every `chapter.json` and `project.json` write in the run.

The same script against the **pre-fix** importer, on the same real filesystem:

```
TOAST: Imported 2 page(s), 2 line(s) — 2 page(s) dropped from the chapter
CATALOGUE: 2 pages, typeset = false
AssertionError: expected [ …2 items ] to have a length of 4
```

Two pages and both boxes destroyed, the chapter no longer typeset, `page3.png` and
`page4.png` orphaned in `raws/`. That is the defect, reproduced on disk, and then fixed.

### Findings 1 and 3

Unit-tested only. I did not induce a permission-blocked boot scan or a mid-write crash
on this machine, and I am not implying otherwise. Finding 3's atomic write did run for
real (every record write in the exercise above went through `node:fs.rename`), but the
crash-mid-write case is covered by the fault-injecting mock in `fsx.test.js`, not by an
actual power loss.

### Cleanup

Removed afterwards: the temporary bundle, the temporary Vitest file, the live library
root, and the marker edits to `tauri.conf.json` (reverted; `git diff` on it is empty).
I also deleted `src-tauri/target/release/bundle/macos/` — that held a stale
`Manga Typesetter.app` from an earlier session, and it was precisely the "could be
launched by mistake" hazard. It is untracked build output and `npm run tauri build`
recreates it, but it was not mine, so I am flagging it rather than burying it.

---

## Self-review — what I am less sure about

- **Never shrinking applies outside a chapter too.** With no chapter open, a shorter
  JSON now leaves the trailing pages in place instead of replacing the document. That
  path is effectively unreachable in the shipped app (the editor is only routed to with
  a chapter open), and the toast says what happened, but it is a behaviour change beyond
  the strict scope of the finding. I preferred one rule over two.
- **Reaching for `markUnsaved()` in the importer.** It is right — the import is an edit —
  but it means a JSON import now schedules a write 800 ms later where before nothing was
  scheduled. If the import is somehow wrong, it reaches disk sooner than it used to. I
  judged "saved like any other edit" to be the safer default, since the alternative was
  relying on a flush the user does not know is coming.
- **`owns()` gating results on `library.root`.** If some future caller changes the root
  and never rescans, the newest scan's results are dropped and the previous catalogue
  stays on screen (with `loading` correctly cleared). Every current caller — Settings
  and the retry button — scans immediately after `setRoot`, so this cannot bite today,
  but it is a live coupling worth knowing about.
- **`rename` semantics.** I relied on POSIX rename-over-existing being atomic, which
  holds for APFS/HFS+ and for `tauri-plugin-fs`'s `std::fs::rename`. I did not verify
  behaviour on a network share or an exFAT volume — out of scope for this slice, since
  the library root is required to be inside `$HOME`.
- **The GUI was never observed.** The strongest claim I can make about the packaged
  build is that it compiled, bundled and launched from this worktree under a unique
  name and identifier. Everything about *behaviour* comes from the shipped modules run
  against a real filesystem, not from clicking the app.
- **`fsx.rename` is not exposed on the facade** — the rename only exists inside
  `writeTextFileAtomic`. That keeps the surface small and keeps "every filesystem call
  goes through `fsx`" true, but a future caller wanting a rename will have to add it.
