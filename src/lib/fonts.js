// Real user-font loading: FontFace registration + IndexedDB persistence.
import { app, toast } from './store.svelte.js';

const DB_NAME = 'manga-typesetter';
const STORE = 'fonts';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

async function dbDelete(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function cleanName(filename) {
  return filename.replace(/\.(ttf|otf|woff2?|ttc)$/i, '').replace(/[_-]+/g, ' ').trim();
}

async function registerFace(name, data) {
  const face = new FontFace(name, data instanceof ArrayBuffer ? data : await data.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  return face;
}

// Restore persisted user fonts on startup.
export async function restoreFonts() {
  if (typeof indexedDB === 'undefined') return;
  let records = [];
  try {
    records = await dbGetAll();
  } catch {
    return;
  }
  for (const rec of records) {
    try {
      await registerFace(rec.name, rec.data);
      if (!app.fonts.user.some((f) => f.name === rec.name)) {
        app.fonts.user.push({ name: rec.name, css: `'${rec.name}'`, file: rec.file, real: true });
      }
    } catch {
      /* skip bad font */
    }
  }
}

// Add a user font from a File (.ttf/.otf/.woff2).
export async function addFontFile(file) {
  const name = cleanName(file.name);
  if (app.fonts.builtin.some((f) => f.name === name) || app.fonts.user.some((f) => f.name === name)) {
    toast(`Font "${name}" already loaded`);
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    await registerFace(name, buf);
    await dbPut({ name, file: file.name, data: buf });
    app.fonts.user.push({ name, css: `'${name}'`, file: file.name, real: true });
    toast(`Added font "${name}"`);
  } catch (e) {
    toast(`Could not load "${file.name}" — unsupported or corrupt`);
  }
}

export async function removeUserFont(name) {
  app.fonts.user = app.fonts.user.filter((f) => f.name !== name);
  try {
    await dbDelete(name);
  } catch {
    /* ignore */
  }
  toast('Font removed');
}
