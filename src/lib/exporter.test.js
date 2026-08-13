import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app, loadProjectPages } from './store.svelte.js';
import { exportTextJson } from './exporter.js';

// exportTextJson is the single writer of the detection JSON — the detect menu
// and the export dialog both go through it — so what its two scopes select is
// worth pinning down. Everything under test here is scope arithmetic: which
// pages go in, and what the file is called.
//
// The browser-download branch is the one reachable outside Tauri, and it wants
// exactly two things this environment lacks: an anchor to click and an object
// URL to point it at. Three stubs, not a DOM: a real one would only make the
// same two facts harder to read off.
let downloaded;
const realDocument = globalThis.document;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  downloaded = [];
  globalThis.document = {
    createElement: () => ({
      click() {
        downloaded.push(this.download);
      },
    }),
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};

  app.exportName = 'ch01';
  loadProjectPages([
    { id: 11, w: 800, h: 1200, lines: [{ n: 1, jp: 'あ', en: 'ah' }], boxes: [] },
    { id: 22, w: 800, h: 1200, lines: [{ n: 1, jp: 'い', en: 'ee' }], boxes: [] },
    { id: 33, w: 800, h: 1200, lines: [], boxes: [] },
  ]);
});

afterEach(() => {
  globalThis.document = realDocument;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('exportTextJson', () => {
  it("names the whole-chapter document once, without any page's id in it", async () => {
    await exportTextJson('all');
    expect(downloaded).toEqual(['ch01-text.json']);
    // One document for three pages, not three files — the reason the export
    // dialog's 'all' still goes through the single-file save path.
    expect(app.toast.msg).toBe('Exported text for 3 page(s) as JSON (browser download)');
  });

  it('names the current-page document after the page, not after its index', async () => {
    app.pageIndex = 1;
    await exportTextJson('current');
    expect(downloaded).toEqual(['ch01-22-text.json']);
    expect(app.toast.msg).toBe('Exported text for 1 page(s) as JSON (browser download)');
  });
});
