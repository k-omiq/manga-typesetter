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
  import { arcLayout, applyCase, layoutLines, BOX_PAD, balloonWidthsFor } from './measure.js';
  import {
    strokeBands,
    rgba,
    gradientCss,
    patternTilePx,
    patternTileCanvas,
    OCTAVES,
    TILE_SS,
  } from './text-paint.js';

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
  // and roughening's SVG displacement. Both in one `filter` list, in that order,
  // because a roughened edge should be blurred rather than the other way round.
  const filterCss = $derived.by(() => {
    const f = [];
    if (s.blur > 0) f.push(`blur(${s.blur * z}px)`);
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
    const alpha = `opacity:${s.fillOpacity};`;
    if (s.pattern.on) {
      const tile = patternTileUrl();
      if (tile) {
        const px = patternTilePx(s) * z;
        const bg = `background-image:url(${tile});background-repeat:repeat;${CLIP}`;
        return {
          css: `color:transparent;${alpha}${bg}background-size:${px}px ${px}px;`,
          arc: `color:transparent;${alpha}`,
          line: '',
          bg,
          tile: px,
        };
      }
    }
    if (s.gradient.on) {
      const bg = `background-image:${gradientCss(s.gradient)};${CLIP}`;
      return {
        css: s.gradient.scope === 'line' ? `color:transparent;${alpha}` : `color:transparent;${alpha}${bg}`,
        arc: `color:transparent;${alpha}`,
        line: s.gradient.scope === 'line' ? bg : '',
        bg,
        tile: 0,
      };
    }
    return { css: `color:${s.color};${alpha}`, arc: `color:${s.color};${alpha}`, line: '', bg: '' };
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

  const layout = $derived.by(() =>
    s.curve && s.curve !== 0 && !editing && text !== '' ? arcLayout(applyCase(text, s), s, effSize) : null,
  );

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

  {#if selected && jp}
    <div class="jp-pill" class:sfx={isSfx} contenteditable="false">{jp}</div>
  {/if}

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
</style>
