<script>
  import { onMount } from 'svelte';
  import TextBox from './TextBox.svelte';
  import BulkStylePanel from './BulkStylePanel.svelte';
  import {
    app,
    page,
    placeActiveAt,
    addEmptyBox,
    setTool,
    setPageDims,
    deselect,
    lineByN,
    applyFit,
    setZoom,
    zoomReset,
    openBulk,
  } from './store.svelte.js';
  import { pickJson, pickImages } from './importer.js';

  let scrollEl;
  let pageFrameEl;
  let lastFitKey = '';

  const p = $derived(page());
  const zoomPct = $derived(Math.round(app.zoom * 100));

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
    const startX = e.clientX,
      startY = e.clientY;
    const sl = scrollEl.scrollLeft,
      st = scrollEl.scrollTop;
    let panning = false;
    const move = (ev) => {
      const dx = ev.clientX - startX,
        dy = ev.clientY - startY;
      if (!panning && Math.hypot(dx, dy) > 4) panning = true;
      if (panning) {
        scrollEl.scrollLeft = sl - dx;
        scrollEl.scrollTop = st - dy;
      }
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!panning) {
        const { x, y } = frameCoords(ev);
        addEmptyBox(x, y);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function onMouseMove(e) {
    const r = pageFrameEl.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / app.zoom);
    const y = Math.round((e.clientY - r.top) / app.zoom);
    if (x >= 0 && y >= 0 && x <= p.w && y <= p.h) app.cursor = { x, y };
    else app.cursor = { x: '—', y: '—' };
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
    computeFit(true);
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

<section class="col col-center">
  <div class="panel-head">Editor <span class="tag">{p.cleaned ? 'cleaned page' : 'blank page'}</span></div>
  <div class="editor-wrap">
    <BulkStylePanel />
    <!-- tool dock -->
    <div class="tooldock">
      <button class:on={app.tool === 'place'} onclick={() => setTool('place')} data-tip="Place tool — drop queued lines">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
      </button>
      <button class:on={app.tool === 'text'} class:bulkon={app.bulk.active} onclick={() => setTool('text')} ondblclick={openBulk} data-tip="Text tool — drag to pan, click to add · double-click for bulk style">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      </button>
    </div>

    <div class="editor-scroll" bind:this={scrollEl} onmousemove={onMouseMove}>
      <div class="stage" style={app.bulk.active ? 'cursor:pointer' : app.tool === 'text' ? 'cursor:grab' : ''}>
        <div class="page-frame" bind:this={pageFrameEl} style="width:{p.w * app.zoom}px; height:{p.h * app.zoom}px">
          {#if p.cleaned}
            <img class="page-img" src={p.cleaned} alt="Cleaned page" onload={onCleanedLoad} />
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
      <div class="empty-state" style="display:grid">
        <div class="dropzone">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
          <h2>Import a cleaned page to begin</h2>
          <p>Drop your cleaned manga pages, raw references and translated JSON.</p>
          <div class="row">
            <button class="btn" onclick={() => pickJson()}>Import JSON</button>
            <button class="btn" onclick={() => pickImages('cleaned')}>Import Cleaned</button>
            <button class="btn" onclick={() => pickImages('raw')}>Import Raw</button>
          </div>
        </div>
      </div>
    {/if}

    {#if app.loaded}
      <div class="zoomdock">
        <button onclick={() => computeFit(true)} data-tip="Fit to window">Fit</button>
        <span class="sep"></span>
        <button onclick={() => setZoom(app.zoom / 1.2)}>−</button>
        <button class="zval" onclick={zoomReset}>{zoomPct}%</button>
        <button onclick={() => setZoom(app.zoom * 1.2)}>+</button>
      </div>
    {/if}
  </div>
</section>
