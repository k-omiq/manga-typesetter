[src/lib/importer.js:64](file:///Users/caved/dev/manga-typesetter/src/lib/importer.js#L64) — **HIGH** — `normalizeTranslations` crashes if `data` is `null`, `undefined`, or if `data.pages` is an object rather than an array.
- **Failure scenario**: Passing `null`, `undefined`, or a translation JSON structured as `{ pages: { "1": [...] } }` throws an unhandled `TypeError` (`Cannot read properties of null` or `rawPages.map is not a function`).
- **One-line fix**: `const rawPages = Array.isArray(data) ? (data.length && (data[0]?.texts || data[0]?.lines || data[0]?.page != null) ? data : [{ texts: data }]) : Array.isArray(data?.pages) ? data.pages : (data?.texts || data?.lines) ? [data] : [{ texts: [] }];`

[src/lib/importer.js:27](file:///Users/caved/dev/manga-typesetter/src/lib/importer.js#L27) — **HIGH** — `normLine` crashes if a line entry within a `texts` or `lines` array is `null` or `undefined`.
- **Failure scenario**: Importing `{ texts: ["Dialogue", null] }` or `[null]` throws an unhandled `TypeError: Cannot read properties of null (reading 'n')`.
- **One-line fix**: `if (!item || typeof item !== 'object') return typeof item === 'string' ? { n: idx + 1, jp: '', en: item, type: 'dialogue' } : { n: idx + 1, jp: '', en: '', type: 'dialogue' };`

[src/lib/importer.js:62](file:///Users/caved/dev/manga-typesetter/src/lib/importer.js#L62) — **HIGH** — `normalizeTranslations` misidentifies page arrays using `text_lines`, `items`, or `translations` keys as line arrays, discarding all translations.
- **Failure scenario**: An array of pages formatted as `[{ text_lines: [{ text: "Hello" }] }]` fails the `data[0].texts || data[0].lines || data[0].page != null` check, gets wrapped into `[{ texts: data }]`, and causes `normLine` to treat page objects as lines and drop all text.
- **One-line fix**: `if (data.length && (data[0]?.texts || data[0]?.lines || data[0]?.text_lines || data[0]?.items || data[0]?.translations || data[0]?.page != null)) rawPages = data;`

[src/lib/importer.js:36](file:///Users/caved/dev/manga-typesetter/src/lib/importer.js#L36) — **MEDIUM** — `normLine` causes line number collisions when input lines have `n: 0` or `id: 0` because `Number(0)` is falsy.
- **Failure scenario**: 0-indexed translations `[{ n: 0, en: "Line 0" }, { n: 1, en: "Line 1" }]` evaluate `Number(0) || 1 -> 1` and `Number(1) || 2 -> 1`, assigning `n: 1` to both lines and making Line 1 unreachable in `lineByN`.
- **One-line fix**: `n: Number.isFinite(Number(n)) ? Number(n) : idx + 1,`

[src/lib/importer.js:32](file:///Users/caved/dev/manga-typesetter/src/lib/importer.js#L32) — **MEDIUM** — `normLine` lets empty string fields (`en: ""` or `jp: ""`) shadow valid translation fallback fields due to nullish coalescing.
- **Failure scenario**: A JSON carrying `{ en: "", natural: "Translated" }` or `{ jp: "", original: "日本語" }` evaluates `"" ?? "Translated"` to `""`, silently losing the translation text.
- **One-line fix**: `const en = (item.en || item.natural || item.stylised || item.stylized || legacy) ?? '';`

[src/lib/fonts.js:165](file:///Users/caved/dev/manga-typesetter/src/lib/fonts.js#L165) — **MEDIUM** — `parsePostScriptName` corrupts UTF-16BE name records with odd byte lengths by appending `\uFFFD`.
- **Failure scenario**: In standard browsers/Node, `new TextDecoder('utf-16be').decode(slice)` does not throw on odd lengths when `fatal: false`; it emits `\uFFFD` (e.g. `"Arial-BoldMT\uFFFD"`), preventing Photoshop from matching the font.
- **One-line fix**: `const even = slice.subarray(0, slice.length - (slice.length % 2)); str = new TextDecoder('utf-16be').decode(even);`

[src/lib/fonts.js:554](file:///Users/caved/dev/manga-typesetter/src/lib/fonts.js#L554) — **MEDIUM** — `restoreFonts` race condition clobbers user font additions or replacements made while startup restoration is in flight.
- **Failure scenario**: If a user drops a new font file while `restoreFonts()` is yielding during sequential `registerFace` calls on startup, `restoreFonts()` does not check if the slot is already occupied and overwrites the user's newly added face with stale IndexedDB bytes.
- **One-line fix**: `if (app.fonts.builtin.some((f) => f.name === rec.name) || app.fonts.user.some((f) => f.name === rec.name && f.faces?.[slot])) continue;`
