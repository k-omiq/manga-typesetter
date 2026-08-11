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
  } from './store.svelte.js';
  import { arcLayout } from './measure.js';

  let { box, pageFrameEl } = $props();

  const z = $derived(app.zoom);
  const selected = $derived(app.selectedId === box.id);
  const editing = $derived(app.editingId === box.id);
  const bulkOn = $derived(app.bulk.active);
  const bulkTarget = $derived(isBulkTarget(box.id));
  const s = $derived(box.style);
  const text = $derived(boxText(box));
  // Japanese reference for the box's source line (overlay only — never the text content).
  const line = $derived(box.lineN != null ? lineByN(page(), box.lineN) : null);
  const jp = $derived(line?.jp ?? '');
  const isSfx = $derived(line?.type === 'sfx');

  const effSize = $derived(s.size * z);
  const effLs = $derived(s.letterSpacing * z);
  const effStroke = $derived(s.outlineWidth * z);

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
      `padding:${2 * z}px;` + // scale padding with zoom so wrapping is zoom-stable (matches export)
      `transform:rotate(${s.rotation}deg);justify-content:${justify};align-items:${alignItems};` +
      `opacity:${s.opacity}`,
  );

  // shared text CSS (color, font, stroke, shadow, transform-case, roughen filter)
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
    s.curve && s.curve !== 0 && !editing && text !== '' ? arcLayout(text, s, effSize) : null,
  );

  // Mirror flip applied to the rendered glyphs (not the box chrome / handles).
  // Rotation lives on .tbox (outer) and the flip on the text (inner), so the
  // composition matches the exporter's rotate-then-flip order.
  const mirror = $derived(
    s.flipH || s.flipV ? `scale(${s.flipH ? -1 : 1}, ${s.flipV ? -1 : 1})` : '',
  );

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function onBoxPointerDown(e) {
    if (editing) return; // let caret work
    // in bulk mode, clicking a box toggles it as an apply-target
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
    beginEdit(box.id);
  }

  function startMove(e) {
    e.preventDefault();
    const zz = app.zoom;
    const dims = page();
    const sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;
    const move = (ev) => {
      box.x = clamp(ox + (ev.clientX - sx) / zz, -box.w + 20, dims.w - 20);
      box.y = clamp(oy + (ev.clientY - sy) / zz, -box.h + 20, dims.h - 20);
      markUnsaved();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function startTransform(e, dir) {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) selectBox(box.id);
    const zz = app.zoom;
    const sx = e.clientX, sy = e.clientY;
    const o = { x: box.x, y: box.y, w: box.w, h: box.h, size: s.size };
    const isRot = dir === 'rot';
    const cx = () => box.x + box.w / 2;
    const cy = () => box.y + box.h / 2;

    const move = (ev) => {
      if (isRot) {
        const r = pageFrameEl.getBoundingClientRect();
        const mx = (ev.clientX - r.left) / zz, my = (ev.clientY - r.top) / zz;
        let ang = (Math.atan2(my - cy(), mx - cx()) * 180) / Math.PI + 90;
        if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
        box.style.rotation = clamp(Math.round(ang), -180, 180);
      } else {
        const dx = (ev.clientX - sx) / zz, dy = (ev.clientY - sy) / zz;
        const hasE = dir.includes('e'), hasW = dir.includes('w'), hasN = dir.includes('n'), hasS = dir.includes('s');
        const corner = (hasE || hasW) && (hasN || hasS);
        let nw = o.w, nh = o.h, nx = o.x, ny = o.y;
        if (hasE) nw = Math.max(40, o.w + dx);
        if (hasW) { nw = Math.max(40, o.w - dx); nx = o.x + (o.w - nw); }
        if (hasS) nh = Math.max(30, o.h + dy);
        if (hasN) { nh = Math.max(30, o.h - dy); ny = o.y + (o.h - nh); }
        box.w = nw; box.h = nh; box.x = nx; box.y = ny;
        if (corner) box.style.size = clamp(Math.round(o.size * (nh / o.h)), 6, 200);
      }
      markUnsaved();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function focusSelect(node) {
    // Seed the editable content ONCE on mount so the node stays uncontrolled
    // while typing (its content is NOT derived from reactive state, so input
    // never re-renders the text node and the caret never resets to 0).
    node.textContent = boxText(box);
    const sel = () => {
      node.focus();
      const r = document.createRange();
      r.selectNodeContents(node);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    sel(); // synchronous (works even when rAF is throttled)
    return {};
  }

  function onEditInput(e) {
    box.text = e.currentTarget.innerText;
    markUnsaved();
  }
  function onEditBlur(e) {
    endEdit(e.currentTarget.innerText);
  }
  function onEditKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    }
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
