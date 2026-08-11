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

// Clean one page object's detected regions and apply the patch layers to it.
// Returns { layers, fell } on success, { skipped } if the page has no regions,
// or { error } on failure. Shared by the single-page and whole-chapter paths.
//
// `force` (null | 'telea' | 'ns') stamps an explicit per-region method so the
// sidecar's auto policy is bypassed entirely — the classical inpaint wins even
// for textured regions (no AI). When null, regions carry no method and the
// sidecar runs its auto policy (textured → AI redraw when FLUX is available).
async function cleanOnePage(p, { method = 'telea', flux = false, force = null } = {}) {
  const regions = (p?.detect?.boxes ?? []).map((b) =>
    force ? { n: b.n, box: b.box, method: force } : { n: b.n, box: b.box },
  );
  if (!p?.raw || !regions.length) return { skipped: true };
  for (const r of regions) setCleanStatus(r.n, 'cleaning', p);
  try {
    const result = await cleanImage(p.raw, regions, { mask: p.clean?.maskPng ?? '', method, flux });
    applyClean(result, { target: p });
    const fell = (result.layers ?? []).filter((l) => l.fell_back).length;
    return { layers: result.layers.length, fell };
  } catch (e) {
    for (const r of regions) setCleanStatus(r.n, 'error', p);
    return { error: String(e) };
  }
}

// Clean every detected region on the current page and apply the patch layers.
export async function cleanCurrentPage({ method = 'telea', flux = false, force = null } = {}) {
  const p = page();
  if (!p?.raw) {
    toast('No raw page to clean — import a raw image first');
    return;
  }
  if (!(p.detect?.boxes ?? []).length) {
    toast('Run Detect first — no text regions');
    return;
  }
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  app.cleaning = true;
  try {
    const r = await cleanOnePage(p, { method, flux, force });
    if (r.error) toast(`Clean failed: ${r.error}`);
    // Surface, in the completion summary, when textured regions wanted AI but
    // fell back to the classical inpaint (FLUX not installed).
    else toast(`Cleaned ${r.layers} region(s)` + (r.fell ? ` · ${r.fell} used ${method} (AI not installed)` : ''));
  } finally {
    app.cleaning = false;
  }
}

// Clean the whole chapter: every page with detected regions, in order. The
// FLUX process stays warm across pages (the proxy reuses one mt-flux), so only
// the first page pays the model load. Pages without a Detect pass are skipped.
export async function cleanAllPages({ method = 'telea', flux = false, force = null } = {}) {
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  const targets = app.pages.filter((p) => p?.raw && (p.detect?.boxes ?? []).length);
  if (!targets.length) {
    toast('No detected pages to clean — run Detect first');
    return;
  }
  app.cleaning = true;
  app.cleanBatch = { done: 0, total: targets.length };
  let regionsTotal = 0;
  let fellTotal = 0;
  let failed = 0;
  try {
    for (const p of targets) {
      const r = await cleanOnePage(p, { method, flux, force });
      if (r.error) failed++;
      else {
        regionsTotal += r.layers ?? 0;
        fellTotal += r.fell ?? 0;
      }
      app.cleanBatch = { done: app.cleanBatch.done + 1, total: targets.length };
    }
    // Only raw pages that lack a Detect pass are "skipped"; raw-less placeholders
    // aren't real pages and shouldn't be counted.
    const skipped = app.pages.filter((p) => p?.raw && !(p.detect?.boxes ?? []).length).length;
    toast(
      `Cleaned ${targets.length} page(s) · ${regionsTotal} region(s)` +
        (fellTotal ? ` · ${fellTotal} used ${method} (AI not installed)` : '') +
        (failed ? ` · ${failed} page(s) failed` : '') +
        (skipped ? ` · ${skipped} skipped (no Detect)` : ''),
    );
  } finally {
    app.cleaning = false;
    app.cleanBatch = null;
  }
}

// Re-clean a single region. `method` is a forced flavour (fill|telea|ns|flux)
// or 'auto' to re-run the sidecar's auto policy (textured → AI when available).
export async function recleanRegion(n, method) {
  const p = page();
  const b = (p.detect?.boxes ?? []).find((x) => x.n === n);
  if (!b || !p.raw) return;
  if (!sidecarReady()) {
    toast('Sidecar not ready');
    return;
  }
  setCleanStatus(n, 'cleaning', p);
  // 'auto' → send no per-region method so the sidecar classifies it (fill vs AI).
  const forced = method === 'auto' ? null : method;
  const region = forced ? { n, box: b.box, method: forced } : { n, box: b.box };
  try {
    const result = await cleanImage(p.raw, [region], {
      mask: p.clean?.maskPng ?? '',
      method: forced === 'ns' ? 'ns' : 'telea', // classical fallback flavour
      flux: forced === 'flux', // the redo dropdown offers flux; actually engage it
    });
    applyClean(result, { replace: false, target: p });
    toast(`Re-cleaned line ${n} → ${method}`);
  } catch (e) {
    setCleanStatus(n, 'error', p);
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
    // FLUX installs into an external uv-provisioned env; `uvAvailable` gates
    // whether it can be provisioned. `catalogue` drives the model picker; `model`
    // is the persisted selection; `process` reflects the mt-flux child.
    app.flux = {
      ...app.flux,
      available: !!s.available,
      reason: s.reason ?? null,
      uvAvailable: s.uv_available ?? true,
      envProvisioned: !!s.env_provisioned,
      inProcess: !!s.in_process,
      catalogue: s.catalogue ?? app.flux.catalogue,
      model: s.model ?? app.flux.model,
      process: s.process ?? null,
    };
    return app.flux;
  } catch (e) {
    // A failed status invoke usually just means the sidecar child hasn't
    // finished booting yet (it lags /health by a few seconds). Show that,
    // rather than a raw error, so the panel reads "starting…" not "not installed".
    const reason = app.sidecar?.status === 'ok' ? String(e) : 'sidecar starting…';
    app.flux = { ...app.flux, available: false, reason };
    return app.flux;
  } finally {
    app.flux.checking = false;
  }
}

// `selection` = { family, variant, backend, quant } chosen in Settings; `hfToken`
// is optional (gated 9B / rate-limited downloads).
export async function downloadFlux(selection = null, hfToken = '') {
  const invoke = await getInvoke();
  if (!invoke) {
    toast('FLUX download needs the desktop app');
    return;
  }
  app.flux.downloading = true;
  toast('Installing FLUX + downloading the model — this can take a while…');
  try {
    const res = await invoke('sidecar_flux_download', { selection, hfToken });
    // res.message describes the outcome (weights downloaded vs deferred to first use).
    toast(res.ok ? res.message || 'FLUX ready' : 'FLUX install failed — see logs');
    await refreshFluxStatus();
  } catch (e) {
    toast(`FLUX install failed: ${e}`);
  } finally {
    app.flux.downloading = false;
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

// Restart the Python sidecar child, then re-poll health + FLUX status. No-op in
// the browser (nothing to restart).
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
    await refreshFluxStatus();
    toast(sidecarReady() ? 'Sidecar restarted' : 'Sidecar restart failed — see logs');
  } catch (e) {
    s.status = 'error';
    toast(`Sidecar restart failed: ${e}`);
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
      input_language: t.inputLanguage || 'Japanese',
      reading_direction: t.readingDirection || 'rtl',
      special_instructions: t.special ?? '',
    };
    // reasoning_effort only matters for reasoning-capable providers; omit it
    // entirely when unset so the sidecar keeps its own default.
    if (t.reasoningEffort) payload.reasoning_effort = t.reasoningEffort;
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
