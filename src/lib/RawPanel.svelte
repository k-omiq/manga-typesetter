<script>
  import { app, page, rawZoomIn, rawZoomOut } from './store.svelte.js';

  const rawWidth = $derived(app.rawZoom === 0 ? '100%' : 100 * app.rawZoom + '%');
  const rawLabel = $derived(app.rawZoom === 0 ? 'Fit' : Math.round(app.rawZoom * 100) + '%');
</script>

<section class="col col-left" style="width:{app.leftWidth}px">
  <div class="panel-head">Raw <span class="tag">reference</span></div>
  <div class="raw-scroll" class:empty={!page().raw}>
    {#if page().raw}
      <img src={page().raw} alt="Raw page" style="width:{rawWidth}" />
    {:else}
      <div class="raw-empty">No raw reference.<br />Import Raw to load it here.</div>
    {/if}
  </div>
  <div class="raw-zoombar">
    <button class="mini" onclick={rawZoomOut}>−</button>
    <span>{rawLabel}</span>
    <button class="mini" onclick={rawZoomIn}>+</button>
    <span style="margin-left:auto">read-only</span>
  </div>
</section>
