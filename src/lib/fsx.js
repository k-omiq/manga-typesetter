// ===== Filesystem facade =====
// Every library filesystem call goes through here. One seam to mock in tests,
// and the Tauri plugins stay lazily imported (same pattern as importer.js).

let fsMod = null;
let pathMod = null;

async function fs() {
  if (!fsMod) fsMod = await import('@tauri-apps/plugin-fs');
  return fsMod;
}

async function path() {
  if (!pathMod) pathMod = await import('@tauri-apps/api/path');
  return pathMod;
}

// Temp names are unique per write. Two writes to one path can overlap (the
// debounced autosave and a flush both landing on chapter.json), and one
// clearing up after itself must never delete the other's half-written file.
let tmpSeq = 0;

export const fsx = {
  async readDir(p) {
    return (await fs()).readDir(p);
  },
  async readTextFile(p) {
    return (await fs()).readTextFile(p);
  },
  async writeTextFile(p, contents) {
    return (await fs()).writeTextFile(p, contents);
  },
  // The record files are rewritten every 800ms while the user types, and a
  // crash or a power cut partway through a plain write leaves truncated JSON —
  // which the scan reports as "Unreadable" and openChapter refuses, losing the
  // whole chapter's typesetting. Written to a temp file and renamed over the
  // target instead: rename within a directory is atomic on the filesystems this
  // app targets, so the target only ever holds the old contents or the new.
  //
  // The temp file is the target's own path plus a suffix, so it is a file, in
  // the same directory, by construction — never a directory, and the scan only
  // ever looks at directory entries, so a leftover cannot be mistaken for a
  // project or a chapter. It is removed on any failure regardless.
  async writeTextFileAtomic(p, contents) {
    const m = await fs();
    const tmp = `${p}.${++tmpSeq}.tmp`;
    try {
      await m.writeTextFile(tmp, contents);
      await m.rename(tmp, p);
    } catch (e) {
      try {
        await m.remove(tmp);
      } catch {
        /* it may never have been created; the original is intact either way */
      }
      throw e;
    }
  },
  async readFile(p) {
    return (await fs()).readFile(p);
  },
  async writeFile(p, bytes) {
    return (await fs()).writeFile(p, bytes);
  },
  async writeFileAtomic(p, bytes) {
    const m = await fs();
    const tmp = `${p}.${++tmpSeq}.tmp`;
    try {
      await m.writeFile(tmp, bytes);
      await m.rename(tmp, p);
    } catch (e) {
      try {
        await m.remove(tmp);
      } catch {
        /* it may never have been created; the original is intact either way */
      }
      throw e;
    }
  },
  async mkdir(p) {
    return (await fs()).mkdir(p, { recursive: true });
  },
  async remove(p) {
    return (await fs()).remove(p, { recursive: true });
  },
  async exists(p) {
    return (await fs()).exists(p);
  },
  async join(...parts) {
    return (await path()).join(...parts);
  },
  async homeDir() {
    return (await path()).homeDir();
  },
};
