import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A filesystem that can be told to die partway through, so "what does the
// target hold afterwards?" has an answer. `mode`:
//   'ok'       - everything works
//   'truncate' - the write flushes a prefix and then the device goes away
//   'rename'   - the write lands, the rename does not
// `ops` is the order the steps actually happened in, which is the only way to
// see that the sync lands BETWEEN the write and the rename.
// `fsync`: 'ok' - the command answers; 'hang' - it never does, the way a wedged
// cloud-sync volume behaves.
const h = vi.hoisted(() => ({
  disk: new Map(),
  writes: [],
  ops: [],
  mode: 'ok',
  fsync: 'ok',
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  async writeTextFile(p, contents) {
    h.writes.push(p);
    h.ops.push('write');
    if (h.mode === 'truncate') {
      h.disk.set(p, contents.slice(0, Math.floor(contents.length / 2)));
      throw new Error('the volume went away');
    }
    h.disk.set(p, contents);
  },
  async writeFile(p, bytes) {
    h.writes.push(p);
    h.ops.push('write');
    h.disk.set(p, bytes);
  },
  async rename(from, to) {
    h.ops.push('rename');
    if (h.mode === 'rename') throw new Error('rename failed');
    if (!h.disk.has(from)) throw new Error('ENOENT ' + from);
    h.disk.set(to, h.disk.get(from));
    h.disk.delete(from);
  },
  async remove(p) {
    h.disk.delete(p);
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke(cmd) {
    h.ops.push(cmd);
    // Never settles. The point of the test: the save must finish anyway.
    if (h.fsync === 'hang') return new Promise(() => {});
    return Promise.resolve();
  },
}));

const { fsx, setFsyncTimeout } = await import('./fsx.js');

const TARGET = '/lib/series/001/chapter.json';
const GOOD = JSON.stringify({ schema: 1, pages: [{ id: 1, boxes: [{ id: 'b1' }] }] });
const NEXT = JSON.stringify({ schema: 1, pages: [{ id: 1, boxes: [{ id: 'b1' }, { id: 'b2' }] }] });

const temps = () => [...h.disk.keys()].filter((p) => p !== TARGET);

beforeEach(() => {
  h.disk.clear();
  h.writes.length = 0;
  h.ops.length = 0;
  h.mode = 'ok';
  h.fsync = 'ok';
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

  // The library sweeps `.<n>.tmp` files out of the directories it reads, which
  // is only safe because it can tell a leftover from a write still in progress.
  // This is the only thing that can answer that: the names are minted here and
  // exist nowhere else until the rename lands.
  describe('the live temp set', () => {
    it('claims a temp name for exactly the length of the write', async () => {
      expect(fsx.liveTemps().size).toBe(0);
      let during = null;
      const write = fsx.writeTextFileAtomic(TARGET, NEXT);
      during = fsx.liveTemps();
      expect(during.size).toBe(1);
      expect([...during][0].startsWith(TARGET + '.')).toBe(true);
      await write;
      expect(fsx.liveTemps().size).toBe(0);
    });

    it('gives the name back when the write fails', async () => {
      h.mode = 'truncate';
      await expect(fsx.writeTextFileAtomic(TARGET, NEXT)).rejects.toThrow();
      expect(fsx.liveTemps().size).toBe(0);
    });

    it('hands out a copy, so nothing outside can unclaim a live write', async () => {
      const write = fsx.writeTextFileAtomic(TARGET, NEXT);
      fsx.liveTemps().clear();
      expect(fsx.liveTemps().size).toBe(1);
      await write;
    });
  });
});

// The durability half of the write, and the freeze it used to be able to cause.
// `fsync_path` is a Tauri command, so it only runs when there is a host to
// invoke it on - which is why every test above sees none of this.
describe('the fsync bound', () => {
  let warn;
  let restore;

  beforeEach(() => {
    globalThis.window = { __TAURI_INTERNALS__: {} };
    // Far below the real five seconds: no suite may wait a wedged volume out.
    restore = setFsyncTimeout(5);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    setFsyncTimeout(restore);
    warn.mockRestore();
    delete globalThis.window;
  });

  it('waits for a sync that answers, and does it before the rename', async () => {
    await fsx.writeTextFileAtomic(TARGET, NEXT);
    // The temp file is flushed before it is renamed over the target, and the
    // directory entry after - see `fsync` for why that order is the whole point.
    expect(h.ops).toEqual(['write', 'fsync_path', 'rename', 'fsync_path']);
    expect(h.disk.get(TARGET)).toBe(NEXT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('completes the write anyway when the sync never answers', async () => {
    h.fsync = 'hang';
    const started = Date.now();
    // No `expect(...).resolves` dance: the failure this guards against is the
    // one where this line never returns at all.
    await fsx.writeTextFileAtomic(TARGET, NEXT);
    // The atomic pair still ran, so the target holds the new contents whole and
    // no temp file is left behind - only the durability was given up.
    expect(h.disk.get(TARGET)).toBe(NEXT);
    expect(temps()).toEqual([]);
    expect(h.ops).toEqual(['write', 'fsync_path', 'rename', 'fsync_path']);
    // It waited for the bound rather than skipping the sync outright.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
    // Degraded, and said so - once per abandoned sync.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/fsync did not answer/);
  });

  it('does the same for the binary write', async () => {
    h.fsync = 'hang';
    await fsx.writeFileAtomic(TARGET, new Uint8Array([1, 2, 3]));
    expect(h.disk.has(TARGET)).toBe(true);
    expect(fsx.liveTemps().size).toBe(0);
  });

  it('leaves the save queue free: a stalled write does not hold the next one up', async () => {
    h.fsync = 'hang';
    // Two writes back to back is the shape of the autosave chain in
    // library.svelte.js - each awaits the last, so one unbounded sync would
    // stop every save after it for the life of the session.
    await fsx.writeTextFileAtomic(TARGET, NEXT);
    await fsx.writeTextFileAtomic(TARGET, GOOD);
    expect(h.disk.get(TARGET)).toBe(GOOD);
    expect(fsx.liveTemps().size).toBe(0);
  });
});
