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
// sidecar payload { img_width, img_height, lines:[{n,type,jp,en,box,vertical,font_size}], mask_png }
// or throws. Requires Tauri + a healthy sidecar.
export async function analyzeImage(imageUrl, { ocr = true } = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('sidecar unavailable (no Tauri runtime)');
  const buf = await (await fetch(imageUrl)).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return invoke('sidecar_analyze', { image: bytes, ocr });
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
    const result = await analyzeImage(p.raw, { ocr });
    applyDetection(result);
    toast(`Detected ${result.lines.length} text region(s)`);
  } catch (e) {
    toast(`Detection failed: ${e}`);
  } finally {
    app.detecting = false;
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
