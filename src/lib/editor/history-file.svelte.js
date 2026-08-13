// ===== The history file =====
// Only the page on screen keeps its undo stack in memory. Every other page's
// lives here, in the chapter's own directory, so a chapter with two hundred
// pages costs five entries of RAM rather than a thousand — and so undo survives
// a relaunch.
//
//   <chapter-dir>/logs/history.json
//
// History is a convenience. Nothing in this module may be able to fail an edit,
// a save or a page turn: every disk error is reported once and swallowed, and
// nothing on the document's own save path ever waits on this one.
import { fsx } from '../fsx.js';
import { toast } from '../store.svelte.js';
import { takeStack, peekStack, loadStack, resetHistory, setHistorySink } from './history.svelte.js';

export const emptyDoc = () => ({ version: 1, pages: {} });

// A document of a version this build does not know is not repaired, it is
// replaced — a file whose shape we cannot read is worth less than the undo it
// would cost to start over.
export function mergeStack(doc, pageId, stack) {
  const next =
    doc && doc.version === 1 && doc.pages ? { ...doc, pages: { ...doc.pages } } : emptyDoc();
  const key = String(pageId);
  const undo = stack?.undo ?? [];
  const redo = stack?.redo ?? [];
  // A page the user has undone their way out of leaves no key behind. Without
  // this the file only ever grows, one page at a time, for the life of the
  // chapter.
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

// Said once per chapter. A disk that refuses this file refuses it on every
// keystroke, and one lost convenience is not worth a toast a second.
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
  // Whatever is in there is replayed optimistically. An entry that no longer
  // fits the document is reported and dropped by history.svelte.js at the
  // moment it is pressed, not weeded out here — validating a stack against a
  // document would cost a walk of every page to save a message nobody may see.
  loadStack(pageId, stackFrom(doc, pageId));
}

export async function switchHistoryPage(fromPageId, toPageId) {
  if (fromPageId != null) doc = mergeStack(doc, fromPageId, takeStack());
  loadStack(toPageId, stackFrom(doc, toPageId));
  livePageId = toPageId;
  schedule();
}

// The same 800ms the document's own autosave uses, on its own timer. The two
// never wait on each other: a page turn is not held up by this write, and this
// write failing is not the document's problem.
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
    // Created on the way to the first write, never up front: a chapter nobody
    // has edited has no logs directory to explain.
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
