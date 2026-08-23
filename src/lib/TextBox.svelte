<script>
  import {
    app,
    page,
    selectBox,
    markUnsaved,
    fontCssFor,
    boxText,
    beginEdit,
    endEdit,
    lineByN,
    toggleBulkTarget,
    isBulkTarget,
    cloneStyle,
    rememberStyle,
    settleEdits,
    setBoxText,
    autoFitBox,
    autoFitBoxTo,
    focusPage,
  } from './store.svelte.js';
  import { untrack } from 'svelte';
  import { record } from './editor/history.svelte.js';
  import {
    createFieldUndo,
    recordFieldEdit,
    resyncField,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { arcLayout, circleLayout, pathLayout, pathPolyline, removePathAnchor, applyCase, layoutLines, BOX_PAD, balloonWidthsFor } from './measure.js';
  import {
    strokeBands,
    rgba,
    gradientCss,
    patternTilePx,
    patternTileCanvas,
    motionBlurPreviewTaps,
    drawClipShapes,
    clipActive,
    inkActive,
    inkExtent,
    drawInk,
    OCTAVES,
    TILE_SS,
  } from './text-paint.js';
  import { maskTool } from './mask-tool.svelte.js';

  // pg defaults to current page; longstrip passes explicit page.
  let { box, pageFrameEl, pg = page() } = $props();

  const z = $derived(app.zoom);
  const selected = $derived(app.selectedId === box.id);
  const editing = $derived(app.editingId === box.id);
  const bulkOn = $derived(app.bulk.active);
  const bulkTarget = $derived(isBulkTarget(box.id));
  const s = $derived(box.style);
  const text = $derived(boxText(box, pg));

  const line = $derived(box.lineN != null ? lineByN(pg, box.lineN) : null);
  const jp = $derived(line?.jp ?? '');
  const isSfx = $derived(line?.type === 'sfx');

  const effSize = $derived(s.size * z);
  const effLs = $derived(s.letterSpacing * z);

  const justify = $derived(
    s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center',
  );
  const alignItems = $derived(
    s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
  );

  const roughId = `rough-${box.id}`;
  const mbId = `mb-${box.id}`;

  // The directional smear's tap list: here each tap becomes an feOffset plus
  // an arithmetic accumulate. Offsets are page px, the filter runs in zoomed
  // px, so they scale by the zoom exactly as the blur radius does. The PREVIEW
  // list, not the exporter's full one - every named result in the SVG chain is
  // its own raster surface in WebKit, so the live filter samples the same
  // smear coarser (see motionBlurPreviewTaps).
  const mbTaps = $derived(
    s.motionBlur?.on
      ? motionBlurPreviewTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount)
      : [],
  );

  // The filter region, sized to what the smear can actually reach instead of a
  // flat 400%. The region is what WebKit allocates every intermediate surface
  // over, so on a large box the fixed margin was paying for megapixels of
  // guaranteed-empty raster per tap. Ink is allowed the same overreach the
  // clip mask grants (MASK_EXPAND page px) plus the furthest tap offset; each
  // side is that in percent of the box, floored at 50% and capped at the old
  // 150% so the region only ever shrinks.
  const mbRegion = $derived.by(() => {
    if (!mbTaps.length) return null;
    let mx = 0;
    let my = 0;
    for (const t of mbTaps) {
      if (Math.abs(t.dx) > mx) mx = Math.abs(t.dx);
      if (Math.abs(t.dy) > my) my = Math.abs(t.dy);
    }
    const side = (reach, size) => Math.min(150, Math.max(50, Math.ceil(((MASK_EXPAND + reach) / Math.max(1, size)) * 100)));
    const px = side(mx, box.w);
    const py = side(my, box.h);
    return { x: `-${px}%`, y: `-${py}%`, w: `${100 + 2 * px}%`, h: `${100 + 2 * py}%` };
  });

  // How far past the box the editor's mask image reaches, page px each side.
  // The mask has to cover overflowing text (a path outside the box, a huge
  // glyph) or CSS masks it to nothing; past this margin, ink is cut off -
  // the price of a finite image, stated once.
  const MASK_EXPAND = 300;

  // The mask as a CSS mask-image, drawn by the same painter the exporter
  // composites with (drawClipShapes). Exclude paints the world white and
  // erases the shapes; include paints only the shapes.
  //
  // A blob URL, not a data URL, and that is the point of the shape below: a
  // data URL cannot be revoked, so every rebuild left its decoded bitmap in
  // WebKit's image cache with nothing entitled to evict it, and rebuilds
  // happen - auto-fit moves `box.h` while the user types. Two defences here:
  // the canvas extent is bucketed to MASK_STEP so a keystroke-sized resize
  // reuses the standing image (mask-size covers the slack), and when a rebuild
  // does happen the old URL is revoked the moment the new one lands, which is
  // what lets the renderer give the old bitmap back.
  const MASK_STEP = 32;
  let maskUrl = $state('');
  let maskW = $state(0); // page px the mask image spans, MASK_EXPAND included
  let maskH = $state(0);
  let maskKey = '';
  let maskLive = ''; // non-reactive twin of maskUrl: what revocation acts on
  let maskSeq = 0; // drops a toBlob that lands after a newer build or destroy
  const setMask = (url, w, h) => {
    if (maskLive && maskLive !== url) URL.revokeObjectURL(maskLive);
    maskLive = url;
    maskUrl = url;
    maskW = w;
    maskH = h;
  };
  $effect(() => {
    if (!clipActive(s.clip)) {
      maskKey = '';
      maskSeq++;
      setMask('', 0, 0);
      return;
    }
    const qz = Math.min(1, Math.max(0.125, Math.round(z * 8) / 8));
    const w = Math.ceil((box.w + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const h = Math.ceil((box.h + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const key = JSON.stringify([s.clip.shapes, s.clip.mode, qz, w, h]);
    if (key === maskKey) return;
    maskKey = key;
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(2, Math.round(w * qz));
    cnv.height = Math.max(2, Math.round(h * qz));
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.scale(cnv.width / w, cnv.height / h);
    ctx.translate(MASK_EXPAND, MASK_EXPAND);
    if (s.clip.mode === 'include') {
      drawClipShapes(ctx, s.clip.shapes);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-MASK_EXPAND, -MASK_EXPAND, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      drawClipShapes(ctx, s.clip.shapes);
    }
    const seq = ++maskSeq;
    if (typeof cnv.toBlob === 'function') {
      // Async, so the standing mask holds the frame until the new one is
      // ready - the swap is invisible. A build superseded before its encode
      // lands is dropped unminted.
      cnv.toBlob((b) => {
        if (seq !== maskSeq || !b) return;
        setMask(URL.createObjectURL(b), w, h);
      });
    } else {
      // jsdom and friends: no toBlob, no image cache to leak into either.
      setMask(cnv.toDataURL(), w, h);
    }
  });
  // Reads nothing reactive, so it runs once and its cleanup is the destroy
  // path: the last URL goes back, and the seq bump orphans any encode still in
  // flight.
  $effect(() => {
    return () => {
      maskSeq++;
      if (maskLive) URL.revokeObjectURL(maskLive);
    };
  });
  const maskCss = $derived.by(() => {
    if (!clipActive(s.clip) || !maskUrl) return '';
    const sz = `${maskW * z}px ${maskH * z}px`;
    const pos = `${-MASK_EXPAND * z}px ${-MASK_EXPAND * z}px`;
    return (
      `-webkit-mask-image:url(${maskUrl});mask-image:url(${maskUrl});` +
      `-webkit-mask-size:${sz};mask-size:${sz};` +
      `-webkit-mask-position:${pos};mask-position:${pos};` +
      `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`
    );
  });

  // ---- ink ----
  // The strokes, drawn on a canvas over the box. The exporter paints the same
  // strokes with the same painter, so this is a preview of the file rather than
  // an approximation of it. It is sized to the box plus however far the ink
  // reaches outside it - a stroke drawn over the edge must not be cut off here
  // any more than it is on export.
  let inkEl = $state(null);
  const inkPad = $derived(inkActive(s.ink) ? inkExtent(s.ink) : 0);
  const inkKey = $derived(
    inkActive(s.ink) ? JSON.stringify(s.ink) + `|${box.w}|${box.h}|${z}` : '',
  );
  let inkDrawn = '';
  let inkLive = null; // non-reactive twin of inkEl: what the pixel release acts on
  $effect(() => {
    const key = inkKey;
    const el = inkEl;
    if (!el) {
      // The canvas is gone (ink switched off, or the box is being torn down).
      // Hand its pixels back now, and forget what was drawn: switching the same
      // ink back on mints a *new* blank canvas, and a remembered key would let
      // it stay blank.
      if (inkLive) {
        inkLive.width = 0;
        inkLive.height = 0;
        inkLive = null;
      }
      inkDrawn = '';
      return;
    }
    inkLive = el;
    if (key === inkDrawn) return;
    inkDrawn = key;
    const w = Math.max(1, Math.round((box.w + inkPad * 2) * z));
    const h = Math.max(1, Math.round((box.h + inkPad * 2) * z));
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!key) return;
    ctx.scale(z, z);
    ctx.translate(inkPad, inkPad);
    drawInk(ctx, s.ink);
  });
  // A box scrolled off the page keeps its canvas alive otherwise, and a chapter
  // of inked boxes is exactly the shape that put 2 GB in the webview before.
  // Reads nothing reactive, so it runs once and its cleanup is the destroy path;
  // it zeroes the twin rather than the binding, which teardown may already have
  // nulled.
  $effect(() => () => {
    if (inkLive) {
      inkLive.width = 0;
      inkLive.height = 0;
      inkLive = null;
    }
  });

  const boxStyle = $derived(
    `left:${box.x * z}px;top:${box.y * z}px;width:${box.w * z}px;height:${box.h * z}px;` +
      `padding:${2 * z}px;` +
      `transform:rotate(${s.rotation}deg);justify-content:${justify};align-items:${alignItems};` +
      `opacity:${s.opacity}`,
  );


  // The font and the block's own metrics: everything that decides WHERE a glyph
  // lands. Every layer of the stack below carries it, because they are copies of
  // the same block and have to lay out identically; what differs between them is
  // only how the glyphs are painted.
  const textStyle = $derived(
    `font-family:${fontCssFor(s.font)};font-weight:${s.bold ? 700 : 400};` +
      `font-style:${s.italic ? 'italic' : 'normal'};text-align:${s.align};` +
      `line-height:${s.lineHeight};font-size:${effSize}px;letter-spacing:${effLs}px;` +
      `text-transform:${s.uppercase ? 'uppercase' : 'none'};`,
  );

  // The whole-text filters, applied to the composite of every layer: the blur,
  // then the directional smear, then roughening's SVG displacement. One
  // `filter` list, in that order, because a roughened edge should be blurred
  // and smeared rather than the other way round - and the exporter runs its
  // three passes in the same order.
  const filterCss = $derived.by(() => {
    const f = [];
    if (s.blur > 0) f.push(`blur(${s.blur * z}px)`);
    if (mbTaps.length) f.push(`url(#${mbId})`);
    if (s.roughen.on) f.push(`url(#${roughId})`);
    return f.length ? `filter:${f.join(' ')};` : '';
  });

  // The paint, as a stack of copies of the same text block: shadows underneath,
  // then one layer per stroke from the outermost in, then the fill on top. It is
  // the exporter's paint order stated in DOM terms, and the reason it is a stack
  // rather than one element is that CSS gives an element ONE text colour and ONE
  // stroke - so a second stroke, or a shadow cast from the strokes rather than
  // from the glyphs, has nowhere else to live.
  //
  // Each layer holds the same lines, so they lay out on top of one another
  // exactly; the first is in normal flow and gives the block its size, and the
  // rest are absolutely positioned over it (see the styles at the foot of this
  // file). A shadow layer's translate and blur do not move its layout box, which
  // is why offsetting it cannot shift the layers stacked on it.
  const layers = $derived.by(() => {
    const out = [];
    const bands = strokeBands(s.strokes);
    // shadows[0] paints on top of shadows[1], so the list is walked backwards.
    for (let i = (s.shadows?.length ?? 0) - 1; i >= 0; i--) {
      const sh = s.shadows[i];
      // The shadow's shape is the glyphs plus every stroke, which is exactly
      // what this layer draws: the outermost stroke and the fill, both in the
      // shadow's colour. A CSS blur radius is the gaussian sigma while the
      // canvas takes twice it, hence the halving - see paintShadows.
      let css = `color:${sh.color};`;
      if (bands.length) css += `-webkit-text-stroke:${bands[0].line * z}px ${sh.color};`;
      css += `opacity:${sh.opacity};transform:translate(${sh.x * z}px, ${sh.y * z}px);`;
      if (sh.blur > 0) css += `filter:blur(${(sh.blur / 2) * z}px);`;
      out.push({ css, arc: css, line: '', bg: '' });
    }
    for (const band of bands) {
      // Transparent fill, so what shows of this layer is its stroke alone - and
      // the layers stacked after it (the next stroke in, then the fill) cover
      // the half of it that falls inside the glyph.
      const css = `color:transparent;-webkit-text-stroke:${band.line * z}px ${rgba(band.color, band.opacity)};`;
      out.push({ css, arc: css, line: '', bg: '' });
    }
    out.push(fillLayer());
    return out;
  });

  // The topmost layer: the fill. A gradient or a pattern is painted as the
  // layer's background and clipped to the glyphs, which needs the text itself to
  // be transparent; scope 'line' moves that background onto each line instead,
  // so it restarts on every wrapped line.
  //
  // `arc` and `bg` are the curved path's halves of the same thing. Curved text
  // is a set of absolutely positioned spans, and a background clipped to text on
  // their container does not reach them - so the background goes on each span,
  // and the markup gives it the box's size and an offset for that glyph, which
  // is what makes one gradient run across the whole word instead of restarting
  // on every letter.
  const CLIP = '-webkit-background-clip:text;background-clip:text;';

  // One tile's data URL, remembered. Rebuilding it means drawing a canvas and
  // then base64ing it, and `fillLayer` is re-run for every style change and
  // every zoom tick - so a pinch gesture used to encode a fresh PNG per frame
  // per patterned box. Keyed on everything the tile is drawn from, with the zoom
  // quantised to an eighth: the tile is a raster CSS resamples anyway, so a
  // hair's difference in the resolution it was drawn at cannot be seen.
  let tileMemo = { key: '', url: '' };
  function patternTileUrl() {
    const qz = Math.max(0.125, Math.round(z * 8) / 8);
    const key = JSON.stringify([s.pattern, s.size, qz]);
    if (tileMemo.key === key) return tileMemo.url;
    const cnv = patternTileCanvas(s, TILE_SS * qz);
    const url = cnv ? cnv.toDataURL() : '';
    tileMemo = { key, url };
    return url;
  }

  function fillLayer() {
    if (s.pattern.on) {
      const tile = patternTileUrl();
      if (tile) {
        const px = patternTilePx(s) * z;
        const bg = `background-image:url(${tile});background-repeat:repeat;${CLIP}`;
        return {
          css: `color:transparent;${bg}background-size:${px}px ${px}px;`,
          arc: 'color:transparent;',
          line: '',
          bg,
          tile: px,
        };
      }
    }
    if (s.gradient.on) {
      const bg = `background-image:${gradientCss(s.gradient)};${CLIP}`;
      return {
        css: s.gradient.scope === 'line' ? 'color:transparent;' : `color:transparent;${bg}`,
        arc: 'color:transparent;',
        line: s.gradient.scope === 'line' ? bg : '',
        bg,
        tile: 0,
      };
    }
    return { css: `color:${s.color};`, arc: `color:${s.color};`, line: '', bg: '' };
  }

  // What the box looks like while it is being typed into: one editable element,
  // so the caret and the selection behave. A stack of copies has no caret, so the
  // editor shows the outermost stroke and the shadows as CSS can state them on a
  // single element and the full paint comes back the moment the edit ends.
  const editStyle = $derived.by(() => {
    let css = `${textStyle}color:${s.color};`;
    const bands = strokeBands(s.strokes);
    if (bands.length)
      css += `-webkit-text-stroke:${bands[0].line * z}px ${bands[0].color};paint-order:stroke fill;`;
    // `text-shadow`'s blur radius is TWICE the gaussian's sigma (CSS states it
    // that way, as does a canvas `shadowBlur`), while `filter: blur()` is the
    // sigma itself - so the style's `blur` goes in whole here and halved on the
    // display layer above, and both come out at the same softness. The two
    // spellings look like a mismatch and are not one.
    if (s.shadows.length)
      css += `text-shadow:${s.shadows
        .map((sh) => `${sh.x * z}px ${sh.y * z}px ${sh.blur * z}px ${rgba(sh.color, sh.opacity)}`)
        .join(',')};`;
    return css + filterCss;
  });

  // Glyph-by-glyph layout, when one applies: the bezier path when it is on and
  // has a curve to follow, else the closed circle, else the arc. All three
  // return the same shape, so the markup below draws any of them without
  // knowing which.
  const layout = $derived.by(() => {
    if (editing || text === '') return null;
    if (s.path?.on && (s.path.pts?.length ?? 0) >= 2)
      return pathLayout(applyCase(text, s), s, effSize, box.w, box.h);
    if (s.circle?.on) return circleLayout(applyCase(text, s), s, effSize);
    return s.curve && s.curve !== 0 ? arcLayout(applyCase(text, s), s, effSize) : null;
  });

  // The lines this box draws, and the ONLY thing that draws them: the editor
  // renders what `layoutLines` returns rather than handing the raw text to the
  // browser, so what is on the canvas is what the exporter puts in the file -
  // including the leading and trailing blank lines that function drops.
  const shaped = $derived.by(() => {
    if (editing || layout) return null;
    // Invalidate breaks when fonts load.
    app.fontsVersion;
    // Line breaking layout using box style dimensions and balloon fit.
    return layoutLines(
      applyCase(text, s),
      s,
      s.size,
      Math.max(1, box.w - BOX_PAD * 2),
      balloonWidthsFor(box, s, s.size),
    );
  });

  // Reactive auto-fit effect for text metrics.
  //
  // The box's height follows its line count, and this component has just worked
  // that line count out in order to draw with it. So the count is handed over
  // rather than derived a second time: `shaped` and `autoFitBox` used to call
  // `layoutLines` with byte-identical arguments, one after the other, on every
  // box on the page on every page turn - a full duplicate shaping pass, measured
  // at ~59ms of a turn's 100 with the typesetting beta on.
  //
  // `shaped` is read TRACKED, which is what makes this correct rather than
  // merely fast: it is derived from exactly the inputs listed below, so the
  // effect can no longer run against a line count from before the change that
  // woke it. It cannot loop either - `shaped` reads the text, the style and
  // `box.w`, and the only things written here are `box.y` and `box.h`.
  //
  // `shaped` is null in the two states that have no lines to count: a box being
  // typed into (one contenteditable element, the browser's own wrapping) and a
  // curved box (glyphs along an arc, never wrapped). Both fall back to
  // `autoFitBox`, which does its own breaking - and for the curved one refuses
  // outright, exactly as it always has.
  $effect(() => {
    text;
    box.w;
    s.font;
    s.size;
    s.lineHeight;
    s.letterSpacing;
    s.uppercase;
    s.bold;
    s.italic;
    s.valign;
    s.shape;
    s.minOrphan;
    s.hyphenate;
    s.autoHeight;
    // Both halves of the balloon fit: the shape itself, and the switch that says
    // whether to lay out to it. Either changing changes the line count, which is
    // the box's height.
    s.balloon;
    box.fit;
    app.fontsVersion;
    const lines = shaped;
    untrack(() => (lines ? autoFitBoxTo(box, lines.length, pg) : autoFitBox(box, pg)));
  });

  // Mirror flip transform for text.
  const mirror = $derived(
    s.flipH || s.flipV ? `scale(${s.flipH ? -1 : 1}, ${s.flipV ? -1 : 1})` : '',
  );

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Track active pointer gesture AbortControllers.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onBoxPointerDown(e) {
    if (editing) return;

    if (e.button !== 0) return;

    focusPage(pg);
    if (bulkOn) {
      e.stopPropagation();
      toggleBulkTarget(box.id);
      return;
    }
    if (e.target.classList.contains('handle')) return;
    e.stopPropagation();
    if (!selected) selectBox(box.id);
    startMove(e);
  }

  function onDblClick(e) {
    e.stopPropagation();
    focusPage(pg);
    beginEdit(box.id);
  }

  function startMove(e) {
    e.preventDefault();

    e.currentTarget.setPointerCapture?.(e.pointerId);

    settleEdits();
    const zz = app.zoom;
    const dims = pg;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;

    const pageId = dims.id;
    const before = { x: ox, y: oy };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      box.x = clamp(ox + (ev.clientX - sx) / zz, -box.w + 20, dims.w - 20);
      box.y = clamp(oy + (ev.clientY - sy) / zz, -box.h + 20, dims.h - 20);
      markUnsaved();
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();

      if (box.x !== before.x || box.y !== before.y) {
        record({ t: 'move', pageId, boxId: box.id, before, after: { x: box.x, y: box.y } });
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  function startTransform(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    if (!selected) selectBox(box.id);
    settleEdits();
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;

    const o = { x: box.x, y: box.y, w: box.w, h: box.h, size: s.size };
    const autoHeightBefore = s.autoHeight;
    const isRot = dir === 'rot';

    const dims = pg;
    const pageId = dims.id;
    // Rotation gesture records style edit.
    const styleBefore = isRot ? cloneStyle(box.style) : null;

    const fitBefore = isRot ? { y: box.y, h: box.h } : null;
    const cx = () => box.x + box.w / 2;
    const cy = () => box.y + box.h / 2;

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (isRot) {
        if (!pageFrameEl) return;
        const r = pageFrameEl.getBoundingClientRect();
        const mx = (ev.clientX - r.left) / zz, my = (ev.clientY - r.top) / zz;
        let ang = (Math.atan2(my - cy(), mx - cx()) * 180) / Math.PI + 90;
        if (ang > 180) ang -= 360;
        else if (ang < -180) ang += 360;
        if (ev.shiftKey) {
          ang = Math.round(ang / 15) * 15;
          if (ang > 180) ang -= 360;
          else if (ang < -180) ang += 360;
        }
        box.style.rotation = clamp(Math.round(ang), -180, 180);
      } else {
        // Transform pointer delta into box coordinate space.
        const rad = (-(s.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const sdx = (ev.clientX - sx) / zz, sdy = (ev.clientY - sy) / zz;
        const dx = sdx * cos - sdy * sin, dy = sdx * sin + sdy * cos;
        const hasE = dir.includes('e'), hasW = dir.includes('w'), hasN = dir.includes('n'), hasS = dir.includes('s');
        const corner = (hasE || hasW) && (hasN || hasS);
        if ((hasN || hasS) && !corner) {
          box.style.autoHeight = false;
        }
        let nw = o.w, nh = o.h;
        if (hasE) nw = Math.max(40, o.w + dx);
        if (hasW) nw = Math.max(40, o.w - dx);
        if (hasS) nh = Math.max(30, o.h + dy);
        if (hasN) nh = Math.max(30, o.h - dy);
        // Opposite edge anchor for rotated box scaling.
        const shiftX = hasE ? (nw - o.w) / 2 : hasW ? (o.w - nw) / 2 : 0;
        const shiftY = hasS ? (nh - o.h) / 2 : hasN ? (o.h - nh) / 2 : 0;
        const nx = o.x + o.w / 2 + (shiftX * cos + shiftY * sin) - nw / 2;
        const ny = o.y + o.h / 2 + (shiftY * cos - shiftX * sin) - nh / 2;
        box.w = nw; box.h = nh; box.x = nx; box.y = ny;

        if (corner && o.h > 0) box.style.size = clamp(Math.round(o.size * (nh / o.h)), 6, 200);
      }
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      // Both gestures on this handle CHANGE THE STYLE - the rotation handle
      // writes `rotation`, a corner writes `size` - and the next box placed is
      // meant to follow the box the user just shaped. Nothing else on this path
      // touches `lastStyle` (the Inspector's `touch` covers only edits made in
      // the panel), so without this a rotate-then-place produced the style of
      // some earlier box. At the END of the gesture, not during: the style is
      // settled here, and remembering per pointermove would clone it per frame.
      rememberStyle(box);
      if (isRot) {
        const after = cloneStyle(box.style);
        if (after.rotation !== styleBefore.rotation) {
          markUnsaved();
          record({
            t: 'style',
            pageId,
            boxId: box.id,
            before: styleBefore,
            after,
            geomBefore: fitBefore,
            geomAfter: { y: box.y, h: box.h },
          });
        }
        return;
      }
      const before = { ...o };
      const after = { x: box.x, y: box.y, w: box.w, h: box.h, size: box.style.size };
      if (box.style.autoHeight !== autoHeightBefore) {
        before.autoHeight = autoHeightBefore;
        after.autoHeight = box.style.autoHeight;
      }
      if (Object.keys(after).some((k) => after[k] !== before[k])) {
        markUnsaved();
        record({ t: 'resize', pageId, boxId: box.id, before, after });
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Drag one bezier-path anchor or handle. `which` is 'a' (the anchor itself),
  // 'in' or 'out'. Dragging a handle mirrors its partner, exactly as
  // TypeBubble does, so one drag keeps the curve smooth through the anchor.
  // The pointer delta is inverse-rotated into box space like a resize is, and
  // the gesture records one style edit at the end like the rotation handle.
  function startPathDrag(e, i, which) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    settleEdits();
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX,
      sy = e.clientY;
    const pt = s.path.pts[i];
    if (!pt) return;
    const o = { x: pt.x, y: pt.y, ix: pt.ix, iy: pt.iy, ox: pt.ox, oy: pt.oy };
    const styleBefore = cloneStyle(box.style);
    const pageId = pg.id;
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad),
      sin = Math.sin(rad);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const sdx = (ev.clientX - sx) / zz,
        sdy = (ev.clientY - sy) / zz;
      const dx = sdx * cos - sdy * sin,
        dy = sdx * sin + sdy * cos;
      if (which === 'a') {
        pt.x = o.x + dx;
        pt.y = o.y + dy;
      } else if (which === 'in') {
        pt.ix = o.ix + dx;
        pt.iy = o.iy + dy;
        pt.ox = -pt.ix;
        pt.oy = -pt.iy;
      } else {
        pt.ox = o.ox + dx;
        pt.oy = o.oy + dy;
        pt.ix = -pt.ox;
        pt.iy = -pt.oy;
      }
      markUnsaved();
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const after = cloneStyle(box.style);
      if (JSON.stringify(after.path) !== JSON.stringify(styleBefore.path)) {
        record({ t: 'style', pageId, boxId: box.id, before: styleBefore, after });
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // ---- mask drawing ----
  //
  // The armed tool comes from the Inspector (mask-tool.svelte.js). While one
  // is armed and this box is selected, a transparent overlay takes the
  // pointer and turns gestures into mask shapes, committed one per gesture
  // with one undo record each, like the path gizmo's drags.
  const maskArmed = $derived(selected && !editing && !bulkOn && s.clip?.on && maskTool.id);

  // The gesture in progress: a shape being drawn, not yet in the style.
  const maskDraft = $state({ shape: null, poly: null });

  // A pointer event in box-local page px: page coords from the page frame,
  // then inverse-rotated around the box centre - the same frame the shapes
  // are stored in and the mask is painted in (the mirror flip lives inside,
  // on the text, so it does not enter into it).
  function maskPoint(ev) {
    const r = pageFrameEl.getBoundingClientRect();
    const px = (ev.clientX - r.left) / app.zoom - box.x;
    const py = (ev.clientY - r.top) / app.zoom - box.y;
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    if (!rad) return [px, py];
    const cx = box.w / 2;
    const cy = box.h / 2;
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
  }

  function commitMaskShape(shape) {
    const styleBefore = cloneStyle(box.style);
    s.clip.shapes = [...s.clip.shapes, shape];
    markUnsaved();
    record({ t: 'style', pageId: pg.id, boxId: box.id, before: styleBefore, after: cloneStyle(box.style) });
  }

  function onMaskPointerDown(e) {
    if (e.button !== 0 || !maskArmed || !pageFrameEl) return;
    e.preventDefault();
    e.stopPropagation();
    const p = maskPoint(e);
    // The polygon is click-built rather than dragged; the other two are drags.
    if (maskTool.id === 'poly') {
      maskDraft.poly = [...(maskDraft.poly ?? []), p];
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const start = p;
    if (maskTool.id === 'brush') maskDraft.shape = { kind: 'stroke', size: s.clip.brushSize, pts: [p] };
    else maskDraft.shape = { kind: 'ellipse', cx: p[0], cy: p[1], rx: 0, ry: 0 };
    const move = (ev) => {
      if (ev.pointerId !== pid || !maskDraft.shape) return;
      const q = maskPoint(ev);
      if (maskDraft.shape.kind === 'stroke') {
        const last = maskDraft.shape.pts[maskDraft.shape.pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 1.5) maskDraft.shape.pts.push(q);
      } else {
        maskDraft.shape.cx = (start[0] + q[0]) / 2;
        maskDraft.shape.cy = (start[1] + q[1]) / 2;
        maskDraft.shape.rx = Math.abs(q[0] - start[0]) / 2;
        maskDraft.shape.ry = Math.abs(q[1] - start[1]) / 2;
      }
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const sh = maskDraft.shape;
      maskDraft.shape = null;
      if (!sh) return;
      // An ellipse too small to see was a slip, not a shape.
      if (sh.kind === 'ellipse' && (sh.rx < 1 || sh.ry < 1)) return;
      commitMaskShape(sh);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Double-click closes the polygon; Escape drops it.
  function onMaskDblClick(e) {
    if (maskTool.id !== 'poly' || !maskDraft.poly) return;
    e.preventDefault();
    e.stopPropagation();
    const pts = maskDraft.poly;
    maskDraft.poly = null;
    if (pts.length >= 3) commitMaskShape({ kind: 'poly', pts });
  }
  $effect(() => {
    if (!maskArmed) {
      maskDraft.poly = null;
      maskDraft.shape = null;
      return;
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && maskDraft.poly) {
        e.preventDefault();
        maskDraft.poly = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Everything the mask overlay draws: committed shapes plus the draft.
  const maskShapesShown = $derived.by(() => {
    if (!(selected && !editing && !bulkOn && s.clip?.on)) return null;
    const out = [...s.clip.shapes];
    if (maskDraft.shape) out.push(maskDraft.shape);
    return out;
  });

  // Right-click on a path anchor removes it (the path keeps at least two).
  function onAnchorContextMenu(e, i) {
    e.preventDefault();
    e.stopPropagation();
    const next = removePathAnchor(s.path.pts, i);
    if (next === s.path.pts) return;
    const styleBefore = cloneStyle(box.style);
    s.path.pts = next;
    markUnsaved();
    record({ t: 'style', pageId: pg.id, boxId: box.id, before: styleBefore, after: cloneStyle(box.style) });
  }

  // The gizmo's polyline, in zoomed box-local px.
  const gizmoLine = $derived.by(() => {
    if (!(selected && !editing && !bulkOn && s.path?.on && (s.path.pts?.length ?? 0) >= 2)) return null;
    return pathPolyline(s.path.pts, z)
      .map((p) => `${p[0]},${p[1]}`)
      .join(' ');
  });

  // Inline contenteditable undo stack.
  const fieldUndo = createFieldUndo();

  function focusSelect(node) {

    node.textContent = boxText(box, pg);
    resyncField(fieldUndo, node.textContent);
    const sel = () => {
      node.focus();
      const r = document.createRange();
      r.selectNodeContents(node);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    sel();
    return {};
  }

  // setBoxText routes text to line for free-typed boxes.
  function onEditInput(e) {
    const v = e.currentTarget.innerText;
    setBoxText(box, v);
    recordFieldEdit(fieldUndo, v, { atomic: isAtomicInput(e.inputType) });
    markUnsaved();
  }
  function onEditBlur(e) {
    endEdit(e.currentTarget.innerText);
  }
  function onEditKey(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {

      e.preventDefault();
      const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
      if (next != null) restoreEdit(e.currentTarget, next);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  // Restore plain text content and caret position.
  function restoreEdit(node, value) {
    const caret = caretAfter(node.innerText, value);
    node.textContent = value;
    const t = node.firstChild;
    const r = document.createRange();
    if (t) r.setStart(t, Math.min(caret, t.textContent.length));
    else r.setStart(node, 0);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    setBoxText(box, value);
    markUnsaved();
  }

  const corners = [['corner', 'nw'], ['corner', 'ne'], ['corner', 'sw'], ['corner', 'se']];
  const sides = [['side', 'n'], ['side', 's'], ['side', 'w'], ['side', 'e']];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tbox"
  class:selected
  class:editing
  class:bulk-on={bulkOn}
  class:bulk-target={bulkTarget}
  data-id={box.id}
  style={boxStyle}
  onpointerdown={onBoxPointerDown}
  ondblclick={onDblClick}
>
  {#if s.roughen.on}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The filter runs in CSS px, which are ZOOMED px, so both of its numbers
           have to be turned back into the page's own units or the roughening is
           a different roughening at every zoom - and only ever matched the
           export at 100%. `amount` is a displacement, so it grows with the zoom;
           `detail` is a frequency, so it shrinks. The exporter states the same
           two numbers in page px against the same noise (see `roughen` and
           text-paint.js), which is what makes the export the picture on the
           canvas rather than one like it. -->
      <!-- The region has to hold the displacement as well as the text, and it is
           a share of the element's own size: a small box with a large `amount`
           had its crumple cut off square at the old -30%/160%, which the export
           (padded in absolute px) then did not do. Half the block again on every
           edge covers any amount the panel offers on any box worth reading. -->
      <filter id={roughId} x="-50%" y="-50%" width="200%" height="200%">
        <feTurbulence type="fractalNoise" baseFrequency={s.roughen.detail / z} numOctaves={OCTAVES} seed={s.roughen.seed} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={s.roughen.amount * z} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  {/if}

  {#if mbTaps.length}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The directional smear, as the exporter's tap list stated in SVG:
           every tap is shifted off the source and added into a running sum
           (feComposite/arithmetic, k2 = the tap's weight, k3 = 1), which is
           exactly the exporter's 'lighter' accumulation. sRGB interpolation,
           because canvas compositing is sRGB and the two smears must be one
           smear. Offsets are page px scaled by the zoom, like the blur
           radius. The first tap is the centre one (dx = dy = 0), so it seeds
           the sum straight off SourceGraphic. -->
      <filter id={mbId} x={mbRegion.x} y={mbRegion.y} width={mbRegion.w} height={mbRegion.h} color-interpolation-filters="sRGB">
        {#each mbTaps as t, i (i)}
          {#if i === 0}
            <feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k1="0" k2={t.w} k3="0" k4="0" result="p0" />
          {:else}
            <feOffset in="SourceGraphic" dx={t.dx * z} dy={t.dy * z} result={`t${i}`} />
            <feComposite in={`t${i}`} in2={`p${i - 1}`} operator="arithmetic" k1="0" k2={t.w} k3="1" k4="0" result={`p${i}`} />
          {/if}
        {/each}
      </filter>
    </svg>
  {/if}

  {#if selected && jp}
    <div class="jp-pill" class:sfx={isSfx} contenteditable="false">{jp}</div>
  {/if}

  <!-- The wrapper exists for the mask: `mask-image` needs an element whose
       (0,0) is the box's own top-left, and the text stack is a centred flex
       child with no fixed origin. It replicates the box's flex layout and
       padding, so with the mask off it changes nothing. The selection
       handles and the jp pill stay outside it, unmasked. -->
  <div
    class="clipwrap"
    style="justify-content:{justify};align-items:{alignItems};padding:{2 * z}px;{maskCss}"
  >
  {#if editing}
    <div
      class="txt editable"
      contenteditable="true"
      style={editStyle}
      use:focusSelect
      oninput={onEditInput}
      onblur={onEditBlur}
      onkeydown={onEditKey}
    ></div>
  {:else if layout}
    <!-- Curved text is placed glyph by glyph, so each layer of the stack is a
         full set of glyph spans; they are all absolutely positioned already, so
         no layer has to hold the others up. -->
    <div class="arcstack" style="{mirror ? `transform:${mirror};` : ''}{filterCss}">
      {#each layers as ly, li (li)}
        <div class="arc" style={ly.arc}>
          {#each layout as g, i (i)}
            <span
              class="arc-ch"
              style="{textStyle}{ly.bg
                ? `${ly.bg}background-size:${ly.tile ? `${ly.tile}px ${ly.tile}px` : `${box.w * z}px ${box.h * z}px`};background-position:${-((box.w * z) / 2 + g.x - g.w / 2)}px ${-((box.h * z) / 2 + g.y - effSize / 2)}px;`
                : ''}transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad)"
            >{g.ch}</span>
          {/each}
        </div>
      {/each}
    </div>
  {:else}
    <div class="txt shaped stack" style="{textStyle}{mirror ? `transform:${mirror};` : ''}{filterCss}">
      {#each layers as ly, li (li)}
        <div class="tlayer" class:base={li === 0} style={ly.css}>
          {#each shaped as ln, i (i)}<div class="tline" style={ly.line}>{ln === '' ? '\u200b' : ln}</div>{/each}
        </div>
      {/each}
    </div>
  {/if}
    {#if inkActive(s.ink)}
      <!-- Inside the clip wrapper so the visibility mask hides ink the same way
           it hides letters; positioned off the box's own top-left, offset by the
           overhang the canvas was grown by. -->
      <canvas
        class="inkl"
        bind:this={inkEl}
        style="left:{-inkPad * z}px;top:{-inkPad * z}px;width:{(box.w + inkPad * 2) * z}px;height:{(box.h + inkPad * 2) * z}px"
        aria-hidden="true"
      ></canvas>
    {/if}
  </div>

  {#if gizmoLine}
    <!-- The path gizmo: the baked curve, an anchor dot per point and its two
         handle dots, all draggable. Outside the clip wrapper on purpose - the
         curve must stay visible where the clip has cropped the letters. -->
    <svg class="path-gizmo" width={box.w * z} height={box.h * z} aria-hidden="true">
      <polyline points={gizmoLine} />
      {#each s.path.pts as p, i (i)}
        <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ix) * z} y2={(p.y + p.iy) * z} />
        <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ox) * z} y2={(p.y + p.oy) * z} />
        <rect class="ph" x={(p.x + p.ix) * z - 4} y={(p.y + p.iy) * z - 4} width="8" height="8" onpointerdown={(e) => startPathDrag(e, i, 'in')} />
        <rect class="ph" x={(p.x + p.ox) * z - 4} y={(p.y + p.oy) * z - 4} width="8" height="8" onpointerdown={(e) => startPathDrag(e, i, 'out')} />
        <circle class="pa" cx={p.x * z} cy={p.y * z} r="5" onpointerdown={(e) => startPathDrag(e, i, 'a')} oncontextmenu={(e) => onAnchorContextMenu(e, i)} />
      {/each}
    </svg>
  {/if}

  {#if maskShapesShown}
    <!-- The mask overlay: committed shapes (and the drag in progress) drawn
         as outlines so the user can see what they have painted, plus - while
         a tool is armed - a full-coverage capture surface that turns the
         pointer into shapes. Outside the clip wrapper on purpose: the
         outlines must stay visible where the mask has hidden the letters. -->
    <svg class="mask-gizmo" class:excl={s.clip.mode === 'exclude'} width={box.w * z} height={box.h * z} aria-hidden="true">
      {#if maskArmed}
        <rect
          class="capture"
          x={-MASK_EXPAND * z}
          y={-MASK_EXPAND * z}
          width={(box.w + MASK_EXPAND * 2) * z}
          height={(box.h + MASK_EXPAND * 2) * z}
          onpointerdown={onMaskPointerDown}
          ondblclick={onMaskDblClick}
        />
      {/if}
      {#each maskShapesShown as sh, i (i)}
        {#if sh.kind === 'ellipse'}
          <ellipse cx={sh.cx * z} cy={sh.cy * z} rx={sh.rx * z} ry={sh.ry * z} />
        {:else if sh.kind === 'poly'}
          <polygon points={sh.pts.map(([px, py]) => `${px * z},${py * z}`).join(' ')} />
        {:else}
          <polyline
            class="stroke"
            points={sh.pts.map(([px, py]) => `${px * z},${py * z}`).join(' ')}
            style="stroke-width:{sh.size * z}px"
          />
        {/if}
      {/each}
      {#if maskDraft.poly}
        <polyline class="draft" points={maskDraft.poly.map(([px, py]) => `${px * z},${py * z}`).join(' ')} />
        {#each maskDraft.poly as [px, py], i (i)}
          <circle class="vert" cx={px * z} cy={py * z} r="3.5" />
        {/each}
      {/if}
    </svg>
  {/if}

  {#if selected && !editing && !bulkOn}
    <div class="rotate-stem"></div>
    {#each corners as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    {#each sides as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    <div class="handle rot" onpointerdown={(e) => startTransform(e, 'rot')}></div>
  {/if}
</div>

<style>
  /* The layer stack. Every layer holds the same lines and lays out identically;
     the first one is in flow and gives the block its height, the rest sit over
     it. A layer's own transform (a shadow's offset) moves what is painted and
     not what is measured, so the stack cannot come apart. */
  .stack { position: relative; }
  .tlayer { position: absolute; left: 0; top: 0; width: 100%; }
  .tlayer.base { position: relative; }
  /* Curved layers are already absolute (.arc is inset:0), so this only has to
     give them something to be absolute inside. */
  .arcstack { position: absolute; inset: 0; }
  /* The clip wrapper mirrors the box's own flex layout (justify/align/padding
     are inlined per box) so the text lands exactly where it did as a direct
     child. Its border box IS the box rect, which is the frame the clip-path
     is stated in. */
  .clipwrap { position: absolute; inset: 0; display: flex; box-sizing: border-box; }
  /* The ink layer. Absolute so it does not disturb the text's flex centring,
     and never a pointer target: drawing is captured by the box, not by this. */
  .inkl {
    position: absolute;
    pointer-events: none;
  }
  /* The path gizmo. The svg itself lets clicks through to the box; only the
     anchors and handles take the pointer. Colours are TypeBubble's, which read
     well on both white pages and dark art. */
  .path-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .path-gizmo polyline { fill: none; stroke: #00d5e0; stroke-width: 1.5; }
  .path-gizmo line { stroke: #663399; stroke-width: 1; }
  .path-gizmo .pa, .path-gizmo .ph { pointer-events: all; cursor: grab; }
  .path-gizmo .pa { fill: #e33; stroke: #fff; stroke-width: 1; }
  .path-gizmo .ph { fill: #fff; stroke: #663399; stroke-width: 1; }
  /* The mask overlay. Shape outlines are hints, not paint: red for exclusion
     (this ink goes away), teal for inclusion (this ink stays). The capture
     rect is the drawing surface while a tool is armed; it reaches past the
     box exactly as far as the mask image does. */
  .mask-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .mask-gizmo .capture { fill: transparent; pointer-events: all; cursor: crosshair; }
  .mask-gizmo ellipse, .mask-gizmo polygon { fill: rgba(0, 180, 190, 0.14); stroke: #00b4be; stroke-width: 1; }
  .mask-gizmo .stroke { fill: none; stroke: rgba(0, 180, 190, 0.3); stroke-linecap: round; stroke-linejoin: round; }
  .mask-gizmo.excl ellipse, .mask-gizmo.excl polygon { fill: rgba(230, 60, 60, 0.14); stroke: #e33; }
  .mask-gizmo.excl .stroke { stroke: rgba(230, 60, 60, 0.3); }
  .mask-gizmo .draft { fill: none; stroke: #f90; stroke-width: 1.5; stroke-dasharray: 4 3; }
  .mask-gizmo .vert { fill: #f90; stroke: #fff; stroke-width: 1; }
</style>
