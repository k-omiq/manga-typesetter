<script>
  // One floating editor window: a titled, draggable, resizable, hideable frame
  // around whatever the caller renders. It owns pointer work only — every rule
  // about where a panel may end up lives in panels.svelte.js, which is tested
  // without a browser.
  import {
    panels,
    movePanel,
    resizePanel,
    setHidden,
    raisePanel,
    clampAll,
    MIN_W,
    MIN_H,
  } from './panels.svelte.js';

  let { id, title, count = null, children } = $props();

  const g = $derived(panels[id]);

  function drag(e, kind) {
    if (e.button !== 0) return;
    // The header is the drag handle, so the hide button lives inside it. Without
    // this the button's own pointerdown would arm a drag and the click would
    // land as a one-pixel move instead of a hide.
    if (e.target.closest?.('.fpanel-hide')) return;
    e.preventDefault();
    raisePanel(id);
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === 'move') {
        movePanel(id, o.x + dx, o.y + dy);
      } else {
        resizePanel(id, Math.max(MIN_W, o.w + dx), Math.max(MIN_H, o.h + dy));
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      // Clamped on drop, not per frame: clamping under a held pointer fights the
      // cursor, the panel lagging behind the hand that is dragging it. Waiting
      // for the release keeps the gesture honest and still guarantees the
      // invariant — no drag can leave a panel, or its collapsed stub, outside
      // the window where the user cannot reach it again.
      clampAll(window.innerWidth, window.innerHeight);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
</script>

{#if g.hidden}
  <button
    class="panel-stub"
    style="left:{g.x}px; top:{g.y}px; z-index:{g.z}"
    onclick={() => {
      setHidden(id, false);
      raisePanel(id);
    }}
    title="Show {title}"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6" /></svg>
    {title}
  </button>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="fpanel"
    style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px; z-index:{g.z}"
    onpointerdown={() => raisePanel(id)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="fpanel-head" onpointerdown={(e) => drag(e, 'move')}>
      <span class="fpanel-title">{title}</span>
      {#if count}<span class="fpanel-count">{count}</span>{/if}
      <button class="fpanel-hide" onclick={() => setHidden(id, true)} title="Hide {title}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </header>
    <div class="fpanel-body">{@render children()}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fpanel-grip" onpointerdown={(e) => drag(e, 'resize')}></div>
  </section>
{/if}
