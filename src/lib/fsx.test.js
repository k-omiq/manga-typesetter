import { describe, it, expect, beforeEach, vi } from 'vitest';

// A filesystem that can be told to die partway through, so "what does the
// target hold afterwards?" has an answer. `mode`:
//   'ok'       - everything works
//   'truncate' - the write flushes a prefix and then the device goes away
//   'rename'   - the write lands, the rename does not
const h = vi.hoisted(() => ({ disk: new Map(), writes: [], mode: 'ok' }));

vi.mock('@tauri-apps/plugin-fs', () => ({
  async writeTextFile(p, contents) {
    h.writes.push(p);
    if (h.mode === 'truncate') {
      h.disk.set(p, contents.slice(0, Math.floor(contents.length / 2)));
      throw new Error('the volume went away');
    }
    h.disk.set(p, contents);
  },
  async rename(from, to) {
    if (h.mode === 'rename') throw new Error('rename failed');
    if (!h.disk.has(from)) throw new Error('ENOENT ' + from);
    h.disk.set(to, h.disk.get(from));
    h.disk.delete(from);
  },
  async remove(p) {
    h.disk.delete(p);
  },
}));

const { fsx } = await import('./fsx.js');

const TARGET = '/lib/series/001/chapter.json';
const GOOD = JSON.stringify({ schema: 1, pages: [{ id: 1, boxes: [{ id: 'b1' }] }] });
const NEXT = JSON.stringify({ schema: 1, pages: [{ id: 1, boxes: [{ id: 'b1' }, { id: 'b2' }] }] });

const temps = () => [...h.disk.keys()].filter((p) => p !== TARGET);

beforeEach(() => {
  h.disk.clear();
  h.writes.length = 0;
  h.mode = 'ok';
  h.disk.set(TARGET, GOOD);
});

describe('writeTextFileAtomic', () => {
  it('lands the new contents and leaves no temp file behind', async () => {
    await fsx.writeTextFileAtomic(TARGET, NEXT);
    expect(h.disk.get(TARGET)).toBe(NEXT);
    expect(temps()).toEqual([]);
  });

  it('writes the temp file beside the target, never over it', async () => {
    await fsx.writeTextFileAtomic(TARGET, NEXT);
    // Same directory by construction - the target's own path plus a suffix -
    // and a file, so the scan (which only considers directory entries) can
    // never mistake a leftover for a project or a chapter.
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).not.toBe(TARGET);
    expect(h.writes[0].startsWith(TARGET + '.')).toBe(true);
    expect(h.writes[0].endsWith('.tmp')).toBe(true);
  });

  it('leaves the target untouched when the write dies partway', async () => {
    h.mode = 'truncate';
    await expect(fsx.writeTextFileAtomic(TARGET, NEXT)).rejects.toThrow('the volume went away');
    // Not truncated, not the new contents: exactly what was there before. A
    // plain writeTextFile would have left half a JSON document here, and the
    // chapter's whole typesetting with it.
    expect(h.disk.get(TARGET)).toBe(GOOD);
    expect(() => JSON.parse(h.disk.get(TARGET))).not.toThrow();
    expect(temps()).toEqual([]);
  });

  it('leaves the target untouched when the rename fails', async () => {
    h.mode = 'rename';
    await expect(fsx.writeTextFileAtomic(TARGET, NEXT)).rejects.toThrow('rename failed');
    expect(h.disk.get(TARGET)).toBe(GOOD);
    expect(temps()).toEqual([]);
  });

  it('gives concurrent writes to one path their own temp files', async () => {
    await Promise.all([
      fsx.writeTextFileAtomic(TARGET, NEXT),
      fsx.writeTextFileAtomic(TARGET, NEXT),
    ]);
    expect(new Set(h.writes).size).toBe(2);
    expect(temps()).toEqual([]);
  });
});
