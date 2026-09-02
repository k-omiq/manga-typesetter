// ===== The brush picker's pure parts =====
//
// Everything the panel's grid does that is not drawing: which brushes a search
// shows, what applying one to the tool means, and what the import says out
// loud. Out here rather than inside `BrushPanel.svelte` because the panel is a
// component and this project's tests run in node with no DOM - the rules a
// letterer actually notices should be testable without one.
//
// Nothing here touches the library or the tool. The panel reads them and hands
// the values in, so the same functions serve a stubbed list in a test and the
// real `installedBrushes` in the app.

// A name reduced to what a search should match: case and whitespace are noise.
// A letterer typing "boro" for "ボロ文字_ 5" or "battle pen" for "BattlePen"
// means the same brush either way.
//
// Deliberately not a fold over accents or kana: the corpus is Japanese sub tool
// names, and a half-clever normalisation that folded カ to か would be wrong as
// often as it was right. Case and space are the two that are always noise.
export function brushSearchKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

// The brushes a query shows, in the order they were given. An empty or
// whitespace-only query shows everything, which is what an untouched field
// should do.
//
// Every word of the query has to appear in the name, and they may appear in any
// order. One substring over the whole query would have been shorter, but
// "battle pen" would then find nothing in a library holding "Battle Letter Pen"
// - and a letterer typing two words they remember is the search this field is
// for. The words are matched against the name with ITS spaces removed too, so
// "moji" still finds "Moji A2".
export function filterBrushes(list, query) {
  const all = Array.isArray(list) ? list : [];
  const words = String(query ?? '')
    .trim()
    .split(/\s+/)
    .map(brushSearchKey)
    .filter(Boolean);
  if (!words.length) return all.slice();
  return all.filter((b) => {
    const name = brushSearchKey(b?.name);
    return words.every((w) => name.includes(w));
  });
}

// Picking a brush in the grid, as one value.
//
// THE CONTRACT (2.3, `sanitiseBrushSettings`): an imported brush speaks for the
// tip and the marks it makes, and for nothing else. Its `settings` deliberately
// carry no `color`, so this spread leaves the letterer's ink colour exactly
// where they set it and replaces only what the `.sut` had an opinion about.
// `postCorrect` joined the conditional keys when `BrushRevision` was read: a
// brush that states one carries it, an older index row does not.
//
// `dyn` was on that list until phase 6.1 decoded the `Effector` blobs, and it is
// the reason this stayed a spread rather than a merge: a brush that names a size
// driver now carries `dyn` and REPLACES the tool's, and one whose blob said
// nothing still carries no such key, so the letterer's own dynamics survive
// untouched. Neither case needs anything here - absence is the fallback.
//
// The built-in round tip has no settings of its own: picking it swaps the tip
// and changes nothing else, which is how a letterer gets back to a plain pen
// without losing the size they had just dialled in.
export function pickedSettings(settings, entry) {
  const base = settings && typeof settings === 'object' ? settings : {};
  const from = entry?.settings && typeof entry.settings === 'object' ? entry.settings : null;
  const id = typeof entry?.id === 'string' && entry.id ? entry.id : base.brush;
  return from ? { ...base, ...from, brush: id } : { ...base, brush: id };
}

// A brush's true pixel size, for the row under the grid. Empty for the round
// tip, which has no pixels - it is drawn, not stored.
export function tipDims(entry) {
  const w = Math.round(Number(entry?.width));
  const h = Math.round(Number(entry?.height));
  if (!(w > 0 && h > 0)) return '';
  return `${w} × ${h}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the toast says after an import.
//
// The counts first, because they are the answer to what was just asked, and the
// failures after a dash - the shape the rest of the app's summaries already use
// ("Saved 12 slice(s) - 2 cut(s) had no gap to land in"). One bad file in six
// installs the five and says so; it does not report six failures.
//
// A single failure shows its own message rather than a count, because with one
// file the message IS the useful part: "the browser preview cannot read .sut
// files" tells a letterer what to do and "1 file could not be imported" does
// not.
export function importSentence(result) {
  const added = Math.max(0, Math.trunc(Number(result?.added)) || 0);
  const preview = Math.max(0, Math.trunc(Number(result?.previewQuality)) || 0);
  const errors = Array.isArray(result?.errors) ? result.errors : [];

  let head;
  if (added) {
    head = plural(added, 'brush added', 'brushes added');
    if (preview) head += `, ${preview} at preview quality`;
  } else {
    head = errors.length ? 'No brushes added' : 'Nothing to add - those files hold no brushes';
  }
  if (!errors.length) return head;
  if (errors.length === 1) {
    const one = String(errors[0]?.error ?? '').trim();
    return one ? `${head} - ${one}` : `${head} - 1 file could not be imported`;
  }
  return `${head} - ${plural(errors.length, 'file', 'files')} could not be imported`;
}
