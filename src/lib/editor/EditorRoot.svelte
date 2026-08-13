<script>
  // The editor shell. One layer for the page, and everything else floating over
  // it: the reference sidebar and its rail down the left, the chrome pills along
  // the top, the zoom/undo dock and the pager along the bottom, and the two
  // panels the user drags wherever they like.
  //
  // Nothing here is a column. The canvas layer is inset from the left by the
  // sidebar and the rail — the two things whose width the user actually sets —
  // and by nothing else, so fit-to-window measures the canvas viewport. The
  // floating panels are ignored by that measurement on purpose: a panel dragged
  // over the page covers it rather than reflowing it.
  import { onMount } from 'svelte';
  import Canvas from './Canvas.svelte';
  import RefSidebar from './RefSidebar.svelte';
  import RailTools, { RAIL_W } from './RailTools.svelte';
  import ChromePills from './ChromePills.svelte';
  import ZoomDock from './ZoomDock.svelte';
  import Pager from './Pager.svelte';
  import FloatingPanel from './FloatingPanel.svelte';
  import Inspector from '../Inspector.svelte';
  import Queue from '../Queue.svelte';
  import BulkStylePanel from '../BulkStylePanel.svelte';
  import { app, page, isPlaced } from '../store.svelte.js';
  import { loadPanels, clampAll } from './panels.svelte.js';

  let { onFontLib, onSettings } = $props();

  // The canvas's own handle, so the dock's Fit button can ask the thing that can
  // actually measure itself.
  let canvas = $state(null);

  const canvasLeft = $derived((app.sidebarHidden ? 0 : app.leftWidth) + RAIL_W);

  const placed = $derived(page().lines.filter((l) => isPlaced(page(), l.n)).length);
  const total = $derived(page().lines.length);

  // The stored layout is read once, when the shell mounts and the window's size
  // is finally known. Every later resize only clamps — a window the user shrank
  // must not be able to lose them a panel, but neither may it overwrite the
  // geometry they chose at the size they chose it.
  onMount(() => {
    loadPanels(
      typeof localStorage === 'undefined' ? null : localStorage,
      window.innerWidth,
      window.innerHeight,
    );
  });

  // Clamp without writing: see `clampAll`. A window the user shrank must not be
  // able to make the layout they chose smaller for good.
  const onResize = () => clampAll(window.innerWidth, window.innerHeight, false);
</script>

<svelte:window onresize={onResize} />

<div class="ed-root" style="--canvas-left:{canvasLeft}px">
  <div class="ed-canvas">
    <Canvas onReady={(api) => (canvas = api)} />
    <!-- Inside the canvas layer, not the root: this panel centres itself and
         clamps its drag against `offsetParent`, so the element it sits in is
         the frame it is confined to. Under `.ed-root` — fixed to the viewport —
         it opened over the reference sidebar and, at z-index 40, on top of the
         chrome pills. `.ed-canvas` is positioned, so it takes the role, and it
         carries no z-index of its own, so 40 still orders against the root's
         context exactly as before. -->
    <BulkStylePanel />
  </div>

  {#if !app.sidebarHidden}<RefSidebar />{/if}
  <RailTools />

  <ChromePills {onFontLib} {onSettings} />

  <!-- Nothing to zoom and no pages to step through until a chapter is open:
       ungated, the "Nothing open" empty state sits behind a live zoom pill and
       a `0 / 0` pager. -->
  {#if app.loaded}
    <div class="ed-dockrow">
      <ZoomDock onFit={() => canvas?.fit()} />
      <Pager />
    </div>
  {/if}

  <FloatingPanel id="options" title="Text box options">
    <Inspector />
  </FloatingPanel>
  <FloatingPanel id="queue" title="Text queue" count="{placed} / {total} placed">
    <Queue />
  </FloatingPanel>
</div>
