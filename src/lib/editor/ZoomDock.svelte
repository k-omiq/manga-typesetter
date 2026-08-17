<script>
  // Zoom controls plus undo/redo, grouped in one pill because both are quick,
  // frequent clicks made while typesetting — the hand resting near one rests
  // near the other. This component owns only the pill and its buttons; where
  // it sits on screen is Task 10's `.ed-dockrow`, not this file.
  import { app, page, zoomIn, zoomOut, zoomReset, isTranslateMode } from '../store.svelte.js';
  import { history, undo, redo } from './history.svelte.js';

  // Every history record mutates canvas boxes, and a translate chapter has no
  // canvas editing at all — replaying one would place boxes past the mode's
  // gates. The keyboard shortcuts are refused in App.svelte for the same
  // reason; these buttons are the second entry point, hidden with the rest of
  // the typeset-only chrome rather than left disabled-but-present.
  const translate = $derived(isTranslateMode());

  // `onFit` is the canvas's own `computeFit(true)` — this component has no
  // page geometry of its own to fit to.
  let { onFit } = $props();

  const zoomPct = $derived(Math.round(app.zoom * 100));
  // The percentage on its own is unfalsifiable — it is a ratio, and the user
  // cannot see what it is a ratio of. Both numbers here say it out loud: the
  // page's own pixel size, and what that comes to on screen. A page whose w/h
  // has drifted from the image it draws (see setPageDims) shows up immediately
  // as dimensions that do not match the file.
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
    <!-- Drawn, not typed. ↶/↷ are text glyphs: they take the font's weight rather
         than the 1.8 stroke every other control in this app is drawn with, they
         sit on the text baseline instead of the button's optical centre, and their
         size follows the font stack. These are the same 24×24 stroked paths as the
         rail and the chrome pills. -->
    <button onclick={undo} disabled={!history.canUndo} aria-label="Undo" data-tip="Undo (⌘Z)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
    </button>
    <button onclick={redo} disabled={!history.canRedo} aria-label="Redo" data-tip="Redo (⇧⌘Z)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
    </button>
  {/if}
</div>
