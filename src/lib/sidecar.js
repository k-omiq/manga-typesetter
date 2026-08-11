// Frontend bridge to the Python sidecar.
//
// Under Tauri we go through the Rust `sidecar_health` command (Rust owns the
// process lifecycle). In a plain browser (vite dev / preview) there's no Tauri
// runtime, so these become no-ops and the app degrades to manual workflows.

import { app, page, applyDetection, toast } from './store.svelte.js';

// app.sidecar is initialized lazily so older saved state stays compatible.
function ensureState() {
  if (!app.sidecar) app.sidecar = { status: 'unknown', device: null, info: null };
  return app.sidecar;
}

let invokeFn = null;
async function getInvoke() {
  if (invokeFn) return invokeFn;
  // Tauri injects __TAURI_INTERNALS__; absent in the browser.
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  const mod = await import('@tauri-apps/api/core');
  invokeFn = mod.invoke;
  return invokeFn;
}

export function sidecarReady() {
  return app.sidecar?.status === 'ok';
}

// Run detection + OCR on an image URL (object URL or asset URL). Returns the
// sidecar payload { img_width, img_height, panels, lines:[{n,type,jp,en,box,vertical,font_size}] }
// or throws. Requires Tauri + a healthy sidecar.
export async function analyzeImage(imageUrl, { ocr = true } = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('sidecar unavailable (no Tauri runtime)');
  const buf = await (await fetch(imageUrl)).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return invoke('sidecar_analyze', { image: bytes, ocr });
}

// Detect + OCR one page object and apply results to it. Returns { lines } on
// success or { error } on failure. Shared by the single-page and whole-chapter
// paths. Pins the write to `p` — detection may resolve after the user navigates.
async function detectOnePage(p, { ocr = true } = {}) {
  if (!p?.raw) return { skipped: true };
  try {
    const result = await analyzeImage(p.raw, { ocr });
    applyDetection(result, p);
    return { lines: result.lines.length };
  } catch (e) {
    return { error: String(e) };
  }
}

// Orchestrates detection for the current page's raw image and applies results.
export async function detectCurrentPage({ ocr = true } = {}) {
  const p = page();
  if (!p?.raw) {
    toast('No raw page to detect — import a raw image first');
    return;
  }
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  app.detecting = true;
  try {
    const r = await detectOnePage(p, { ocr });
    if (r.error) toast(`Detection failed: ${r.error}`);
    else toast(`Detected ${r.lines} text region(s)`);
  } finally {
    app.detecting = false;
  }
}

// Detect + OCR every loaded raw page, in order. Runs one page at a time so the
// sidecar isn't hammered with concurrent requests; the model stays warm across
// pages. Pages without a raw image are skipped.
export async function detectAllPages({ ocr = true } = {}) {
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  const targets = app.pages.filter((p) => p?.raw);
  if (!targets.length) {
    toast('No raw pages to detect — import raw images first');
    return;
  }
  app.detecting = true;
  app.detectBatch = { done: 0, total: targets.length };
  let linesTotal = 0;
  let failed = 0;
  try {
    for (const p of targets) {
      const r = await detectOnePage(p, { ocr });
      if (r.error) failed++;
      else linesTotal += r.lines ?? 0;
      app.detectBatch = { done: app.detectBatch.done + 1, total: targets.length };
    }
    toast(
      `Detected ${targets.length} page(s) · ${linesTotal} text region(s)` +
        (failed ? ` · ${failed} page(s) failed` : ''),
    );
  } finally {
    app.detecting = false;
    app.detectBatch = null;
  }
}

// ---- model cache (Settings) -----------------------------------------------

// Report the on-disk size/location of the downloaded model caches. Returns
// { entries:[{path,exists,bytes}], total_bytes } or null when Tauri/the sidecar
// isn't available (browser preview).
export async function modelsCacheInfo() {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke('sidecar_models_cache');
  } catch {
    return null;
  }
}

// Delete the downloaded model weights to free disk. Returns the sidecar's
// { ok, cleared, freed_bytes, errors } result, or throws.
export async function clearModelsCache() {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('sidecar unavailable (no Tauri runtime)');
  return invoke('sidecar_models_cache_clear');
}

// ---- sidecar lifecycle (Settings) -----------------------------------------

// Restart the Python sidecar child, then re-poll health. No-op in the browser
// (nothing to restart).
export async function restartSidecar() {
  const invoke = await getInvoke();
  if (!invoke) {
    toast('Sidecar restart needs the desktop app');
    return;
  }
  const s = ensureState();
  s.status = 'unknown';
  toast('Restarting sidecar…');
  try {
    await invoke('sidecar_restart');
    await checkSidecar(); // polls /health until it comes back (up to ~30s)
    toast(sidecarReady() ? 'Sidecar restarted' : 'Sidecar restart failed — see logs');
  } catch (e) {
    s.status = 'error';
    toast(`Sidecar restart failed: ${e}`);
  }
}

// Returns the /health payload, or null when the sidecar/Tauri isn't available.
export async function checkSidecar() {
  const s = ensureState();
  const invoke = await getInvoke();
  if (!invoke) {
    s.status = 'unavailable';
    return null;
  }
  try {
    const health = await invoke('sidecar_health');
    s.status = 'ok';
    s.device = health.device ?? null;
    s.info = health;
    return health;
  } catch (e) {
    s.status = 'error';
    s.info = String(e);
    return null;
  }
}
