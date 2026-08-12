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
  async readFile(p) {
    return (await fs()).readFile(p);
  },
  async writeFile(p, bytes) {
    return (await fs()).writeFile(p, bytes);
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
