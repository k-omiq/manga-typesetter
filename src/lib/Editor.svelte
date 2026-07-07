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
    setBrushTool,
    setPageDims,
    deselect,
    lineByN,
    applyFit,
    setZoom,
    zoomReset,
    openBulk,
    patchSrc,
    addBrushLayer,
    updateLayerPatch,
    pushBrushUndo,
    toast,
  } from './store.svelte.js';
  import { pickJson, pickImages } from './importer.js';
  import { compositeCleanCanvas } from './exporter.js';
  import { brushInpaint } from './sidecar.js';

  let scrollEl;
  let pageFrameEl;
  let lastFitKey = '';

  const p = $derived(page());
  const zoomPct = $derived(Math.round(app.zoom * 100));
  // Clean mode composites raw + visible patch layers; translate mode shows the
  // cleaned page with text boxes on top.
  const cleanMode = $derived(app.mode === 'clean');
  const baseSrc = $derived(cleanMode ? (p.raw ?? p.clean?.base) : p.cleaned);
  const patches = $derived(cleanMode ? (p.clean?.layers ?? []).filter((l) => l.visible) : []);

  // ---- Phase 4 brush overlay -------------------------------------------------
  // Painted in IMAGE space: the overlay canvas backing store is p.w×p.h and CSS-
  // scaled to the zoomed frame, so pointer coords ÷ zoom map straight to canvas
  // pixels (no DPR math — the image-res store is already ≥ display res). Every
  // stroke commits to its own clean.layers patch (kind:'brush').
  const brushActive = $derived(cleanMode && app.tool === 'brush');
  const ACCENT = '75,123,236';
  let brushEl;
  let ringX = $state(0),
    ringY = $state(0),
    ringVisible = $state(false);
  let strokeActive = false;
  let strokeStart = { x: 0, y: 0 };
  const ringSize = $derived(app.brush.size * app.zoom);

  function loadImg(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  }

  function brushCoords(e) {
    const r = brushEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / app.zoom, y: (e.clientY - r.top) / app.zoom };
  }

  function dab(ctx, x, y) {
    const rad = Math.max(0.5, app.brush.size / 2);
    const h = Math.max(0, Math.min(1, app.brush.hardness));
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(${ACCENT},1)`);
    g.addColorStop(Math.min(0.999, h), `rgba(${ACCENT},1)`);
    g.addColorStop(1, `rgba(${ACCENT},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  function strokeTo(ctx, from, to) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(1, app.brush.size * 0.2);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) dab(ctx, from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
  }

  function alphaBBox(data, W, H) {
    let minX = W,
      minY = H,
      maxX = -1,
      maxY = -1;
    const d = data.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  }

  async function sampleColor(pt) {
    const p2 = page();
    const comp = await compositeCleanCanvas(p2);
    const x = Math.max(0, Math.min(p2.w - 1, Math.round(pt.x)));
    const y = Math.max(0, Math.min(p2.h - 1, Math.round(pt.y)));
    const [r, g, b] = comp.getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    app.brush.color = hex;
    toast(`Sampled ${hex}`);
  }

  function onBrushDown(e) {
    if (!brushActive || app.brush.busy) return;
    e.preventDefault();
    try {
      brushEl.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort — a stroke still works without it */
    }
    const pt = brushCoords(e);
    const tool = app.brush.tool;
    // Alt = anchor/eyedropper (no stroke).
    if (e.altKey) {
      if (tool === 'clone') {
        app.brush.cloneSource = { x: pt.x, y: pt.y };
        toast('Clone source set — paint to stamp');
      } else if (tool === 'fill') {
        sampleColor(pt);
      }
      return;
    }
    if (tool === 'clone' && !app.brush.cloneSource) {
      toast('Alt-click to set a clone source first');
      return;
    }
    if (tool === 'erase' && !app.selectedLayerId) {
      toast('Select a layer to erase from');
      return;
    }
    strokeActive = true;
    strokeStart = pt;
    const ctx = brushEl.getContext('2d');
    dab(ctx, pt.x, pt.y);
    brushEl._last = pt;
  }

  function onBrushMove(e) {
    if (!brushActive) return;
    const pt = brushCoords(e);
    ringX = pt.x * app.zoom;
    ringY = pt.y * app.zoom;
    if (!strokeActive) return;
    const ctx = brushEl.getContext('2d');
    strokeTo(ctx, brushEl._last, pt);
    brushEl._last = pt;
  }

  async function onBrushUp(e) {
    if (!strokeActive) return;
    strokeActive = false;
    try {
      brushEl.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    // Busy for the whole commit (all tools await something), so onBrushDown
    // blocks a second stroke and can't race — e.g. two erases lost-updating a
    // layer's patch. Cleared even if the commit throws.
    app.brush.busy = true;
    try {
      await commitStroke(app.brush.tool);
    } finally {
      app.brush.busy = false;
    }
  }

  async function commitStroke(tool) {
    const p2 = page();
    const W = p2.w,
      H = p2.h;
    const octx = brushEl.getContext('2d');
    const data = octx.getImageData(0, 0, W, H);
    const bbox = alphaBBox(data, W, H);
    const clear = () => octx.clearRect(0, 0, W, H);
    if (!bbox) return clear();
    const { minX, minY, maxX, maxY } = bbox;
    const bw = maxX - minX + 1,
      bh = maxY - minY + 1;

    if (tool === 'inpaint') {
      // Full-page grayscale mask (alpha → luminance) for the sidecar.
      const mask = document.createElement('canvas');
      mask.width = W;
      mask.height = H;
      const mctx = mask.getContext('2d');
      const md = mctx.createImageData(W, H);
      for (let i = 0; i < data.data.length; i += 4) {
        const a = data.data[i + 3];
        md.data[i] = md.data[i + 1] = md.data[i + 2] = a;
        md.data[i + 3] = 255;
      }
      mctx.putImageData(md, 0, 0);
      const maskB64 = mask.toDataURL('image/png').split(',')[1];
      clear();
      try {
        const comp = await compositeCleanCanvas(p2);
        const blob = await new Promise((r) => comp.toBlob(r, 'image/png'));
        const layer = await brushInpaint(blob, maskB64, { method: app.brush.method, flux: app.brush.flux });
        addBrushLayer({ op: 'inpaint', box: layer.box, patchPng: layer.patch_png, method: layer.method, fellBack: layer.fell_back }, p2);
        toast(`Brush fill → ${layer.method}${layer.fell_back ? ' (flux→cv2)' : ''}`);
      } catch (err) {
        toast('Brush fill failed: ' + (err?.message || err));
      }
      return;
    }

    if (tool === 'clone') {
      if (!app.brush.cloneSource) return clear();
      const off = { x: strokeStart.x - app.brush.cloneSource.x, y: strokeStart.y - app.brush.cloneSource.y };
      const comp = await compositeCleanCanvas(p2);
      const patch = document.createElement('canvas');
      patch.width = bw;
      patch.height = bh;
      const pctx = patch.getContext('2d');
      pctx.drawImage(comp, minX - off.x, minY - off.y, bw, bh, 0, 0, bw, bh);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.drawImage(brushEl, minX, minY, bw, bh, 0, 0, bw, bh);
      clear();
      addBrushLayer({ op: 'clone', box: [minX, minY, bw, bh], patchPng: patch.toDataURL('image/png').split(',')[1] }, p2);
      toast('Cloned → new layer');
      return;
    }

    if (tool === 'fill') {
      const patch = document.createElement('canvas');
      patch.width = bw;
      patch.height = bh;
      const pctx = patch.getContext('2d');
      pctx.fillStyle = app.brush.color;
      pctx.fillRect(0, 0, bw, bh);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.drawImage(brushEl, minX, minY, bw, bh, 0, 0, bw, bh);
      clear();
      addBrushLayer({ op: 'fill', box: [minX, minY, bw, bh], patchPng: patch.toDataURL('image/png').split(',')[1] }, p2);
      toast('Painted → new layer');
      return;
    }

    if (tool === 'erase') {
      const l = p2.clean?.layers.find((x) => x.id === app.selectedLayerId);
      if (!l) return clear();
      const [lx, ly, lw, lh] = l.box;
      const patch = document.createElement('canvas');
      patch.width = lw;
      patch.height = lh;
      const pctx = patch.getContext('2d');
      const src = patchSrc(l);
      if (src) {
        try {
          pctx.drawImage(await loadImg(src), 0, 0, lw, lh);
        } catch {
          /* draw nothing if the patch fails to decode */
        }
      }
      pctx.globalCompositeOperation = 'destination-out';
      pctx.drawImage(brushEl, lx, ly, lw, lh, 0, 0, lw, lh);
      clear();
      pushBrushUndo({ type: 'erase', id: l.id, prevPatchPng: l.patchPng, page: p2 });
      updateLayerPatch(l.id, patch.toDataURL('image/png').split(',')[1], p2);
      toast('Erased from layer');
      return;
    }
  }

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
      {#if cleanMode}
        <button class:on={app.tool === 'brush'} onclick={() => setBrushTool(app.brush.tool)} data-tip="Brush tools — manual clean-up (pick a tool in the Brush panel)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.06 11.9l8.07-8.06a1.9 1.9 0 0 1 2.7 2.7l-8.06 8.07" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></svg>
        </button>
      {/if}
    </div>

    <div class="editor-scroll" bind:this={scrollEl} onmousemove={onMouseMove}>
      <div class="stage" style={app.bulk.active ? 'cursor:pointer' : app.tool === 'text' ? 'cursor:grab' : ''}>
        <div class="page-frame" bind:this={pageFrameEl} style="width:{p.w * app.zoom}px; height:{p.h * app.zoom}px">
          {#if baseSrc}
            <img class="page-img" src={baseSrc} alt={cleanMode ? 'Raw page' : 'Cleaned page'} onload={onCleanedLoad} />
          {/if}
          {#each patches as l (l.id)}
            <img
              class="patch"
              class:sel={app.selectedLayerId === l.id}
              src={patchSrc(l)}
              alt=""
              style="left:{l.box[0] * app.zoom}px; top:{l.box[1] * app.zoom}px; width:{l.box[2] * app.zoom}px; height:{l.box[3] * app.zoom}px;"
            />
          {/each}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="boxlayer" onpointerdown={onLayerPointerDown}>
            {#each p.boxes as box (box.id)}
              <TextBox {box} {pageFrameEl} />
            {/each}
          </div>
          {#if cleanMode}
            <!-- Brush overlay: image-res canvas, CSS-scaled to the zoomed frame.
                 Captures pointer events only while a brush tool is active, so it
                 never steals clicks from place/text or translate mode. -->
            <canvas
              class="brushoverlay"
              class:active={brushActive}
              bind:this={brushEl}
              width={p.w}
              height={p.h}
              style="width:{p.w * app.zoom}px; height:{p.h * app.zoom}px;"
              onpointerdown={onBrushDown}
              onpointermove={onBrushMove}
              onpointerup={onBrushUp}
              onpointerenter={() => (ringVisible = true)}
              onpointerleave={() => (ringVisible = false)}
            ></canvas>
            {#if brushActive && ringVisible}
              <div class="brushring" style="left:{ringX}px; top:{ringY}px; width:{ringSize}px; height:{ringSize}px;"></div>
            {/if}
          {/if}
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

<style>
  /* Clean-mode patch layers: cleaned bbox pixels overlaid on the raw page. */
  .patch {
    position: absolute;
    pointer-events: none;
    image-rendering: auto;
  }
  .patch.sel {
    outline: 2px solid var(--accent, #4b7bec);
    outline-offset: -1px;
  }
  /* Brush overlay: transparent except during a stroke; only grabs pointer events
     while a brush tool is engaged, so place/text/translate stay untouched. */
  .brushoverlay {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    image-rendering: auto;
    touch-action: none;
  }
  .brushoverlay.active {
    pointer-events: auto;
    cursor: crosshair;
  }
  /* Live brush cursor ring (image-scaled diameter). */
  .brushring {
    position: absolute;
    border: 1.5px solid rgba(75, 123, 236, 0.9);
    border-radius: 50%;
    pointer-events: none;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
</style>
