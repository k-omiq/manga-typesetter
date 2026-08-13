<script>
  // The raw page, parked down the left edge as the thing you typeset against.
  // Derived from the old RawPanel: same zoom behaviour, minus the panel header
  // the wireframe does away with — a bare image column with a floating zoom
  // pill over its bottom edge, the same pill chrome as the canvas dock.
  // The width is the rail's business (it is the drag handle); this file only
  // reads it, and whether the sidebar is on screen at all is EditorRoot's `if`.
  import { app, page, rawZoomIn, rawZoomOut } from '../store.svelte.js';

  const rawWidth = $derived(app.rawZoom === 0 ? '100%' : 100 * app.rawZoom + '%');
  const rawLabel = $derived(app.rawZoom === 0 ? 'Fit' : Math.round(app.rawZoom * 100) + '%');
</script>

<aside class="ed-side" style="width:{app.leftWidth}px">
  <div class="ed-side-scroll" class:empty={!page().raw}>
    {#if page().raw}
      <img src={page().raw} alt="Raw page" style="width:{rawWidth}" />
    {:else}
      <div class="ed-side-empty">No raw reference.<br />Import Raw to load it here.</div>
    {/if}
  </div>
  <div class="ed-side-zoom">
    <button onclick={rawZoomOut} aria-label="Zoom reference out">−</button>
    <span class="zval">{rawLabel}</span>
    <button onclick={rawZoomIn} aria-label="Zoom reference in">+</button>
  </div>
</aside>
