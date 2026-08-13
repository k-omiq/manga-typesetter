<script>
  // One floating editor window: a titled, draggable, resizable, hideable frame
  // around whatever the caller renders. It owns pointer work only — every rule
  // about where a panel may end up lives in panels.svelte.js, which is tested
  // without a browser.
  import { panels, movePanel, resizePanel, setHidden, raisePanel, clampAll } from './panels.svelte.js';

  let { id, title, count = null, children } = $props();

  const g = $derived(panels[id]);

  // The panels float over every piece of editor chrome (the bulk-style panel is
  // 40) and under the modal layer (100+). The stored z is 1..n and only orders
  // the panels among themselves.
  const LAYER = 50;

  // The controller for the gesture in flight, so an unmount can end that one
  // too. It is the same leak as a cancelled pointer wearing different clothes:
  // the listeners live on `document`, nothing guarantees a further pointer
  // event once the component is gone, and they would go on writing geometry.
  let active = null;
  $effect(() => () => active?.abort());

  function drag(e, kind) {
    if (e.button !== 0) return;
    // The header is the drag handle, so the hide button lives inside it. Without
    // this the button's own pointerdown would arm a drag and the click would
    // land as a one-pixel move instead of a hide.
    if (e.target.closest?.('.fpanel-hide')) return;
    e.preventDefault();
    raisePanel(id);
    const pid = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    e.currentTarget.setPointerCapture?.(pid);
    const move = (ev) => {
      // A second finger, or the other mouse button, would otherwise arm its own
      // drag and the two closures would fight over the same panel.
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === 'move') movePanel(id, o.x + dx, o.y + dy);
      else resizePanel(id, o.w + dx, o.h + dy);
    };
    // One controller for all three listeners, because a gesture does not always
    // end in a pointerup: a cancelled pointer (an OS gesture takes over, the
    // captured element leaves the DOM) fires pointercancel instead, and a move
    // handler that survives that would track the cursor with no button held and
    // save on every frame, with nothing left to stop it.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      active = null;
      ac.abort();
      // Clamped on drop, not per frame: clamping under a held pointer fights the
      // cursor, the panel lagging behind the hand that is dragging it. Waiting
      // for the release keeps the gesture honest and still guarantees the
      // invariant — no drag can leave a panel, or its collapsed stub, outside
      // the window where the user cannot reach it again.
      clampAll(window.innerWidth, window.innerHeight);
    };
    active = ac;
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }
</script>

{#if g.hidden}
  <button
    class="panel-stub"
    style="left:{g.x}px; top:{g.y}px; z-index:{LAYER + g.z}"
    onclick={() => {
      setHidden(id, false);
      raisePanel(id);
    }}
    aria-label={'Show ' + title}
    title="Show {title}"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
    {title}
  </button>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="fpanel"
    style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px; z-index:{LAYER + g.z}"
    onpointerdown={() => raisePanel(id)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="fpanel-head" onpointerdown={(e) => drag(e, 'move')}>
      <span class="fpanel-title">{title}</span>
      {#if count}<span class="fpanel-count">{count}</span>{/if}
      <button
        class="fpanel-hide"
        onclick={() => setHidden(id, true)}
        aria-label="Hide {title}"
        title="Hide {title}"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </header>
    <div class="fpanel-body">{@render children()}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fpanel-grip" onpointerdown={(e) => drag(e, 'resize')}></div>
  </section>
{/if}
