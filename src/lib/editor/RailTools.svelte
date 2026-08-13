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
    openBulk,
    closeBulk,
    saveSidebar,
    clampSidebarWidth,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  } from '../store.svelte.js';

  // How far one arrow key moves the edge. Coarse enough to cross the range in a
  // reasonable number of presses, fine enough to land where you meant to.
  const KEY_STEP = 16;

  // A press on the rail stays ambiguous until it travels: under 4px it is still
  // a click on whatever it landed on, and only past that does it become a
  // resize. The tool strip stops its own pointerdown from reaching here, so
  // this never starts from a button — or from the padding between them, which
  // is why the guard sits on the strip rather than on each button.
  function onRailPointerDown(e) {
    if (app.sidebarHidden) return; // nothing on screen to resize
    e.preventDefault();
    const startX = e.clientX;
    const startW = app.leftWidth;
    let dragging = false;
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      app.leftWidth = clampSidebarWidth(startW + (ev.clientX - startX));
    };
    // pointercancel as well as pointerup: a gesture the browser takes away from
    // us (a pan it decided to claim, a lost capture) never fires pointerup, and
    // the listeners would outlive the drag.
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (dragging) saveSidebar(); // only a real resize is worth persisting
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  // The window-splitter keyboard contract that goes with role="separator":
  // arrows nudge, Home/End go to the stops. Each press persists, the same as
  // each drag does — the writes are one short string and only happen on a key
  // that actually moved the edge.
  function onRailKeyDown(e) {
    if (app.sidebarHidden) return;
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

  // The bulk button is lit while bulk mode is on, so its second press has to be
  // the way out of it. `openBulk` on an already-open mode would silently empty
  // the targets the user had picked and reseed the style; `closeBulk` is what
  // Escape and the panel's own Cancel already do.
  const toggleBulk = () => (app.bulk.active ? closeBulk() : openBulk());

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
  class:hidden={app.sidebarHidden}
  style="left:{app.sidebarHidden ? 0 : app.leftWidth}px"
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
    tabindex={app.sidebarHidden ? -1 : 0}
    onkeydown={onRailKeyDown}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ed-rail-tools" onpointerdown={keepClick}>
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
    <button
      class:on={app.tool === 'text'}
      onclick={() => setTool('text')}
      ondblclick={openBulk}
      aria-label="Text tool"
      data-tip="Text tool — drag to pan, click to add · double-click for bulk style"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
    </button>
    <button
      class:on={app.bulk.active}
      onclick={toggleBulk}
      aria-label="Bulk style"
      data-tip="Bulk style — one style, many boxes"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 14l9 5 9-5" /></svg>
    </button>
  </div>
</div>
