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
    settleEdits,
    setBoxText,
    autoFitBox,
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
  // Double outline width for preview to match exporter visible outline.
  const effStroke = $derived(s.outlineWidth * 2 * z);

  const justify = $derived(
    s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center',
  );
  const alignItems = $derived(
    s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
  );

  const roughId = `rough-${box.id}`;

  function rgba(hex, a) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  const boxStyle = $derived(
    `left:${box.x * z}px;top:${box.y * z}px;width:${box.w * z}px;height:${box.h * z}px;` +
      `padding:${2 * z}px;` +
      `transform:rotate(${s.rotation}deg);justify-content:${justify};align-items:${alignItems};` +
      `opacity:${s.opacity}`,
  );


  const textStyle = $derived.by(() => {
    let css =
      `font-family:${fontCssFor(s.font)};font-weight:${s.bold ? 700 : 400};` +
      `font-style:${s.italic ? 'italic' : 'normal'};text-align:${s.align};color:${s.color};` +
      `line-height:${s.lineHeight};font-size:${effSize}px;letter-spacing:${effLs}px;` +
      `text-transform:${s.uppercase ? 'uppercase' : 'none'};`;
    if (effStroke > 0) css += `-webkit-text-stroke:${effStroke}px ${s.outline};paint-order:stroke fill;`;
    if (s.shadow.on)
      css += `text-shadow:${s.shadow.x * z}px ${s.shadow.y * z}px ${s.shadow.blur * z}px ${rgba(s.shadow.color, s.shadow.opacity)};`;
    if (s.roughen.on) css += `filter:url(#${roughId});`;
    return css;
  });

  const layout = $derived.by(() =>
    s.curve && s.curve !== 0 && !editing && text !== '' ? arcLayout(applyCase(text, s), s, effSize) : null,
  );

  // Line breaking layout using box style dimensions.
  const shaped = $derived.by(() => {
    if (editing || layout) return null;
    if ((s.shape ?? 'auto') === 'off') return null;
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
    untrack(() => autoFitBox(box, pg));
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

        autoFitBox(box, dims);
        // Preserve top handle position during auto-fit.
        if (hasN && box.y !== ny)
          box.y = dims.h > 0 ? clamp(ny, 0, Math.max(0, dims.h - box.h)) : ny;
      }
      markUnsaved();
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      if (isRot) {
        const after = cloneStyle(box.style);
        if (after.rotation !== styleBefore.rotation) {
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
      const after = { x: box.x, y: box.y, w: box.w, h: box.h, size: box.style.size };
      if (Object.keys(after).some((k) => after[k] !== o[k])) {
        record({ t: 'resize', pageId, boxId: box.id, before: o, after });
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
      <filter id={roughId} x="-30%" y="-30%" width="160%" height="160%">
        <feTurbulence type="fractalNoise" baseFrequency={s.roughen.detail} numOctaves="2" seed={s.roughen.seed} result="n" />
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
      style={textStyle}
      use:focusSelect
      oninput={onEditInput}
      onblur={onEditBlur}
      onkeydown={onEditKey}
    ></div>
  {:else if layout}
    <div class="arc" style={mirror ? `transform:${mirror}` : ''}>
      {#each layout as g, i (i)}
        <span
          class="arc-ch"
          style="{textStyle};transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad)"
        >{g.ch}</span>
      {/each}
    </div>
  {:else if shaped}

    <div class="txt shaped" style="{textStyle}{mirror ? `transform:${mirror};` : ''}">

      {#each shaped as ln, i (i)}<div class="tline">{ln === '' ? '\u200b' : ln}</div>{/each}
    </div>
  {:else}
    <div class="txt" style="{textStyle}{mirror ? `transform:${mirror};` : ''}">{text}</div>
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
