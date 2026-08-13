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
  import { app, setTool, openBulk, saveSidebar, clampSidebarWidth } from '../store.svelte.js';

  // A press on the rail stays ambiguous until it travels: under 4px it is still
  // a click on whatever it landed on, and only past that does it become a
  // resize. The buttons stop their own pointerdown from reaching the rail, so
  // this never starts from one of them — the threshold is for the strip itself,
  // where a twitchy click would otherwise nudge the sidebar a pixel or two.
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

  function toggleSidebar() {
    app.sidebarHidden = !app.sidebarHidden;
    saveSidebar();
  }

  // Every button sits inside the rail's own drag surface, so each one has to
  // claim its press before the rail sees it.
  const keepClick = (e) => e.stopPropagation();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ed-rail"
  class:hidden={app.sidebarHidden}
  style="left:{app.sidebarHidden ? 0 : app.leftWidth}px"
  onpointerdown={onRailPointerDown}
>
  <div class="ed-rail-tools">
    <button
      class="caret"
      onpointerdown={keepClick}
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
      onpointerdown={keepClick}
      onclick={() => setTool('place')}
      aria-label="Place tool"
      data-tip="Place tool — drop queued lines"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
    </button>
    <button
      class:on={app.tool === 'text'}
      onpointerdown={keepClick}
      onclick={() => setTool('text')}
      ondblclick={openBulk}
      aria-label="Text tool"
      data-tip="Text tool — drag to pan, click to add · double-click for bulk style"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
    </button>
    <button
      class:on={app.bulk.active}
      onpointerdown={keepClick}
      onclick={openBulk}
      aria-label="Bulk style"
      data-tip="Bulk style — one style, many boxes"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 14l9 5 9-5" /></svg>
    </button>
  </div>
</div>
