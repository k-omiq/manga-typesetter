<script>
  // Clean-mode right panel.
  //  - Cleaning Queue: per-detected-text progress + method badge + retry
  //  - Layers: one editable patch layer per region (toggle / select / redo / delete)
  //  - Brush Tools: manual clean-up (inpaint / clone / paint / erase)
  import { onMount } from 'svelte';
  import {
    app,
    page,
    cleanStatus,
    toggleLayer,
    selectCleanLayer,
    deleteLayer,
    layerByLine,
    lineByN,
    setBrushTool,
    setMode,
    toast,
  } from './store.svelte.js';
  import { cleanCurrentPage, cleanAllPages, recleanRegion, refreshFluxStatus, downloadFlux } from './sidecar.js';
  import { flattenClean, flattenAllClean, exportImages } from './exporter.js';

  const p = $derived(page());
  const regions = $derived(p.detect?.boxes ?? []);
  const layers = $derived(p.clean?.layers ?? []);
  const doneCount = $derived(regions.filter((r) => cleanStatus(r.n) === 'done').length);

  let method = $state('telea'); // classical fallback when the AI model isn't installed

  const METHODS = ['fill', 'telea', 'ns', 'flux'];
  const jpFor = (n) => lineByN(p, n)?.jp ?? '';

  // Phase 4 brush tools. Each entry: [id, label, one-line hint].
  const BRUSH_TOOLS = [
    ['inpaint', 'Fill', 'Content-aware fill (sidecar inpaint)'],
    ['clone', 'Clone', 'Alt-click to set a source, then paint to stamp'],
    ['fill', 'Paint', 'Solid colour — Alt-click canvas to eyedrop'],
    ['erase', 'Erase', 'Subtract from the selected layer (non-destructive)'],
  ];
  const brushHint = $derived(BRUSH_TOOLS.find((t) => t[0] === app.brush.tool)?.[2] ?? '');
  let flattening = $state(false);

  onMount(() => {
    refreshFluxStatus();
  });

  // Brush inpaint has its own FLUX opt-in but shares the availability/install
  // flow. Opting in when it isn't installed kicks off a multi-minute install;
  // reflect that as an "installing" state (see the row markup) rather than a
  // stale checkbox, and reconcile to the real availability once it finishes
  // (so a failed install ends unchecked, not falsely on).
  async function onBrushFluxToggle(e) {
    app.brush.flux = e.target.checked;
    if (app.brush.flux && !app.flux.available) {
      await downloadFlux();
      app.brush.flux = app.flux.available;
    }
  }

  async function onFlatten() {
    flattening = true;
    try {
      await flattenClean(p);
    } finally {
      flattening = false;
    }
  }

  // Finish-cleaning hand-off: bake every page's clean composite into its cleaned
  // image, then either save those to a folder or carry them into Translate mode.
  let finishOpen = $state(false);
  let finishing = $state(false);
  // Any page with a raw (or a clean base) can be baked into a cleaned image.
  const anyCleanable = $derived(app.pages.some((pg) => pg.raw || pg.clean?.base));

  async function transferToTranslate() {
    finishing = true;
    try {
      const n = await flattenAllClean();
      finishOpen = false;
      setMode('translate');
      toast(n ? `Transferred ${n} cleaned page(s) → Translate` : 'Nothing to transfer');
    } finally {
      finishing = false;
    }
  }

  async function saveToFolder() {
    finishing = true;
    try {
      const n = await flattenAllClean();
      if (!n) {
        toast('Nothing to save');
        return;
      }
      finishOpen = false;
      // Export the freshly-baked cleaned pages (no text boxes yet in clean stage).
      await exportImages('PNG', 'all');
    } finally {
      finishing = false;
    }
  }
</script>

<div class="rpanel">
  <!-- Cleaning Queue -->
  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Cleaning Queue
      <span class="count">{doneCount} / {regions.length} cleaned</span>
    </div>
    <div class="section-body">
      <div class="cleanbar">
        <button class="btn primary" disabled={app.cleaning || !regions.length} onclick={() => cleanCurrentPage({ method })}>
          {app.cleaning && !app.cleanBatch ? 'Cleaning…' : 'Clean Page'}
        </button>
        <button
          class="btn"
          disabled={app.cleaning || app.pages.length < 2}
          title="Clean every page in the chapter that has been detected. The AI model stays loaded across pages."
          onclick={() => cleanAllPages({ method })}
        >
          {#if app.cleanBatch}
            Cleaning {app.cleanBatch.done}/{app.cleanBatch.total}…
          {:else}
            Clean Chapter
          {/if}
        </button>
        <select bind:value={method} title="Classical fallback used when the AI model isn't installed">
          <option value="telea">Telea</option>
          <option value="ns">Navier–Stokes</option>
        </select>
      </div>
      {#if app.cleanBatch}
        <div class="batchbar" role="progressbar" aria-valuenow={app.cleanBatch.done} aria-valuemax={app.cleanBatch.total}>
          <div class="batchfill" style="width:{(app.cleanBatch.done / app.cleanBatch.total) * 100}%"></div>
        </div>
      {/if}

      <div class="policy" title={app.flux.reason ?? ''}>
        Solid areas (bubbles, boxes) → <b>fill</b> · textured art → <b>AI redraw</b>
        {#if app.flux.downloading}
          <span class="pstate">· installing AI…</span>
        {:else if app.flux.available}
          <span class="pstate ok">· AI ready</span>
        {:else}
          <span class="pstate warn">· AI not installed — textured areas use the {method} fallback. Install it in Settings.</span>
        {/if}
      </div>

      {#if regions.length === 0}
        <div class="qhint">No detected text. Run <b>Detect</b> in the top bar first — cleaning works on the detected regions.</div>
      {:else}
        <div class="qlist">
          {#each regions as r (r.n)}
            {@const st = cleanStatus(r.n)}
            {@const lyr = layerByLine(r.n)}
            <div class="qrow">
              <span class="badge">{r.n}</span>
              <span class="qcol">
                <span class="preview">{jpFor(r.n) || `region ${r.n}`}</span>
                {#if lyr}
                  <span class="meta">
                    <span class="mbadge {lyr.method}">{lyr.method}</span>
                    {#if lyr.fellBack}<span class="warn">flux→cv2</span>{/if}
                    <span class="dim">σ {lyr.ringStd}</span>
                  </span>
                {/if}
              </span>
              <span class="status">
                <span class="dot {st}" title={st}></span>
                <button class="mini" title="Re-clean this region" disabled={app.cleaning || st === 'cleaning'} onclick={() => recleanRegion(r.n, method)}>↻</button>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Layers -->
  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Layers
      <span class="count">{layers.length}</span>
    </div>
    <div class="section-body">
      {#if layers.length === 0}
        <div class="qhint">Cleaned regions appear here as patch layers. The page composites as raw + visible patches.</div>
      {:else}
        <div class="qlist">
          {#each layers as l (l.id)}
            <div class="lrow" class:sel={app.selectedLayerId === l.id} class:hidden={!l.visible}>
              <button class="eye" title={l.visible ? 'Hide' : 'Show'} onclick={() => toggleLayer(l.id)}>
                {#if l.visible}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.94 17.94A10 10 0 0 1 12 19C5 19 1 12 1 12a18 18 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 7 11 7a18 18 0 0 1-2.16 3.19" /><path d="M1 1l22 22" /></svg>
                {/if}
              </button>
              <button class="lname" onclick={() => selectCleanLayer(l.id)} title="Select layer">
                <span class="badge sm" class:brush={l.kind === 'brush'}>{l.kind === 'brush' ? '✎' : l.n}</span>
                <span class="mbadge {l.method}">{l.kind === 'brush' ? l.label : l.method}</span>
                {#if l.fellBack}<span class="warn">fallback</span>{/if}
              </button>
              {#if l.kind === 'brush'}
                <span class="brushtag" title="Manual brush layer">brush</span>
              {:else}
                <select class="redo" value={l.method} title="Re-clean with method" onchange={(e) => recleanRegion(l.n, e.target.value)}>
                  {#each METHODS as m}<option value={m} disabled={m === 'flux' && !app.flux.available}>{m}</option>{/each}
                </select>
              {/if}
              <button class="mini danger" title="Delete layer" onclick={() => deleteLayer(l.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <button class="btn flatten" disabled={flattening || !p.raw} title="Composite raw + visible layers into this page's cleaned image (feeds Translate + export)" onclick={onFlatten}>
        {flattening ? 'Flattening…' : 'Bake / Flatten this page'}
      </button>
      <button class="btn finish" disabled={finishing || !anyCleanable} title="Bake every cleaned page, then save them or carry them into Translate" onclick={() => (finishOpen = true)}>
        {finishing ? 'Working…' : 'Finish cleaning →'}
      </button>
    </div>
  </div>

  <!-- Brush Tools (Phase 4) -->
  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Brush Tools
    </div>
    <div class="section-body">
      <div class="tools">
        {#each BRUSH_TOOLS as [id, label]}
          <button class="tool" class:on={app.tool === 'brush' && app.brush.tool === id} onclick={() => setBrushTool(id)}>{label}</button>
        {/each}
      </div>
      <div class="bhint">
        {brushHint}
        {#if app.brush.tool === 'clone'}
          <span class="dim"> · source {app.brush.cloneSource ? 'set' : 'unset'}</span>
        {/if}
        {#if app.brush.busy}<span class="dim"> · filling…</span>{/if}
      </div>

      <label class="slider">
        <span>Size</span>
        <input type="range" min="4" max="240" step="1" bind:value={app.brush.size} />
        <span class="val">{app.brush.size}</span>
      </label>
      <label class="slider">
        <span>Hardness</span>
        <input type="range" min="0" max="1" step="0.05" bind:value={app.brush.hardness} />
        <span class="val">{Math.round(app.brush.hardness * 100)}%</span>
      </label>

      {#if app.brush.tool === 'inpaint'}
        <div class="brow">
          <select bind:value={app.brush.method} title="Content-aware fill method">
            <option value="telea">Telea</option>
            <option value="ns">Navier–Stokes</option>
          </select>
          <label class="fluxrow inline" title={app.flux.downloading ? 'Installing FLUX — this can take several minutes' : (app.flux.reason ?? '')}>
            <input type="checkbox" checked={app.brush.flux} onchange={onBrushFluxToggle} disabled={app.flux.downloading} />
            {#if app.flux.downloading}
              <span class="spin" aria-hidden="true"></span>
              <span>Installing…</span>
            {:else}
              <span>FLUX</span>
            {/if}
          </label>
        </div>
      {/if}

      {#if app.brush.tool === 'fill'}
        <label class="slider">
          <span>Colour</span>
          <input type="color" bind:value={app.brush.color} />
          <span class="val">{app.brush.color}</span>
        </label>
      {/if}

      {#if app.brush.tool === 'erase' && !app.selectedLayerId}
        <div class="qhint">Select a layer above to erase from it.</div>
      {/if}
    </div>
  </div>
</div>

{#if finishOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="finish-overlay" onclick={(e) => e.target === e.currentTarget && !finishing && (finishOpen = false)}>
    <div class="finish-card">
      <h3>Cleaned chapter ready</h3>
      <p>Bake every cleaned page, then choose what to do with them.</p>
      <div class="finish-actions">
        <button class="fbtn primary" disabled={finishing} onclick={transferToTranslate}>
          <b>Transfer to Translate</b>
          <span>Carry the cleaned pages into Translate mode and start typesetting.</span>
        </button>
        <button class="fbtn" disabled={finishing} onclick={saveToFolder}>
          <b>Save to folder</b>
          <span>Export the cleaned pages as PNGs to a folder you pick.</span>
        </button>
      </div>
      <button class="fcancel" disabled={finishing} onclick={() => (finishOpen = false)}>
        {finishing ? 'Working…' : 'Cancel'}
      </button>
    </div>
  </div>
{/if}

<style>
  .cleanbar {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .cleanbar .btn {
    flex: 1;
  }
  .batchbar {
    height: 4px;
    border-radius: 999px;
    background: var(--line, #2b2f3a);
    overflow: hidden;
    margin-bottom: 8px;
  }
  .batchfill {
    height: 100%;
    background: var(--accent, #4b7bec);
    transition: width 0.2s ease;
  }
  .btn {
    padding: 7px 10px;
    border-radius: 7px;
    border: 1px solid var(--line, #2b2f3a);
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    font: inherit;
    font-size: 12px;
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
  select {
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    border: 1px solid var(--line, #2b2f3a);
    border-radius: 7px;
    font: inherit;
    font-size: 12px;
    padding: 4px 6px;
  }
  .fluxrow {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    margin-bottom: 10px;
    color: var(--text, #e6e8ee);
    cursor: pointer;
  }
  .policy {
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted, #8b91a1);
    margin-bottom: 10px;
  }
  .policy b {
    color: var(--text, #e6e8ee);
    font-weight: 600;
  }
  .pstate.ok {
    color: #7fe0a3;
  }
  .pstate.warn {
    color: #e0a87f;
  }
  .qlist {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qrow,
  .lrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--surface2, #20242e);
    border: 1px solid transparent;
  }
  .lrow.sel {
    border-color: var(--accent, #4b7bec);
  }
  .lrow.hidden {
    opacity: 0.5;
  }
  .badge {
    flex: none;
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 6px;
    background: var(--accent, #4b7bec);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.sm {
    min-width: 18px;
    height: 18px;
  }
  .qcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .preview {
    font-size: 12px;
    color: var(--text, #e6e8ee);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .mbadge {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 600;
    background: #2b2f3a;
    color: #b9c0d0;
  }
  .mbadge.fill {
    background: #1f3d2b;
    color: #7fe0a3;
  }
  .mbadge.telea,
  .mbadge.ns {
    background: #3a2f1f;
    color: #e0c07f;
  }
  .mbadge.flux {
    background: #2f1f3d;
    color: #c79fe0;
  }
  .mbadge.inpaint,
  .mbadge.clone {
    background: #24304a;
    color: #9fb6e0;
  }
  .mbadge.erase {
    background: #3d1f2b;
    color: #e09fb0;
  }
  .warn {
    color: #e0a87f;
    font-size: 10px;
  }
  .dim {
    color: var(--muted, #8b91a1);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #555b6b;
  }
  .dot.pending {
    background: #555b6b;
  }
  .dot.cleaning {
    background: #e0c07f;
    animation: pulse 1s infinite;
  }
  .dot.done {
    background: #5fcf86;
  }
  .dot.error {
    background: #e06f6f;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .spin {
    width: 11px;
    height: 11px;
    flex: none;
    border-radius: 50%;
    border: 2px solid var(--line, #2b2f3a);
    border-top-color: #e0c07f;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .mini {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 1px solid var(--line, #2b2f3a);
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    cursor: pointer;
    font-size: 13px;
  }
  .mini svg {
    width: 13px;
    height: 13px;
  }
  .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .mini.danger:hover {
    border-color: #e06f6f;
    color: #e06f6f;
  }
  .eye {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    color: var(--text, #e6e8ee);
    cursor: pointer;
  }
  .eye svg {
    width: 16px;
    height: 16px;
  }
  .lname {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .redo {
    flex: none;
    padding: 3px 4px;
    font-size: 11px;
  }
  .badge.brush {
    background: #3a2f1f;
    color: #e0c07f;
  }
  .brushtag {
    flex: none;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #8b91a1);
    padding: 0 2px;
  }
  .btn.flatten {
    width: 100%;
    margin-top: 8px;
  }
  .btn.finish {
    width: 100%;
    margin-top: 6px;
    background: var(--accent, #4b7bec);
    border-color: var(--accent, #4b7bec);
    color: #fff;
    font-weight: 600;
  }
  /* Finish-cleaning hand-off prompt */
  .finish-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 60;
  }
  .finish-card {
    width: min(420px, 90vw);
    background: var(--surface, #171a21);
    border: 1px solid var(--line, #2b2f3a);
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .finish-card h3 {
    margin: 0 0 4px;
    font-size: 15px;
    color: var(--text, #e6e8ee);
  }
  .finish-card > p {
    margin: 0 0 16px;
    font-size: 12.5px;
    color: var(--muted, #8b91a1);
    line-height: 1.5;
  }
  .finish-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .fbtn {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 11px 13px;
    border-radius: 9px;
    border: 1px solid var(--line, #2b2f3a);
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    font: inherit;
    cursor: pointer;
  }
  .fbtn:hover:not(:disabled) {
    border-color: var(--accent, #4b7bec);
  }
  .fbtn.primary {
    background: var(--accent, #4b7bec);
    border-color: var(--accent, #4b7bec);
    color: #fff;
  }
  .fbtn b {
    font-size: 13px;
  }
  .fbtn span {
    font-size: 11.5px;
    opacity: 0.85;
    line-height: 1.4;
  }
  .fbtn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .fcancel {
    width: 100%;
    margin-top: 12px;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid var(--line, #2b2f3a);
    background: none;
    color: var(--muted, #8b91a1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .fcancel:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tools {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    margin-bottom: 8px;
  }
  .tool {
    padding: 6px 4px;
    border-radius: 7px;
    border: 1px solid var(--line, #2b2f3a);
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .tool.on {
    background: var(--accent, #4b7bec);
    border-color: var(--accent, #4b7bec);
    color: #fff;
    font-weight: 600;
  }
  .bhint {
    font-size: 11px;
    color: var(--muted, #8b91a1);
    margin-bottom: 10px;
    line-height: 1.4;
  }
  .slider {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 8px;
    color: var(--text, #e6e8ee);
  }
  .slider > span:first-child {
    width: 58px;
    flex: none;
  }
  .slider input[type='range'] {
    flex: 1;
    min-width: 0;
  }
  .slider input[type='color'] {
    width: 34px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--line, #2b2f3a);
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }
  .slider .val {
    width: 52px;
    flex: none;
    text-align: right;
    font-size: 11px;
    color: var(--muted, #8b91a1);
  }
  .brow {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .brow select {
    flex: 1;
  }
  .fluxrow.inline {
    margin-bottom: 0;
    flex: none;
  }
</style>
