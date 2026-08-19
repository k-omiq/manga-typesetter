<script>
  import {
    app,
    applyBulk,
    applyBulkToTag,
    closeBulk,
    page,
    setBulkProp,
    tickBulkProp,
    bulkTicked,
  } from './store.svelte.js';
  import { tagsInUse, boxesWithTag } from './tags.svelte.js';
  import { modKey } from './format.js';

  // app.bulk.style is the editable template; null when closed.
  const s = $derived(app.bulk.style);
  const count = $derived(app.bulk.targets.length);
  // Count of properties enabled in the mask.
  const ticked = $derived(app.bulk.active ? bulkTicked().length : 0);

  // Draggable panel position relative to .ed-canvas.
  let pos = $state({ x: 0, y: 16 });
  let panelEl;

  // Panel size clamped to content and viewport bounds.
  const MIN_W = 280;
  const MAX_W = 560;
  const MIN_H = 220;
  let size = $state({ w: 320, h: null });

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Max dimensions relative to canvas bounds.
  const panelStyle = $derived(
    `left:${pos.x}px; top:${pos.y}px; width:${size.w}px;` +
      (size.h ? `height:${size.h}px;` : '') +
      `max-width:calc(100% - ${pos.x}px - 16px);` +
      `max-height:calc(100% - ${pos.y}px - 16px)`,
  );

  // Parent content box for drag/resize clamping.
  function parentBox() {
    const parent = panelEl?.offsetParent || panelEl?.parentElement;
    return {
      w: parent ? parent.clientWidth : window.innerWidth,
      h: parent ? parent.clientHeight : window.innerHeight,
    };
  }

  // Re-center near top of editor on open.
  $effect(() => {
    if (app.bulk.active && panelEl) {
      const { w: pw } = parentBox();
      pos = { x: Math.max(16, (pw - size.w) / 2), y: 16 };
    }
  });

  // Track active gesture AbortControllers.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onHeadPointerDown(e) {
    // Do not drag from close button.
    if (e.target.closest('.x')) return;
    // Primary pointer button only.
    if (e.button !== 0) return;
    e.preventDefault();
    // Pointer capture tracks drag outside window.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = pos.x;
    const baseY = pos.y;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const { w: pw, h: ph } = parentBox();
      const w = panelEl?.offsetWidth || 0;
      let nx = baseX + (ev.clientX - startX);
      let ny = baseY + (ev.clientY - startY);
      // Keep at least 40px on screen.
      nx = clamp(nx, 40 - w, pw - 40);
      ny = clamp(ny, 0, Math.max(0, ph - 40));
      pos = { x: nx, y: ny };
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
    };
    live.add(ac);
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Corner resize grip handler.
  function onGripPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseW = size.w;
    const baseH = size.h ?? panelEl?.offsetHeight ?? MIN_H;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const { w: pw, h: ph } = parentBox();
      size = {
        w: clamp(baseW + (ev.clientX - startX), MIN_W, Math.min(MAX_W, Math.max(MIN_W, pw - pos.x - 16))),
        h: clamp(baseH + (ev.clientY - startY), MIN_H, Math.max(MIN_H, ph - pos.y - 16)),
      };
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
    };
    live.add(ac);
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Read/write masked properties by path.
  const get = (key) => {
    const dot = key.indexOf('.');
    return dot === -1 ? s[key] : s[key.slice(0, dot)][key.slice(dot + 1)];
  };
  // Modifying a property enables it in the mask.
  function set(key, v) {
    const dot = key.indexOf('.');
    if (dot === -1) s[key] = v;
    else s[key.slice(0, dot)][key.slice(dot + 1)] = v;
    tickBulkProp(key);
  }
  // Validate CSS hex color strings.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // Restore previous value on invalid hex input.
  function setHex(key, v, el) {
    if (HEX.test(v)) set(key, v.startsWith('#') ? v : '#' + v);
    else if (el) el.value = get(key);
  }
  const num = (key, v, lo, hi) => set(key, clamp(+v || 0, lo, hi));

  // Inspector group mapping for bulk mask properties.
  const GROUPS = {
    font: ['font', 'size', 'bold', 'italic', 'uppercase', 'align', 'valign', 'lineHeight', 'letterSpacing'],
    fill: ['color', 'opacity', 'outline', 'outlineWidth'],
    shadow: ['shadow.on', 'shadow.x', 'shadow.y', 'shadow.blur', 'shadow.opacity', 'shadow.color'],
    warp: ['curve', 'roughen.on', 'roughen.amount', 'roughen.detail', 'roughen.seed'],
    typeset: ['shape', 'minOrphan', 'hyphenate', 'balloon', 'autoHeight'],
    transform: ['rotation', 'flipH', 'flipV'],
  };
  let open = $state({ font: true, fill: true, shadow: false, warp: false, typeset: false, transform: true });
  const nOn = (g) => GROUPS[g].filter((k) => app.bulk.mask[k]).length;
  const setGroup = (g, on) => GROUPS[g].forEach((k) => setBulkProp(k, on));

  // Tag scope: chapter or current page.
  let scope = $state('chapter');
  let tag = $state('');
  const scopePages = $derived(scope === 'page' ? [page()] : app.pages);
  const scopeWord = $derived(scope === 'page' ? 'this page' : 'the chapter');
  const tagList = $derived(app.bulk.active ? tagsInUse(scopePages) : []);
  const tagHits = $derived(tag ? boxesWithTag(tag, scopePages).length : 0);
  // Number of matching boxes off current page.
  const tagHitsHere = $derived(tag ? boxesWithTag(tag, [page()]).length : 0);
  const tagHitsAway = $derived(Math.max(0, tagHits - tagHitsHere));
  const tagPages = $derived(
    tag ? new Set(boxesWithTag(tag, scopePages).map((h) => h.page.id)).size : 0,
  );
  // Legacy free-typed boxes lacking queue lines.
  const freeCount = $derived(
    scopePages.reduce((n, p) => n + (p?.boxes ?? []).filter((b) => b.lineN == null).length, 0),
  );

  // Clear tag if not available in current scope.
  $effect(() => {
    if (tag && !tagList.includes(tag)) tag = '';
  });
  // Reset selected tag on open.
  $effect(() => {
    if (app.bulk.active) tag = '';
  });


  const canApplyTag = $derived(!!tag && ticked > 0 && tagHits > 0);

  // Move focus to Apply button on Enter.
  let applyTagBtn = $state(null);
  function onTagKey(e) {
    if (e.key !== 'Enter') return;

    e.preventDefault();
    applyTagBtn?.focus();
  }

  const alignIcons = {
    left: ['M3 6h18', 'M3 12h12', 'M3 18h15'],
    center: ['M3 6h18', 'M6 12h12', 'M5 18h14'],
    right: ['M3 6h18', 'M9 12h12', 'M6 18h15'],
  };
  const valignIcons = {
    top: ['M4 6h16', 'M9 10h6v8h-6z'],
    middle: ['M4 12h16', 'M9 8h6v8h-6z'],
    bottom: ['M4 18h16', 'M9 6h6v8h-6z'],
  };
</script>

{#snippet tick(key)}
  <input
    class="btick"
    type="checkbox"
    checked={!!app.bulk.mask[key]}
    onchange={(e) => setBulkProp(key, e.target.checked)}
    title="Include this property in the bulk edit"
  />
{/snippet}

{#snippet head(g, label)}
  <div
    class="insp-sub-head"
    role="button"
    tabindex="0"
    onclick={() => (open[g] = !open[g])}
    onkeydown={(e) => e.key === 'Enter' && (open[g] = !open[g])}
  >

    <input
      class="btick"
      type="checkbox"
      checked={nOn(g) === GROUPS[g].length}
      indeterminate={nOn(g) > 0 && nOn(g) < GROUPS[g].length}
      onclick={(e) => e.stopPropagation()}
      onchange={(e) => setGroup(g, e.target.checked)}
      title="Include every property in this group"
    />
    {label}
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
  </div>
{/snippet}

{#if app.bulk.active && s}
  <div class="bulk-panel" bind:this={panelEl} style={panelStyle}>
    <div class="bulk-head" onpointerdown={onHeadPointerDown}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      <b>Bulk style</b>
      <button class="x" title="Cancel" onclick={closeBulk}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>


    <div class="bulk-scroll">

    <div class="bulk-tag">
      <div class="trow">
        <span class="lbl">Scope</span>
        <div class="seg">
          <button class:on={scope === 'chapter'} onclick={() => (scope = 'chapter')}>Chapter</button>
          <button class:on={scope === 'page'} onclick={() => (scope = 'page')}>This page</button>
        </div>
      </div>

      <div class="trow">
        <span class="lbl">By tag</span>
        <select bind:value={tag} onkeydown={onTagKey} disabled={!tagList.length}>
          <option value="">{tagList.length ? 'Choose a tag…' : 'No tags in use'}</option>
          {#each tagList as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      <div class="trow">
        <span class="lbl"></span>
        <button
          class="btn btn-accent tag-go"
          bind:this={applyTagBtn}
          disabled={!canApplyTag}
          onclick={() => applyBulkToTag(tag, scopePages)}
        >
          {tag ? `Apply to “${tag}”` : 'Apply to tag'}
        </button>
      </div>
      <div class="bulk-note">
        {#if !tagList.length}
          No line in {scopeWord} carries a tag yet — tag them in the Text Queue first.
        {:else if !tag}
          Choose a tag to restyle every box carrying it in {scopeWord}.
        {:else}
          Applies to {tagHits} box{tagHits === 1 ? '' : 'es'} tagged “{tag}” in {scopeWord}.
          {#if !ticked}
            <br />Tick a property below first — nothing is set to change.
          {/if}
          {#if tagHitsAway}

            <br />{tagHitsAway} of them {tagHitsAway === 1 ? 'is' : 'are'} on other pages. Undo is per page:
            {tagPages} pages, one {modKey()}Z each, on the page itself.
          {/if}
        {/if}
        {#if freeCount}
          <br />{freeCount} older box{freeCount === 1 ? '' : 'es'} in {scopeWord} {freeCount === 1 ? 'has' : 'have'} no queue line, so {freeCount === 1 ? 'it carries' : 'they carry'} no tag and {freeCount === 1 ? 'is' : 'are'} never included. Retype {freeCount === 1 ? 'it' : 'them'} to make {freeCount === 1 ? 'it' : 'them'} taggable.
        {/if}
      </div>
    </div>

    <div class="bulk-hint">Or tick the properties to change, then click the boxes to apply them to.</div>

    <div class="bulk-body">
      <div class="insp-sub" class:closed={!open.font}>
        {@render head('font', 'Font & Layout')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask.font}>
            {@render tick('font')}
            <span class="lbl">Font</span>
            <select value={s.font} onchange={(e) => set('font', e.target.value)}>
              <optgroup label="Built-in">
                {#each app.fonts.builtin as f (f.name)}<option>{f.name}</option>{/each}
              </optgroup>
              {#if app.fonts.user.length}
                <optgroup label="User fonts">
                  {#each app.fonts.user as f (f.name)}<option>{f.name}</option>{/each}
                </optgroup>
              {/if}
            </select>
          </div>
          <div class="brow" class:off={!app.bulk.mask.size}>
            {@render tick('size')}
            <span class="lbl">Size</span>
            <input type="number" min="6" max="200" value={s.size} oninput={(e) => num('size', e.target.value || 6, 6, 200)} />
          </div>
          {#each [['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['uppercase', 'Caps', 'AA']] as [key, label, glyph] (key)}
            <div class="brow" class:off={!app.bulk.mask[key]}>
              {@render tick(key)}
              <span class="lbl">{label}</span>
              <div class="seg">
                <button class:on={get(key)} onclick={() => set(key, !get(key))}>{glyph}</button>
              </div>
            </div>
          {/each}
          <div class="brow" class:off={!app.bulk.mask.align}>
            {@render tick('align')}
            <span class="lbl">Align</span>
            <div class="seg">
              {#each ['left', 'center', 'right'] as al (al)}
                <button class:on={s.align === al} title={al} onclick={() => set('align', al)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.valign}>
            {@render tick('valign')}
            <span class="lbl">Vertical</span>
            <div class="seg">
              {#each ['top', 'middle', 'bottom'] as va (va)}
                <button class:on={s.valign === va} title={va} onclick={() => set('valign', va)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each valignIcons[va] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.lineHeight}>
            {@render tick('lineHeight')}
            <span class="lbl">Line</span>
            <input type="number" min="0.6" max="3" step="0.05" value={s.lineHeight} oninput={(e) => num('lineHeight', e.target.value || 1, 0.6, 3)} />
          </div>
          <div class="brow" class:off={!app.bulk.mask.letterSpacing}>
            {@render tick('letterSpacing')}
            <span class="lbl">Letter</span>
            <input type="number" min="-5" max="40" step="0.5" value={s.letterSpacing} oninput={(e) => num('letterSpacing', e.target.value, -5, 40)} />
          </div>
        </div>
      </div>

      <div class="insp-sub" class:closed={!open.fill}>
        {@render head('fill', 'Fill & Stroke')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask.color}>
            {@render tick('color')}
            <span class="lbl">Color</span>
            <div class="color-field">
              <span class="swatch"><input type="color" value={s.color} oninput={(e) => set('color', e.target.value)} /></span>
              <input type="text" class="hex" value={s.color} onchange={(e) => setHex('color', e.currentTarget.value, e.currentTarget)} />
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.opacity}>
            {@render tick('opacity')}
            <span class="lbl">Opacity</span>
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.01" value={s.opacity} oninput={(e) => set('opacity', +e.target.value)} />
              <span class="val">{Math.round(s.opacity * 100)}%</span>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.outline}>
            {@render tick('outline')}
            <span class="lbl">Outline</span>
            <div class="color-field">
              <span class="swatch"><input type="color" value={s.outline} oninput={(e) => set('outline', e.target.value)} /></span>
              <input type="text" class="hex" value={s.outline} onchange={(e) => setHex('outline', e.currentTarget.value, e.currentTarget)} />
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.outlineWidth}>
            {@render tick('outlineWidth')}
            <span class="lbl">Width</span>
            <input type="number" min="0" max="20" step="0.5" value={s.outlineWidth} oninput={(e) => num('outlineWidth', e.target.value, 0, 20)} />
          </div>
        </div>
      </div>

      <div class="insp-sub" class:closed={!open.shadow}>
        {@render head('shadow', 'Drop Shadow')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask['shadow.on']}>
            {@render tick('shadow.on')}
            <span class="lbl">Shadow</span>
            <div class="switch" class:on={s.shadow.on} role="switch" aria-checked={s.shadow.on} tabindex="0" onclick={() => set('shadow.on', !s.shadow.on)} onkeydown={(e) => e.key === 'Enter' && set('shadow.on', !s.shadow.on)}><span class="knob"></span></div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['shadow.x']}>
            {@render tick('shadow.x')}
            <span class="lbl">Offset X</span>
            <input type="number" value={s.shadow.x} oninput={(e) => num('shadow.x', e.target.value, -200, 200)} />
          </div>
          <div class="brow" class:off={!app.bulk.mask['shadow.y']}>
            {@render tick('shadow.y')}
            <span class="lbl">Offset Y</span>
            <input type="number" value={s.shadow.y} oninput={(e) => num('shadow.y', e.target.value, -200, 200)} />
          </div>
          <div class="brow" class:off={!app.bulk.mask['shadow.blur']}>
            {@render tick('shadow.blur')}
            <span class="lbl">Blur</span>
            <input type="number" min="0" max="50" value={s.shadow.blur} oninput={(e) => num('shadow.blur', e.target.value, 0, 50)} />
          </div>
          <div class="brow" class:off={!app.bulk.mask['shadow.opacity']}>
            {@render tick('shadow.opacity')}
            <span class="lbl">Opacity</span>
            <div class="slider-row">
              <input type="range" min="0" max="1" step="0.01" value={s.shadow.opacity} oninput={(e) => set('shadow.opacity', +e.target.value)} />
              <span class="val">{Math.round(s.shadow.opacity * 100)}%</span>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['shadow.color']}>
            {@render tick('shadow.color')}
            <span class="lbl">Color</span>
            <div class="color-field">
              <span class="swatch"><input type="color" value={s.shadow.color} oninput={(e) => set('shadow.color', e.target.value)} /></span>
              <input type="text" class="hex" value={s.shadow.color} onchange={(e) => setHex('shadow.color', e.currentTarget.value, e.currentTarget)} />
            </div>
          </div>
        </div>
      </div>

      <div class="insp-sub" class:closed={!open.warp}>
        {@render head('warp', 'Warp & Edges')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask.curve}>
            {@render tick('curve')}
            <span class="lbl">Curve</span>
            <div class="slider-row">
              <input type="range" min="-100" max="100" step="1" value={s.curve} oninput={(e) => set('curve', +e.target.value)} />
              <span class="val">{s.curve}</span>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['roughen.on']}>
            {@render tick('roughen.on')}
            <span class="lbl">Roughen</span>
            <div class="switch" class:on={s.roughen.on} role="switch" aria-checked={s.roughen.on} tabindex="0" onclick={() => set('roughen.on', !s.roughen.on)} onkeydown={(e) => e.key === 'Enter' && set('roughen.on', !s.roughen.on)}><span class="knob"></span></div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['roughen.amount']}>
            {@render tick('roughen.amount')}
            <span class="lbl">Amount</span>
            <div class="slider-row">
              <input type="range" min="0" max="20" step="0.5" value={s.roughen.amount} oninput={(e) => set('roughen.amount', +e.target.value)} />
              <span class="val">{s.roughen.amount}</span>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['roughen.detail']}>
            {@render tick('roughen.detail')}
            <span class="lbl">Grain</span>
            <div class="slider-row">
              <input type="range" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} oninput={(e) => set('roughen.detail', +e.target.value)} />
              <span class="val">{s.roughen.detail.toFixed(3)}</span>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask['roughen.seed']}>
            {@render tick('roughen.seed')}
            <span class="lbl">Seed</span>
            <input type="number" min="0" max="999" value={s.roughen.seed} oninput={(e) => set('roughen.seed', Math.round(clamp(+e.target.value || 0, 0, 999)))} />
          </div>
        </div>
      </div>


      <div class="insp-sub" class:closed={!open.typeset}>
        {@render head('typeset', 'Typeset')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask.shape}>
            {@render tick('shape')}
            <span class="lbl">Shaped breaks</span>
            <div class="switch" class:on={s.shape !== 'off'} role="switch" aria-checked={s.shape !== 'off'} tabindex="0" onclick={() => set('shape', s.shape === 'off' ? 'auto' : 'off')} onkeydown={(e) => e.key === 'Enter' && set('shape', s.shape === 'off' ? 'auto' : 'off')}><span class="knob"></span></div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.minOrphan}>
            {@render tick('minOrphan')}
            <span class="lbl">Min alone</span>
            <input type="number" min="1" max="8" value={s.minOrphan} oninput={(e) => set('minOrphan', Math.round(clamp(+e.target.value || 1, 1, 8)))} />
          </div>
          <div class="brow" class:off={!app.bulk.mask.hyphenate}>
            {@render tick('hyphenate')}
            <span class="lbl">Hyphenate</span>
            <div class="switch" class:on={s.hyphenate} role="switch" aria-checked={s.hyphenate} tabindex="0" onclick={() => set('hyphenate', !s.hyphenate)} onkeydown={(e) => e.key === 'Enter' && set('hyphenate', !s.hyphenate)}><span class="knob"></span></div>
          </div>

          <div class="brow" class:off={!app.bulk.mask.balloon}>
            {@render tick('balloon')}
            <span class="lbl">Balloon fit</span>
            <div class="switch" class:on={s.balloon} role="switch" aria-checked={s.balloon} tabindex="0" onclick={() => set('balloon', !s.balloon)} onkeydown={(e) => e.key === 'Enter' && set('balloon', !s.balloon)}><span class="knob"></span></div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.autoHeight}>
            {@render tick('autoHeight')}
            <span class="lbl">Auto height</span>
            <div class="switch" class:on={s.autoHeight} role="switch" aria-checked={s.autoHeight} tabindex="0" onclick={() => set('autoHeight', !s.autoHeight)} onkeydown={(e) => e.key === 'Enter' && set('autoHeight', !s.autoHeight)}><span class="knob"></span></div>
          </div>
        </div>
      </div>


      <div class="insp-sub" class:closed={!open.transform}>
        {@render head('transform', 'Transform')}
        <div class="insp-sub-body">
          <div class="brow" class:off={!app.bulk.mask.rotation}>
            {@render tick('rotation')}
            <span class="lbl">Rotation</span>
            <input type="number" min="-180" max="180" value={Math.round(s.rotation)} oninput={(e) => num('rotation', e.target.value, -180, 180)} />
          </div>
          <div class="brow" class:off={!app.bulk.mask.flipH}>
            {@render tick('flipH')}
            <span class="lbl">Flip H</span>
            <div class="seg">
              <button class:on={s.flipH} title="Mirror left↔right" onclick={() => set('flipH', !s.flipH)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18" stroke-dasharray="2 2" /><path d="M9 8l-5 4 5 4z" /><path d="M15 8l5 4-5 4z" /></svg>
              </button>
            </div>
          </div>
          <div class="brow" class:off={!app.bulk.mask.flipV}>
            {@render tick('flipV')}
            <span class="lbl">Flip V</span>
            <div class="seg">
              <button class:on={s.flipV} title="Mirror top↔bottom" onclick={() => set('flipV', !s.flipV)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h18" stroke-dasharray="2 2" /><path d="M8 9l4-5 4 5z" /><path d="M8 15l4 5 4-5z" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <div class="bulk-foot">
      <span class="cnt">{ticked} ticked · {count} selected</span>
      <button class="btn" onclick={closeBulk}>Cancel</button>
      <button class="btn btn-accent" disabled={count === 0 || ticked === 0} onclick={applyBulk}>Apply</button>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bulk-grip" onpointerdown={onGripPointerDown}></div>
  </div>
{/if}
