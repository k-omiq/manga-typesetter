// Frontend bridge to the Python sidecar.
//
// Under Tauri we go through the Rust `sidecar_health` command (Rust owns the
// process lifecycle). In a plain browser (vite dev / preview) there's no Tauri
// runtime, so these become no-ops and the app degrades to manual workflows.

import {
  app,
  page,
  applyDetection,
  applyClean,
  setCleanStatus,
  applyTranslation,
  toast,
} from './store.svelte.js';

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
    // Pin to the page detection was launched for — the user may have navigated
    // while the sidecar ran (mirrors clean/translate's target pattern).
    applyDetection(result, p);
    toast(`Detected ${result.lines.length} text region(s)`);
  } catch (e) {
    toast(`Detection failed: ${e}`);
  } finally {
    app.detecting = false;
  }
}

// ---- cleaning -------------------------------------------------------------

// Smart-clean an image's regions. Returns { img_width, img_height, layers:[...] }.
// regions = [{ n, box, method? }]; mask = base64 text mask from /analyze (optional,
// re-detected server-side when absent). method = default OpenCV inpaint flavour.
export async function cleanImage(imageUrl, regions, { mask = '', method = 'telea', flux = false } = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('sidecar unavailable (no Tauri runtime)');
  const buf = await (await fetch(imageUrl)).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return invoke('sidecar_clean', {
    image: bytes,
    regions: JSON.stringify(regions),
    maskPng: mask,
    method,
    flux,
  });
}

// Clean every detected region on the current page and apply the patch layers.
export async function cleanCurrentPage({ method = 'telea', flux = false } = {}) {
  const p = page();
  if (!p?.raw) {
    toast('No raw page to clean — import a raw image first');
    return;
  }
  const regions = (p.detect?.boxes ?? []).map((b) => ({ n: b.n, box: b.box }));
  if (!regions.length) {
    toast('Run Detect first — no text regions');
    return;
  }
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  app.cleaning = true;
  for (const r of regions) setCleanStatus(r.n, 'cleaning');
  try {
    const result = await cleanImage(p.raw, regions, { mask: p.clean?.maskPng ?? '', method, flux });
    applyClean(result, { target: p });
    toast(`Cleaned ${result.layers.length} region(s)`);
  } catch (e) {
    for (const r of regions) setCleanStatus(r.n, 'error');
    toast(`Clean failed: ${e}`);
  } finally {
    app.cleaning = false;
  }
}

// Re-clean a single region with a forced method (retry / redo a layer).
export async function recleanRegion(n, method) {
  const p = page();
  const b = (p.detect?.boxes ?? []).find((x) => x.n === n);
  if (!b || !p.raw) return;
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  setCleanStatus(n, 'cleaning');
  try {
    const result = await cleanImage(p.raw, [{ n, box: b.box, method }], {
      mask: p.clean?.maskPng ?? '',
      method,
      flux: method === 'flux', // the redo dropdown offers flux; actually engage it
    });
    applyClean(result, { replace: false, target: p });
    toast(`Re-cleaned line ${n} → ${method}`);
  } catch (e) {
    setCleanStatus(n, 'error');
    toast(`Re-clean failed: ${e}`);
  }
}

// Content-aware fill over a user-painted brush mask. `image` is a Blob of the
// current clean composite (raw + visible patches); `maskPng` is the base64
// painted alpha (no data: prefix). Returns one patch layer
// { box:[x,y,w,h], patch_png, method, fell_back }. Requires Tauri + a sidecar.
export async function brushInpaint(image, maskPng, { method = 'telea', flux = false } = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('sidecar unavailable (no Tauri runtime)');
  const bytes = Array.from(new Uint8Array(await image.arrayBuffer()));
  return invoke('sidecar_clean_brush', { image: bytes, maskPng, method, flux });
}

// ---- opt-in FLUX inpainter ------------------------------------------------
export async function refreshFluxStatus() {
  const invoke = await getInvoke();
  app.flux.checking = true;
  try {
    if (!invoke) {
      app.flux = { ...app.flux, available: false, reason: 'no Tauri runtime' };
      return app.flux;
    }
    const s = await invoke('sidecar_flux_status');
    app.flux = { ...app.flux, available: !!s.available, reason: s.reason ?? null };
    return app.flux;
  } catch (e) {
    app.flux = { ...app.flux, available: false, reason: String(e) };
    return app.flux;
  } finally {
    app.flux.checking = false;
  }
}

export async function downloadFlux() {
  const invoke = await getInvoke();
  if (!invoke) {
    toast('FLUX download needs the desktop app');
    return;
  }
  app.flux.downloading = true;
  toast('Installing FLUX deps — this can take a while…');
  try {
    const res = await invoke('sidecar_flux_download');
    toast(res.ok ? 'FLUX ready' : 'FLUX install failed — see logs');
    await refreshFluxStatus();
  } catch (e) {
    toast(`FLUX install failed: ${e}`);
  } finally {
    app.flux.downloading = false;
  }
}

// ---- translation (BYOK) ---------------------------------------------------

// Fetch the provider catalogue (id + suggested default model) into app.translate.
export async function loadTranslateProviders() {
  const invoke = await getInvoke();
  if (!invoke) return [];
  try {
    const r = await invoke('sidecar_translate_providers');
    app.translate.providers = r.providers ?? [];
    // Prefill model from the active provider's default if still empty.
    if (!app.translate.model) {
      const meta = app.translate.providers.find((x) => x.id === app.translate.provider);
      if (meta) app.translate.model = meta.default_model ?? '';
    }
    return app.translate.providers;
  } catch {
    return [];
  }
}

// Translate the current page's detected JP lines via the configured provider.
export async function translateCurrentPage() {
  const p = page();
  const t = app.translate;
  const lines = p.lines.filter((l) => l.jp).map((l) => ({ n: l.n, type: l.type, jp: l.jp }));
  if (!lines.length) {
    toast('No detected JP lines — run Detect first');
    return;
  }
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  if (!t.model) {
    toast('Set a model first');
    return;
  }
  const invoke = await getInvoke();
  app.translate.translating = true;
  try {
    const payload = {
      lines,
      provider: t.provider,
      model: t.model,
      api_key: t.apiKeys?.[t.provider] ?? '',
      base_url: t.baseUrl ?? '',
      output_language: t.outputLanguage || 'English',
      special_instructions: t.special ?? '',
    };
    const result = await invoke('sidecar_translate', { payload });
    applyTranslation(result, p);
    const n = (result.lines ?? []).filter((x) => x.en).length;
    toast(`Translated ${n} line(s)`);
  } catch (e) {
    toast(`Translate failed: ${e}`);
  } finally {
    app.translate.translating = false;
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
