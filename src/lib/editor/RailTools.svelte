<script module>
  // The rail's width in pixels. EditorRoot needs the number to work out where
  // the canvas layer starts; the stylesheet needs the same length as --rail-w.
  // Declared once on each side and named after the other so a change to one is
  // an obvious prompt to change the other.
  export const RAIL_W = 44;
</script>

<script>
  // The strip between the reference sidebar and the canvas. It carries the tool
  // switcher and doubles as the sidebar's resize handle — the wireframe has no
  // separate resizer, the seam itself is the grab.
  import {
    app,
    setTool,
    saveSidebar,
    clampSidebarWidth,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
    isTranslateMode,
  } from '../store.svelte.js';

  // A translate chapter has no reference sidebar — the canvas is already showing
  // the raw — so the rail keeps only the hand, and the caret that would offer to
  // bring a sidebar back goes with it. `noSide` rather than `app.sidebarHidden`
  // everywhere the geometry is concerned: there is nothing to the left of the
  // rail in either case, so it sits at 0 and the resize is inert.
  const translate = $derived(isTranslateMode());
  const noSide = $derived(translate || app.sidebarHidden);

  // How far one arrow key moves the edge. Coarse enough to cross the range in a
  // reasonable number of presses, fine enough to land where you meant to.
  const KEY_STEP = 16;

  // Every gesture in flight, so an unmount can end them all — see the same set
  // in FloatingPanel. The listeners live on `document`, and nothing guarantees
  // a further pointer event once this component is gone.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  // A press on the rail stays ambiguous until it travels: under 4px it is still
  // a click on whatever it landed on, and only past that does it become a
  // resize. The tool strip stops its own pointerdown from reaching here, so
  // this never starts from a button — or from the padding between them, which
  // is why the guard sits on the strip rather than on each button.
  function onRailPointerDown(e) {
    if (noSide) return; // nothing on screen to resize
    e.preventDefault();
    const pid = e.pointerId;
    const startX = e.clientX;
    const startW = app.leftWidth;
    let dragging = false;
    const move = (ev) => {
      // A second pointer — another touch, or a pen alongside the mouse — would
      // otherwise drive this same closure from a start point it never measured
      // against.
      if (ev.pointerId !== pid) return;
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      app.leftWidth = clampSidebarWidth(startW + (ev.clientX - startX));
    };
    // One controller for all three listeners, the same net FloatingPanel keeps.
    // pointercancel as well as pointerup: a gesture the browser takes away from
    // us (a pan it decided to claim, a lost capture) never fires pointerup, and
    // the listeners would outlive the drag.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      if (dragging) saveSidebar(); // only a real resize is worth persisting
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // The window-splitter keyboard contract that goes with role="separator":
  // arrows nudge, Home/End go to the stops. Each press persists, the same as
  // each drag does — the writes are one short string and only happen on a key
  // that actually moved the edge.
  function onRailKeyDown(e) {
    if (noSide) return;
    const w = app.leftWidth;
    if (e.key === 'ArrowLeft') app.leftWidth = clampSidebarWidth(w - KEY_STEP);
    else if (e.key === 'ArrowRight') app.leftWidth = clampSidebarWidth(w + KEY_STEP);
    else if (e.key === 'Home') app.leftWidth = SIDEBAR_MIN;
    else if (e.key === 'End') app.leftWidth = SIDEBAR_MAX;
    else return;
    e.preventDefault();
    if (app.leftWidth !== w) saveSidebar();
  }

  function toggleSidebar() {
    app.sidebarHidden = !app.sidebarHidden;
    saveSidebar();
  }

  // The tool strip is not part of the drag surface: a press anywhere inside it,
  // button or padding, belongs to the buttons.
  const keepClick = (e) => e.stopPropagation();
</script>

<!-- The whole strip carries the drag, but it is not the widget: a focusable
     separator is the ARIA window splitter, a range control in the same family
     as slider and scrollbar, and assistive technology is free to prune or
     flatten a range control's children. Four tool buttons inside that subtree
     could go unreachable in browse mode, so the role, the value and the
     keyboard live on the edge band below and the tool strip stays outside it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ed-rail"
  class:hidden={noSide}
  style="left:{noSide ? 0 : app.leftWidth}px"
  onpointerdown={onRailPointerDown}
>
  <!-- The band that advertises the resize — and, being the widget, the thing
       that takes focus and the arrow keys. The seam is on its left edge, which
       is the edge the drag actually moves; the rest of the strip stays a plain
       pointer so it does not claim to be an edge it is not.
       The a11y lint classifies every `separator` as non-interactive and has no
       case for the focusable one, so the two warnings here are the false ones. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="ed-rail-edge"
    role="separator"
    aria-orientation="vertical"
    aria-label="Raw reference width"
    aria-valuenow={app.leftWidth}
    aria-valuemin={SIDEBAR_MIN}
    aria-valuemax={SIDEBAR_MAX}
    tabindex={noSide ? -1 : 0}
    onkeydown={onRailKeyDown}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ed-rail-tools" onpointerdown={keepClick}>
    <!-- All three go together in a translate chapter, and what is left is one
         button: the hand. The caret is not merely redundant there — pressing it
         would advertise a sidebar showing the same raw the canvas already is. -->
    {#if !translate}
      <button
        class="caret"
        onclick={toggleSidebar}
        aria-label={app.sidebarHidden ? 'Show raw reference' : 'Hide raw reference'}
        data-tip={app.sidebarHidden ? 'Show raw reference' : 'Hide raw reference'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d={app.sidebarHidden ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} />
        </svg>
      </button>
      <span class="sep"></span>
      <button
        class:on={app.tool === 'place'}
        onclick={() => setTool('place')}
        aria-label="Place tool"
        data-tip="Place tool — drop queued lines"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
      </button>
      <!-- The Text tool keeps its incidental pan: past 4px of travel the press
           becomes a scroll and adds nothing, which is what stops a slipped click
           from leaving a stray empty box on the page. The hand below is the tool
           for moving around deliberately — with it, no press can ever add a box —
           and it is what the double-click-for-bulk shortcut vacated. -->
      <button
        class:on={app.tool === 'text'}
        onclick={() => setTool('text')}
        aria-label="Text tool"
        data-tip="Text tool — click to add a box, drag to pan"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      </button>
    {/if}
    <button
      class:on={app.tool === 'pan'}
      onclick={() => setTool('pan')}
      aria-label="Hand tool"
      data-tip="Hand tool — drag to move around the page"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0" /><path d="M14 10V4a2 2 0 0 0-4 0v2" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
    </button>
  </div>
</div>
