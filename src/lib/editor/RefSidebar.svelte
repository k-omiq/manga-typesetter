<script>
  // Reference raw page sidebar column.
  import { app, page, isLongstrip, rawZoomIn, rawZoomOut, rawZoomBy } from '../store.svelte.js';
  import { stripScroll } from './strip-sync.svelte.js';
  import { scrollTopForFraction } from './strip.js';

  const strip = $derived(isLongstrip());
  const rawWidth = $derived(app.rawZoom === 0 ? '100%' : 100 * app.rawZoom + '%');
  const rawLabel = $derived(app.rawZoom === 0 ? 'Fit' : Math.round(app.rawZoom * 100) + '%');

  // Sidebar scroll container element.
  let scrollEl = $state(null);

  // Preserve placeholder proportions using aspect-ratio.
  const ratioOf = (p) => (p?.w > 0 && p?.h > 0 ? `${p.w} / ${p.h}` : '2 / 3');

  // Re-sync scroll on layout updates.
  const ratios = $derived(strip ? app.pages.map((p) => ratioOf(p)).join(',') : '');

  // Slave scroll position to canvas.
  $effect(() => {
    stripScroll.seq;
    ratios;
    if (!strip || !scrollEl) return;
    scrollEl.scrollTop = scrollTopForFraction(stripScroll.fraction, scrollEl);
  });

  // Zoom column with modifier + wheel.
  const ZOOM_PER_PX = 0.0035;
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return; // an ordinary wheel is an ordinary scroll
    e.preventDefault();
    rawZoomBy(Math.exp(-e.deltaY * ZOOM_PER_PX));
  }
</script>

<aside class="ed-side" style="width:{app.leftWidth}px">
  {#if strip}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ed-side-scroll" bind:this={scrollEl} onwheel={onWheel}>
      <!-- Zero gap, exactly like the canvas's column and for the same reason:
           these are slices of one continuous drawing. -->
      <div class="ed-side-strip">
        {#each app.pages as pg (pg.id)}
          {#if pg.raw}
            <img src={pg.raw} alt="Raw page" crossorigin="anonymous" decoding="async" style="width:{rawWidth}; aspect-ratio:{ratioOf(pg)}" />
          {:else}
            <div class="ed-side-slot" style="width:{rawWidth}; aspect-ratio:{ratioOf(pg)}"></div>
          {/if}
        {/each}
      </div>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ed-side-scroll" class:empty={!page().raw} onwheel={onWheel}>
      {#if page().raw}
        <!-- The same `aspect-ratio` the strip's slices carry, and for the same
             reason stated for one page instead of forty: without it this column
             is zero pixels tall until the raw has decoded and then jumps to its
             real height, which on every page turn is a reflow of the sidebar
             (and of the scroll position inside it) in the middle of the turn.
             With it the box is the right shape from the moment the element
             mounts. A page whose art has never been measured falls back to
             `2 / 3`, which is a page-shaped hole rather than a flat line. -->
        <img src={page().raw} alt="Raw page" crossorigin="anonymous" decoding="async" style="width:{rawWidth}; aspect-ratio:{ratioOf(page())}" />
      {:else}
        <div class="ed-side-empty">No raw reference.<br />Import Raw to load it here.</div>
      {/if}
    </div>
  {/if}
  <div class="ed-side-zoom">
    <button onclick={rawZoomOut} aria-label="Zoom reference out">−</button>
    <span class="zval">{rawLabel}</span>
    <button onclick={rawZoomIn} aria-label="Zoom reference in">+</button>
  </div>
</aside>
