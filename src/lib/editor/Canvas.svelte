<script>
  // The page itself, and nothing else. Everything that used to sit around it —
  // the panel header, the tool dock, the zoom dock — is now chrome floating over
  // the full-bleed canvas, owned by EditorRoot. What is left is the scroll
  // viewport, the page frame and the boxes on it.
  import { onMount } from 'svelte';
  import TextBox from '../TextBox.svelte';
  import {
    app,
    page,
    placeActiveAt,
    addEmptyBox,
    setPageDims,
    deselect,
    lineByN,
    applyFit,
    setZoom,
  } from '../store.svelte.js';

  // The dock's Fit button has no page geometry of its own, and the fit has to be
  // measured against this scroll container rather than the window — the canvas
  // layer is inset from the left by the reference sidebar and the rail. So the
  // measurement stays here and the button reaches it through this handle.
  let { onReady } = $props();

  let scrollEl;
  let pageFrameEl;
  let lastFitKey = '';

  const p = $derived(page());
  // Typeset on the cleaned page when there is one; otherwise fall back to the
  // raw so an imported raws-only chapter still shows something to place on.
  const baseSrc = $derived(p.cleaned ?? p.raw);

  function computeFit(force = false) {
    if (!scrollEl) return;
    const r = scrollEl.getBoundingClientRect();
    const key = Math.round(r.width) + 'x' + Math.round(r.height) + '@' + p.w + 'x' + p.h;
    if (!force && key === lastFitKey) return;
    lastFitKey = key;
    const margin = 100;
    const z = Math.min((r.width - margin) / p.w, (r.height - margin) / p.h);
    if (z > 0 && isFinite(z)) applyFit(z);
  }

  // Every gesture in flight, so an unmount can end them all — see the same set
  // in FloatingPanel. The listeners live on `document` and nothing guarantees a
  // further pointer event once this component is gone.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function frameCoords(e) {
    const r = pageFrameEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / app.zoom, y: (e.clientY - r.top) / app.zoom };
  }

  function onLayerPointerDown(e) {
    if (!e.target.classList.contains('boxlayer')) return;
    if (app.bulk.active) return; // bulk mode: only box clicks matter
    // Text tool doubles as a hand: drag the empty canvas to pan, click to add a box.
    if (app.tool === 'text') {
      startTextPointer(e);
      return;
    }
    const { x, y } = frameCoords(e);
    const pg = page();
    if (pg.activeLineN != null && lineByN(pg, pg.activeLineN)) placeActiveAt(x, y);
    else deselect();
  }

  function startTextPointer(e) {
    const pid = e.pointerId;
    const startX = e.clientX,
      startY = e.clientY;
    const sl = scrollEl.scrollLeft,
      st = scrollEl.scrollTop;
    let panning = false;
    const move = (ev) => {
      // A second finger, or the other mouse button, would otherwise drive this
      // same closure from a start point it never measured against.
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - startX,
        dy = ev.clientY - startY;
      if (!panning && Math.hypot(dx, dy) > 4) panning = true;
      if (panning) {
        scrollEl.scrollLeft = sl - dx;
        scrollEl.scrollTop = st - dy;
      }
    };
    // One controller for both endings, the same net FloatingPanel and TextBox
    // keep: a gesture the browser takes away from us — an OS gesture claiming
    // the pointer, a lost capture — fires pointercancel and never a pointerup,
    // and a pan handler that survived it would follow the cursor with nothing
    // held and nothing left to stop it. A cancelled press adds no box: the
    // gesture was taken away, not finished.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      if (!panning && ev.type === 'pointerup') {
        const { x, y } = frameCoords(ev);
        addEmptyBox(x, y);
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  function onCleanedLoad(e) {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setPageDims(img.naturalWidth, img.naturalHeight);
      if (app.isFit) computeFit(true);
    }
  }

  // refit when switching pages
  $effect(() => {
    app.pageIndex;
    if (app.isFit) computeFit(true);
  });

  onMount(() => {
    // Handed up before the first fit, so a parent that wants to drive one has it
    // from the first frame.
    onReady?.({ fit: () => computeFit(true) });
    computeFit(true);
    // The observer is why the fit needs no knowledge of the sidebar: dragging the
    // rail, hiding the reference, resizing the window all change this element's
    // box, and each of them re-measures. The floating panels do not — they are
    // deliberately ignored, so a panel dragged over the page covers it rather
    // than reflowing it.
    const ro = new ResizeObserver(() => {
      if (app.isFit) computeFit();
    });
    ro.observe(scrollEl);
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(app.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
      }
    };
    scrollEl.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      scrollEl.removeEventListener('wheel', onWheel);
    };
  });
</script>

<div class="editor-scroll" bind:this={scrollEl}>
  <div class="stage" style={app.bulk.active ? 'cursor:pointer' : app.tool === 'text' ? 'cursor:grab' : ''}>
    <div class="page-frame" bind:this={pageFrameEl} style="width:{p.w * app.zoom}px; height:{p.h * app.zoom}px">
      {#if baseSrc}
        <img class="page-img" src={baseSrc} alt="Page" onload={onCleanedLoad} />
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="boxlayer" onpointerdown={onLayerPointerDown}>
        {#each p.boxes as box (box.id)}
          <TextBox {box} {pageFrameEl} />
        {/each}
      </div>
    </div>
  </div>
</div>

{#if !app.loaded}
  <div class="empty-state">
    <div class="dropzone">
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
      <h2>Nothing open</h2>
      <p>Pages come from your library — open a chapter to typeset it.</p>
    </div>
  </div>
{/if}
