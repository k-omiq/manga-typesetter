<script>
  // Zoom controls plus undo/redo, grouped in one pill because both are quick,
  // frequent clicks made while typesetting — the hand resting near one rests
  // near the other. This component owns only the pill and its buttons; where
  // it sits on screen is Task 10's `.ed-dockrow`, not this file.
  import { app, zoomIn, zoomOut, zoomReset } from '../store.svelte.js';
  import { history, undo, redo } from './history.svelte.js';

  // `onFit` is the canvas's own `computeFit(true)` — this component has no
  // page geometry of its own to fit to.
  let { onFit } = $props();

  const zoomPct = $derived(Math.round(app.zoom * 100));
</script>

<div class="zoomdock">
  <button onclick={onFit} data-tip="Fit to window">Fit</button>
  <span class="sep"></span>
  <!-- The store owns the step, so the only two buttons that take one do not
       each carry their own copy of it. -->
  <button onclick={zoomOut} aria-label="Zoom out">−</button>
  <button class="zval" onclick={zoomReset} data-tip="Reset to 100%">{zoomPct}%</button>
  <button onclick={zoomIn} aria-label="Zoom in">+</button>
  <span class="sep"></span>
  <button onclick={undo} disabled={!history.canUndo} aria-label="Undo" data-tip="Undo (⌘Z)">↶</button>
  <button onclick={redo} disabled={!history.canRedo} aria-label="Redo" data-tip="Redo (⇧⌘Z)">↷</button>
</div>
