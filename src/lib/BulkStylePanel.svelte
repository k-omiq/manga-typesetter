<script>
  import { app, applyBulk, closeBulk } from './store.svelte.js';

  // app.bulk.style is the editable template; null when closed.
  const s = $derived(app.bulk.style);
  const count = $derived(app.bulk.targets.length);

  // Draggable panel position (inline left/top in px, relative to whichever
  // positioned ancestor it is rendered inside — `.ed-canvas`, the canvas
  // viewport. Both the opening centre below and the drag clamp read that same
  // `offsetParent`, so the panel stays over the page rather than the window.)
  let pos = $state({ x: 0, y: 16 });
  let panelEl;

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Re-center near top of the editor each time the panel opens, so it never gets lost.
  $effect(() => {
    if (app.bulk.active && panelEl) {
      const parent = panelEl.offsetParent || panelEl.parentElement;
      const pw = parent ? parent.clientWidth : panelEl.offsetWidth;
      pos = { x: Math.max(16, (pw - panelEl.offsetWidth) / 2), y: 16 };
    }
  });

  // Every gesture in flight, so an unmount can end them all — see the same set
  // in FloatingPanel. The listeners live on `window`, and nothing guarantees a
  // further pointer event once this panel is gone.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onHeadPointerDown(e) {
    // Don't start a drag from the close button (or anything inside it).
    if (e.target.closest('.x')) return;
    e.preventDefault();
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = pos.x;
    const baseY = pos.y;
    const move = (ev) => {
      // A second pointer — another touch, or a pen alongside the mouse — would
      // otherwise drive this same closure from a start point it never measured
      // against.
      if (ev.pointerId !== pid) return;
      const parent = panelEl?.offsetParent || panelEl?.parentElement;
      const pw = parent ? parent.clientWidth : window.innerWidth;
      const ph = parent ? parent.clientHeight : window.innerHeight;
      const w = panelEl?.offsetWidth || 0;
      const h = panelEl?.offsetHeight || 0;
      let nx = baseX + (ev.clientX - startX);
      let ny = baseY + (ev.clientY - startY);
      // Clamp so the header stays visible (keep at least ~40px on screen).
      nx = clamp(nx, 40 - w, pw - 40);
      ny = clamp(ny, 0, Math.max(0, ph - 40));
      pos = { x: nx, y: ny };
    };
    // One controller for both endings. It only moves panel position — there is
    // no history record to settle — so the end handler just tears down.
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
  function setHex(key, v) {
    if (/^#?[0-9a-f]{3,8}$/i.test(v)) s[key] = v.startsWith('#') ? v : '#' + v;
  }

  const alignIcons = {
    left: ['M3 6h18', 'M3 12h12', 'M3 18h15'],
    center: ['M3 6h18', 'M6 12h12', 'M5 18h14'],
    right: ['M3 6h18', 'M9 12h12', 'M6 18h15'],
  };
</script>

{#if app.bulk.active && s}
  <div class="bulk-panel" bind:this={panelEl} style="left:{pos.x}px; top:{pos.y}px">
    <div class="bulk-head" onpointerdown={onHeadPointerDown}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      <b>Bulk style</b>
      <button class="x" title="Cancel" onclick={closeBulk}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="bulk-hint">Set a style, then click the boxes to apply it to.</div>

    <div class="bulk-body">
      <div class="grp">
        <label class="lbl">Font family</label>
        <select bind:value={s.font}>
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

      <div class="row2">
        <div class="field">
          <label class="lbl">Size</label>
          <input type="number" min="6" max="200" value={s.size} oninput={(e) => (s.size = clamp(+e.target.value || 6, 6, 200))} />
        </div>
        <div class="field">
          <label class="lbl">Style</label>
          <div class="seg">
            <button class:on={s.bold} title="Bold" onclick={() => (s.bold = !s.bold)}><b>B</b></button>
            <button class:on={s.italic} title="Italic" onclick={() => (s.italic = !s.italic)}><i>I</i></button>
            <button class:on={s.uppercase} title="Uppercase" onclick={() => (s.uppercase = !s.uppercase)}>AA</button>
          </div>
        </div>
      </div>

      <div class="row2">
        <div class="field">
          <label class="lbl">Align</label>
          <div class="seg">
            {#each ['left', 'center', 'right'] as al (al)}
              <button class:on={s.align === al} onclick={() => (s.align = al)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
              </button>
            {/each}
          </div>
        </div>
        <div class="field">
          <label class="lbl">Rotation</label>
          <input type="number" min="-180" max="180" value={Math.round(s.rotation)} oninput={(e) => (s.rotation = clamp(+e.target.value || 0, -180, 180))} />
        </div>
      </div>

      <div class="grp">
        <label class="lbl">Text color</label>
        <div class="color-field">
          <span class="swatch"><input type="color" bind:value={s.color} /></span>
          <input type="text" class="hex" value={s.color} onchange={(e) => setHex('color', e.target.value)} />
        </div>
      </div>

      <div class="grp">
        <label class="lbl">Outline</label>
        <div class="color-field">
          <span class="swatch"><input type="color" bind:value={s.outline} /></span>
          <input type="text" class="hex" value={s.outline} onchange={(e) => setHex('outline', e.target.value)} style="flex:0 0 80px" />
          <input type="number" min="0" max="20" step="0.5" value={s.outlineWidth} title="Outline width" style="flex:1 1 auto" oninput={(e) => (s.outlineWidth = clamp(+e.target.value || 0, 0, 20))} />
        </div>
      </div>
    </div>

    <div class="bulk-foot">
      <span class="cnt">{count} selected</span>
      <button class="btn" onclick={closeBulk}>Cancel</button>
      <button class="btn btn-accent" disabled={count === 0} onclick={applyBulk}>Apply</button>
    </div>
  </div>
{/if}
