<script>
  // Clean-mode right panel.
  //  - Cleaning Queue: per-detected-text progress + method badge + retry
  //  - Layers: one editable patch layer per region (toggle / select / redo / delete)
  //  - Brush Tools: Phase 4 (skipped)
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
  } from './store.svelte.js';
  import { cleanCurrentPage, recleanRegion, refreshFluxStatus, downloadFlux } from './sidecar.js';

  const p = $derived(page());
  const regions = $derived(p.detect?.boxes ?? []);
  const layers = $derived(p.clean?.layers ?? []);
  const doneCount = $derived(regions.filter((r) => cleanStatus(r.n) === 'done').length);

  let method = $state('telea'); // default inpaint flavour for textured regions
  let flux = $state(false); // opt into the heavy FLUX path

  const METHODS = ['fill', 'telea', 'ns', 'flux'];
  const jpFor = (n) => lineByN(p, n)?.jp ?? '';

  onMount(() => {
    refreshFluxStatus();
  });

  function onFluxToggle(e) {
    flux = e.target.checked;
    if (flux && !app.flux.available) downloadFlux();
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
        <button class="btn primary" disabled={app.cleaning || !regions.length} onclick={() => cleanCurrentPage({ method, flux })}>
          {app.cleaning ? 'Cleaning…' : 'Clean All'}
        </button>
        <select bind:value={method} title="Inpaint method for textured regions">
          <option value="telea">Telea</option>
          <option value="ns">Navier–Stokes</option>
        </select>
      </div>

      <label class="fluxrow" title={app.flux.reason ?? ''}>
        <input type="checkbox" checked={flux} onchange={onFluxToggle} disabled={app.flux.downloading} />
        <span>FLUX inpaint</span>
        <span class="fluxstate">
          {#if app.flux.downloading}installing…{:else if app.flux.available}ready{:else}opt-in download{/if}
        </span>
      </label>

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
                <span class="badge sm">{l.n}</span>
                <span class="mbadge {l.method}">{l.method}</span>
                {#if l.fellBack}<span class="warn">fallback</span>{/if}
              </button>
              <select class="redo" value={l.method} title="Re-clean with method" onchange={(e) => recleanRegion(l.n, e.target.value)}>
                {#each METHODS as m}<option value={m} disabled={m === 'flux' && !app.flux.available}>{m}</option>{/each}
              </select>
              <button class="mini danger" title="Delete layer" onclick={() => deleteLayer(l.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Brush Tools (Phase 4) -->
  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Brush Tools
    </div>
    <div class="section-body">
      <div class="qhint">Clone &amp; content-aware fill (Rust-backed) — coming soon.</div>
    </div>
  </div>
</div>

<style>
  .cleanbar {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .cleanbar .btn {
    flex: 1;
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
  .fluxstate {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted, #8b91a1);
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
</style>
