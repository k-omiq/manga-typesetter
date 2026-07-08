<script>
  // Settings → Models. Lets the user install the opt-in MangaTranslator FLUX
  // AI-redraw model (heavy diffusers/sdnq deps; weights stream on first use).
  // Reuses the existing sidecar bridges — no new backend.
  import { app } from './store.svelte.js';
  import { refreshFluxStatus, downloadFlux, checkSidecar } from './sidecar.js';

  let { open = $bindable() } = $props();

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }

  // Refresh live sidecar + model status each time the panel opens.
  $effect(() => {
    if (open) {
      checkSidecar();
      refreshFluxStatus();
    }
  });

  const sidecarOk = $derived(app.sidecar?.status === 'ok');
  const sidecarLabel = $derived(
    app.sidecar?.status === 'ok'
      ? `Ready · ${app.sidecar.device ?? '—'}`
      : app.sidecar?.status === 'unavailable'
        ? 'Unavailable — desktop app only'
        : app.sidecar?.status === 'error'
          ? 'Error — see logs'
          : 'Checking…',
  );

  // 'installing' | 'checking' | 'ready' | 'missing'
  const fluxState = $derived(
    app.flux.downloading
      ? 'installing'
      : app.flux.checking
        ? 'checking'
        : app.flux.available
          ? 'ready'
          : 'missing',
  );
  const fluxLabel = $derived(
    { installing: 'Installing…', checking: 'Checking…', ready: 'Installed', missing: 'Not installed' }[fluxState],
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      <h3>Settings</h3>
      <button class="x" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="modal-body">
      <!-- Sidecar status -->
      <div class="srow">
        <span class="slabel">ML sidecar</span>
        <span class="dot {sidecarOk ? 'ok' : app.sidecar?.status === 'error' ? 'err' : 'off'}"></span>
        <span class="sval">{sidecarLabel}</span>
      </div>

      <div class="group-label">Models</div>

      <!-- MangaTranslator FLUX AI redraw (the downloadable one) -->
      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.09 6.26L20 9.27l-5 3.64L16.18 21 12 17.27 7.82 21 9 12.91l-5-3.64 5.91.01z" /></svg>
            <div>
              <div class="mc-name">AI Redraw — MangaTranslator FLUX</div>
              <div class="mc-sub">FLUX Klein 4B · SDNQ backend (CPU/MPS/CUDA)</div>
            </div>
          </div>
          <span class="tag {fluxState}">{fluxLabel}</span>
        </div>

        <p class="mc-desc">
          Diffusion inpainting that redraws artwork behind removed text — used by both auto-clean
          (choose <b>flux</b>) and the brush <b>Fill</b> tool. Optional: OpenCV Telea/NS handles
          cleaning without it. Installs the diffusers/SDNQ deps now; the multi-GB model weights
          stream from HuggingFace on the first FLUX clean.
        </p>

        {#if app.flux.reason && fluxState === 'missing'}
          <div class="mc-reason">{app.flux.reason}</div>
        {/if}

        <div class="mc-actions">
          <button
            class="btn primary"
            disabled={!sidecarOk || app.flux.downloading || app.flux.available}
            onclick={downloadFlux}
          >
            {#if app.flux.downloading}
              Installing…
            {:else if app.flux.available}
              Installed ✓
            {:else}
              Download &amp; Install
            {/if}
          </button>
          <button class="btn" disabled={!sidecarOk || app.flux.downloading || app.flux.checking} onclick={refreshFluxStatus}>
            Recheck
          </button>
        </div>

        {#if !sidecarOk}
          <div class="qhint">The sidecar isn't running — model install needs the desktop app.</div>
        {:else if app.flux.downloading}
          <div class="qhint">Installing dependencies. This can take several minutes; you can keep working.</div>
        {/if}
      </div>

      <!-- Detection/OCR models (auto-managed, read-only) -->
      <div class="model-card muted">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>
            <div>
              <div class="mc-name">Detection &amp; OCR</div>
              <div class="mc-sub">comic-text-detector · manga-ocr · panel YOLO</div>
            </div>
          </div>
          <span class="tag auto">Auto</span>
        </div>
        <p class="mc-desc">Downloaded automatically on first <b>Detect</b> and cached locally. No action needed.</p>
      </div>
    </div>
  </div>
</div>

<style>
  .srow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 4px 2px 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 14px;
  }
  .slabel {
    color: var(--muted);
  }
  .sval {
    margin-left: 2px;
    color: var(--text);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #555b6b;
  }
  .dot.ok {
    background: #5fcf86;
  }
  .dot.err {
    background: #e06f6f;
  }
  .group-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .model-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    background: var(--surface-2);
  }
  .model-card.muted {
    opacity: 0.85;
  }
  .mc-top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .mc-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }
  .mc-title svg {
    flex: none;
    color: var(--muted);
  }
  .mc-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
  }
  .mc-sub {
    font-size: 11.5px;
    color: var(--muted);
  }
  .mc-desc {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted);
    margin: 10px 0 0;
  }
  .mc-reason {
    font-size: 11.5px;
    color: #e0a87f;
    margin-top: 8px;
    font-family: ui-monospace, monospace;
  }
  .mc-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .tag {
    flex: none;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 999px;
    background: #2b2f3a;
    color: #b9c0d0;
    height: fit-content;
  }
  .tag.ready {
    background: #1f3d2b;
    color: #7fe0a3;
  }
  .tag.installing,
  .tag.checking {
    background: #3a2f1f;
    color: #e0c07f;
  }
  .tag.auto {
    background: #24304a;
    color: #9fb6e0;
  }
  .btn {
    padding: 7px 14px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .btn.primary {
    background: var(--accent, #4b7bec);
    border-color: var(--accent, #4b7bec);
    color: #fff;
    font-weight: 600;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .qhint {
    font-size: 12px;
    color: var(--muted);
    margin-top: 10px;
    line-height: 1.4;
  }
</style>
