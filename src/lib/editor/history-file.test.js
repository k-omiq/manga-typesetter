import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeStack, stackFrom, emptyDoc } from './history-file.svelte.js';

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

describe('the file on disk', () => {
  const CH1 = '/lib/proj/ch1';
  const CH2 = '/lib/proj/ch2';
  const PATH = `${CH1}/logs/history.json`;
  const PATH2 = `${CH2}/logs/history.json`;

  // A record for page 1, distinguishable from the next one.
  const anEntry = (x) => ({
    t: 'move',
    pageId: 1,
    boxId: 'b1',
    before: { x: 0, y: 0 },
    after: { x, y: x },
  });

  const undoCount = (files, path, key) => JSON.parse(files.get(path)).pages[key].undo.length;

  const mod = () => import('./history-file.svelte.js');
  const hist = () => import('./history.svelte.js');
  const disk = () => import('../fsx.js');

  // Every test starts from a closed chapter, an empty stack and an empty disk —
  // the module keeps all three across a test file.
  beforeEach(async () => {
    const { __setDir } = await mod();
    const { resetHistory } = await hist();
    const { files } = await disk();
    __setDir(null);
    resetHistory();
    files.clear();
  });

  it('writes what it was given and reads it back', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 1, y: 1 } });
    await switchHistoryPage(1, 2);
    expect(history.canUndo).toBe(false);
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
    await flushHistory();
    expect(undoCount(files, PATH, '1')).toBe(1);
  });

  // The mechanism that saves an edit made and then abandoned: no page turn, no
  // close, just a record and the clock.
  it('writes on its own debounce, with no page turn to prompt it', async () => {
    const { __setDir } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    vi.useFakeTimers();
    try {
      __setDir(CH1);
      record(anEntry(7));
      expect(files.has(PATH)).toBe(false);
      await vi.advanceTimersByTimeAsync(800);
      expect(undoCount(files, PATH, '1')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole point of the file: the stack of a page nobody is looking at is
  // still there after the app has been shut down and started again.
  it('restores a page stack written by an earlier run', async () => {
    const { files } = await disk();
    files.set(PATH, JSON.stringify({ version: 1, pages: { 3: { undo: [anEntry(5)], redo: [] } } }));
    const { openHistory } = await mod();
    const { history } = await hist();
    await openHistory(CH1, 3);
    expect(history.canUndo).toBe(true);
    expect(history.pageId).toBe(3);
  });

  it('opens with no history rather than failing on a corrupt file', async () => {
    const { files } = await disk();
    files.set(PATH, '{ this is not json');
    const { openHistory } = await mod();
    const { history } = await hist();
    await expect(openHistory(CH1, 3)).resolves.toBeUndefined();
    expect(history.canUndo).toBe(false);
  });

  // The chapter being left is flushed before anything is reset. Without it, a
  // chapter switched away from inside the debounce window loses its records
  // with nothing having failed.
  it('flushes the chapter it is leaving rather than dropping its records', async () => {
    const { __setDir, openHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(2));
    expect(files.has(PATH)).toBe(false); // still inside the debounce window
    await openHistory(CH2, 1);
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
  });

  // A route re-entry lands on the chapter already open. It resets the document
  // just as hard as a switch does, so it has to write first.
  it('flushes before a reopen of the chapter already open', async () => {
    const { __setDir, openHistory, switchHistoryPage } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(9));
    expect(files.has(PATH)).toBe(false);
    await openHistory(CH1, 2);
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
    // And the records came back with the reopened chapter, not merely survived
    // on disk.
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
  });

  // A write bound to the chapter it was started for. Read live under the awaits,
  // the path would come from one chapter and the body from the next.
  it('keeps a write in flight bound to the chapter that started it', async () => {
    const { __setDir, openHistory, flushHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(3));
    const pending = flushHistory(); // in flight, deliberately not awaited yet
    await openHistory(CH2, 1);
    await pending;
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1); // not the empty document
    expect(files.has(PATH2)).toBe(false); // and nothing of ch2's in ch1's file
  });

  // Closing hands the live page's stack over on the way out, and it does not
  // need to be told which page that is.
  it('saves the live page on close even when the caller names no page', async () => {
    const { __setDir, closeHistory, flushHistory } = await mod();
    const { record, history } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(4));
    await closeHistory();
    expect(files.has(PATH)).toBe(true);
    expect(undoCount(files, PATH, '1')).toBe(1);
    expect(history.canUndo).toBe(false);
    // No chapter is open any more, so a late debounce writes nothing at all.
    files.clear();
    await flushHistory();
    expect(files.size).toBe(0);
  });

  it('files the live page under its own key when the page turn does not say', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await mod();
    const { record } = await hist();
    const { files } = await disk();
    __setDir(CH1);
    record(anEntry(6));
    await switchHistoryPage(undefined, 2);
    await flushHistory();
    expect(Object.keys(JSON.parse(files.get(PATH)).pages)).toEqual(['1']);
  });

  it('survives a disk that refuses', async () => {
    const { fsx } = await disk();
    const boom = vi.spyOn(fsx, 'writeTextFileAtomic').mockRejectedValue(new Error('read-only'));
    const { __setDir, flushHistory } = await mod();
    __setDir(CH1);
    await expect(flushHistory()).resolves.toBeUndefined();
    // The queue survives it: the next write still lands.
    boom.mockRestore();
    const { files } = await disk();
    await flushHistory();
    expect(files.has(PATH)).toBe(true);
  });
});
