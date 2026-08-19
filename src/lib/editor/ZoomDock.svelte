<script>
  // Zoom dock and undo/redo buttons.
  import { app, page, zoomIn, zoomOut, zoomReset, isTranslateMode } from '../store.svelte.js';
  import { history, undo, redo } from './history.svelte.js';

  // Translate mode hides typeset undo/redo.
  const translate = $derived(isTranslateMode());

  // Canvas computeFit handler.
  let { onFit } = $props();

  const zoomPct = $derived(Math.round(app.zoom * 100));
  // Display page resolution and zoom readout.
  const zoomTip = $derived.by(() => {
    const p = page();
    const w = Math.round(p.w * app.zoom);
    const h = Math.round(p.h * app.zoom);
    return `${p.w} × ${p.h} page px · ${w} × ${h} on screen — click for 100%`;
  });
</script>

<div class="zoomdock">
  <button class:on={app.isFit} onclick={onFit} data-tip="Fit to window">Fit</button>
  <span class="sep"></span>
  <!-- The store owns the ladder, so the only two buttons that walk it do not
       each carry their own copy of it. -->
  <button onclick={zoomOut} aria-label="Zoom out">−</button>
  <button class="zval" onclick={zoomReset} data-tip={zoomTip}>{zoomPct}%</button>
  <button onclick={zoomIn} aria-label="Zoom in">+</button>
  {#if !translate}
    <span class="sep"></span>

    <button onclick={undo} disabled={!history.canUndo} aria-label="Undo" data-tip="Undo (⌘Z)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
    </button>
    <button onclick={redo} disabled={!history.canRedo} aria-label="Redo" data-tip="Redo (⇧⌘Z)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
    </button>
  {/if}
</div>
