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
  const PATH = '/lib/proj/ch1/logs/history.json';
  const anEntry = (x) => ({
    t: 'move',
    pageId: 1,
    boxId: 'b1',
    before: { x: 0, y: 0 },
    after: { x, y: x },
  });

  beforeEach(async () => {
    const { files } = await import('../fsx.js');
    files.clear();
  });

  it('writes what it was given and reads it back', async () => {
    const { __setDir, switchHistoryPage, flushHistory } = await import('./history-file.svelte.js');
    const { record, history } = await import('./history.svelte.js');
    __setDir('/lib/proj/ch1');
    record({ t: 'move', pageId: 1, boxId: 'b1', before: { x: 0, y: 0 }, after: { x: 1, y: 1 } });
    await switchHistoryPage(1, 2);
    expect(history.canUndo).toBe(false);
    await switchHistoryPage(2, 1);
    expect(history.canUndo).toBe(true);
    await flushHistory();
    const { files } = await import('../fsx.js');
    expect(files.has(PATH)).toBe(true);
  });

  // The whole point of the file: the stack of a page nobody is looking at is
  // still there after the app has been shut down and started again.
  it('restores a page stack written by an earlier run', async () => {
    const { files } = await import('../fsx.js');
    files.set(PATH, JSON.stringify({ version: 1, pages: { 3: { undo: [anEntry(5)], redo: [] } } }));
    const { openHistory } = await import('./history-file.svelte.js');
    const { history } = await import('./history.svelte.js');
    await openHistory('/lib/proj/ch1', 3);
    expect(history.canUndo).toBe(true);
    expect(history.pageId).toBe(3);
  });

  it('opens with no history rather than failing on a corrupt file', async () => {
    const { files } = await import('../fsx.js');
    files.set(PATH, '{ this is not json');
    const { openHistory } = await import('./history-file.svelte.js');
    const { history } = await import('./history.svelte.js');
    await expect(openHistory('/lib/proj/ch1', 3)).resolves.toBeUndefined();
    expect(history.canUndo).toBe(false);
  });

  // Closing hands the live page's stack over on the way out, so an edit made and
  // never followed by a page turn is still on disk next time.
  it('flushes the live page on close and then forgets the chapter', async () => {
    const { __setDir, closeHistory, flushHistory } = await import('./history-file.svelte.js');
    const { record, history } = await import('./history.svelte.js');
    const { files } = await import('../fsx.js');
    __setDir('/lib/proj/ch1');
    record(anEntry(4));
    await closeHistory(1);
    expect(history.canUndo).toBe(false);
    expect(JSON.parse(files.get(PATH)).pages['1'].undo.length).toBe(1);
    // No chapter is open any more, so a late debounce writes nothing at all.
    files.clear();
    await flushHistory();
    expect(files.size).toBe(0);
  });

  it('survives a disk that refuses', async () => {
    const { fsx } = await import('../fsx.js');
    const boom = vi.spyOn(fsx, 'writeTextFileAtomic').mockRejectedValue(new Error('read-only'));
    const { __setDir, flushHistory } = await import('./history-file.svelte.js');
    __setDir('/lib/proj/ch1');
    await expect(flushHistory()).resolves.toBeUndefined();
    boom.mockRestore();
  });
});
