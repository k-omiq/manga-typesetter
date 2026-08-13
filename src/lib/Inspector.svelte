<script module>
  // Which instance's `settle` currently holds the store's single settle slot.
  // Shared across instances on purpose: a panel on its way out must only take
  // the slot back if it is still its own. With two of these mounted — a second
  // inspector, a detached one — an unconditional release would silently disable
  // the seam for the one that is staying.
  let owner = null;
</script>

<script>
  import {
    app,
    byId,
    boxText,
    deleteBox,
    markUnsaved,
    beginEdit,
    rememberStyle,
    cloneStyle,
    page,
    pageById,
    setEditSettleHook,
  } from './store.svelte.js';
  import { record } from './editor/history.svelte.js';
  import { onDestroy } from 'svelte';

  const box = $derived(app.selectedId ? byId(app.selectedId) : null);

  let open = $state({ font: true, fill: true, shadow: false, warp: false, transform: true });

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // ---------- one history entry per adjustment ----------
  // `touch()` runs after every change this panel makes: every keystroke in a
  // number field and every pixel of a slider drag. Recording there would spend
  // the whole five-step history on one drag of the opacity slider, so the box is
  // captured the first time a control is touched and the entry is written once
  // the changes stop.
  const SETTLE_MS = 400;
  let pending = null;
  let settleT;

  // The three kinds of edit this panel makes, in one snapshot: the style, the
  // geometry the Transform group writes straight onto the box, and the content
  // box's text. Each is compared on its own and recorded as its own kind. An
  // edit left unrecorded is worse than one with no undo at all — the next press
  // then rewinds something the user did not just do.
  const snapOf = (b) => ({
    style: cloneStyle(b.style),
    text: b.text,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  });
  const geomOf = (snap) => ({ x: snap.x, y: snap.y, w: snap.w, h: snap.h });

  function touch() {
    // A different box than the one still pending settles that one first, rather
    // than letting its entry stand in for an edit to this one.
    if (pending && pending.boxId !== box?.id) settle();
    if (box && !pending) pending = { pageId: page().id, boxId: box.id, before: snapOf(box) };
    markUnsaved();
    rememberStyle(box); // next placed box inherits the latest style tweaks
    clearTimeout(settleT);
    settleT = setTimeout(settle, SETTLE_MS);
  }

  // Everything that would make a pending entry land somewhere it does not
  // belong closes the window through this seam first: the page turn, the undo,
  // the start of a drag. Registered rather than exported, so nothing else has to
  // know this panel is on screen.
  setEditSettleHook(settle);
  owner = settle;
  onDestroy(() => {
    // Only ours to release — see `owner` above.
    if (owner === settle) {
      setEditSettleHook(null);
      owner = null;
    }
    // A settle that fires after this panel is gone would be reading whatever
    // document is open by then. Page and box ids come off per-document
    // counters and collide freely across chapters, so a stale entry could find
    // a live box of the same name and record an edit nobody made.
    clearTimeout(settleT);
    pending = null;
  });

  function settle() {
    clearTimeout(settleT);
    const pend = pending;
    pending = null;
    if (!pend) return;
    // Belt and braces beside that seam: `record` pushes onto whichever page's
    // stack is live and has no page awareness of its own, so an entry for a
    // page that has since been left would land on the page now on screen — and
    // the next write would then file that page's whole stack under this one's
    // key. The hook is what stops that happening; this is what keeps it from
    // mattering should a path ever be added that does not call the hook.
    if (pend.pageId !== page().id) return;
    // Resolved by id rather than read off `box`: the settle can land after the
    // user has selected something else, and the entry belongs to the box that
    // was edited either way.
    const b = pageById(pend.pageId)?.boxes.find((x) => x.id === pend.boxId);
    if (!b) return; // deleted while the timer ran — its own record covers that
    const before = pend.before;
    const after = snapOf(b);
    const key = { pageId: pend.pageId, boxId: b.id };
    if (JSON.stringify(before.style) !== JSON.stringify(after.style)) {
      record({ t: 'style', ...key, before: before.style, after: after.style });
    }
    if (['x', 'y', 'w', 'h'].some((k) => before[k] !== after[k])) {
      record({ t: 'resize', ...key, before: geomOf(before), after: geomOf(after) });
    }
    if (before.text !== after.text) {
      record({ t: 'text', ...key, before: before.text ?? null, after: after.text });
    }
  }
  function setSize(v) {
    box.style.size = clamp(+v || 6, 6, 200);
    touch();
  }
  // normalize any angle into (-180, 180]
  function wrap180(v) {
    return (((v + 180) % 360) + 360) % 360 - 180;
  }
  function setRotation(v) {
    box.style.rotation = clamp(Math.round(+v || 0), -180, 180);
    touch();
  }
  function rotateBy(d) {
    box.style.rotation = wrap180(Math.round(box.style.rotation + d));
    touch();
  }
  function setText(v) {
    box.text = v;
    touch();
  }
  function setHex(obj, key, v) {
    if (/^#?[0-9a-f]{3,8}$/i.test(v)) {
      obj[key] = v.startsWith('#') ? v : '#' + v;
      touch();
    }
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

{#if !box}
  <div class="insp-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    <div>No text box selected.<br />Click a box, or use the Text tool to add one.</div>
  </div>
{:else}
  {@const s = box.style}
  <div class="insp">
    <!-- Content -->
    <div class="grp">
      <label class="lbl">Text {box.lineN != null ? `· line ${box.lineN}` : '· free'}</label>
      <textarea value={boxText(box)} oninput={(e) => setText(e.target.value)} ondblclick={() => beginEdit(box.id)}></textarea>
    </div>

    <!-- Rotation (always visible) -->
    <div class="grp">
      <label class="lbl">Rotation · {Math.round(s.rotation)}°</label>
      <div class="rot-row">
        <button class="rbtn" title="Rotate −90°" onclick={() => rotateBy(-90)}>−90</button>
        <button class="rbtn" title="Rotate −15°" onclick={() => rotateBy(-15)}>−15</button>
        <input type="range" min="-180" max="180" step="1" value={s.rotation} oninput={(e) => setRotation(e.target.value)} />
        <button class="rbtn" title="Rotate +15°" onclick={() => rotateBy(15)}>+15</button>
        <button class="rbtn" title="Rotate +90°" onclick={() => rotateBy(90)}>+90</button>
        <button class="rbtn reset" title="Reset to 0°" onclick={() => setRotation(0)} disabled={Math.round(s.rotation) === 0}>0°</button>
      </div>
    </div>

    <!-- Font -->
    <div class="insp-sub" class:closed={!open.font}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.font = !open.font)} onkeydown={(e) => e.key === 'Enter' && (open.font = !open.font)}>
        Font & Layout
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="grp">
          <label class="lbl">Font family</label>
          <select bind:value={s.font} onchange={touch}>
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
        <div class="grp">
          <label class="lbl">Size</label>
          <div class="size-row">
            <input type="number" min="6" max="200" value={s.size} oninput={(e) => setSize(e.target.value)} />
            <input type="range" min="6" max="120" value={Math.min(s.size, 120)} oninput={(e) => setSize(e.target.value)} />
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label class="lbl">Style</label>
            <div class="seg">
              <button class:on={s.bold} title="Bold" onclick={() => { s.bold = !s.bold; touch(); }}><b>B</b></button>
              <button class:on={s.italic} title="Italic" onclick={() => { s.italic = !s.italic; touch(); }}><i>I</i></button>
              <button class:on={s.uppercase} title="Uppercase" onclick={() => { s.uppercase = !s.uppercase; touch(); }}>AA</button>
            </div>
          </div>
          <div class="field">
            <label class="lbl">Align</label>
            <div class="seg">
              {#each ['left', 'center', 'right'] as al (al)}
                <button class:on={s.align === al} onclick={() => { s.align = al; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label class="lbl">Vertical</label>
            <div class="seg">
              {#each ['top', 'middle', 'bottom'] as va (va)}
                <button class:on={s.valign === va} title={va} onclick={() => { s.valign = va; touch(); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each valignIcons[va] as d}<path {d} />{/each}</svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="field">
            <label class="lbl">Line · Letter</label>
            <div class="row2">
              <input type="number" min="0.6" max="3" step="0.05" value={s.lineHeight} title="Line height" oninput={(e) => { s.lineHeight = clamp(+e.target.value || 1, 0.6, 3); touch(); }} />
              <input type="number" min="-5" max="40" step="0.5" value={s.letterSpacing} title="Letter spacing" oninput={(e) => { s.letterSpacing = +e.target.value || 0; touch(); }} />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Fill & Stroke -->
    <div class="insp-sub" class:closed={!open.fill}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.fill = !open.fill)} onkeydown={(e) => e.key === 'Enter' && (open.fill = !open.fill)}>
        Fill & Stroke
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="grp">
          <label class="lbl">Text color</label>
          <div class="color-field">
            <span class="swatch"><input type="color" bind:value={s.color} oninput={touch} /></span>
            <input type="text" class="hex" value={s.color} onchange={(e) => setHex(s, 'color', e.target.value)} />
          </div>
        </div>
        <div class="grp">
          <label class="lbl">Opacity</label>
          <div class="slider-row">
            <input type="range" min="0" max="1" step="0.01" value={s.opacity} oninput={(e) => { s.opacity = +e.target.value; touch(); }} />
            <span class="val">{Math.round(s.opacity * 100)}%</span>
          </div>
        </div>
        <div class="grp">
          <label class="lbl">Outline</label>
          <div class="color-field">
            <span class="swatch"><input type="color" bind:value={s.outline} oninput={touch} /></span>
            <input type="text" class="hex" value={s.outline} onchange={(e) => setHex(s, 'outline', e.target.value)} style="flex:0 0 88px" />
            <input type="number" min="0" max="20" step="0.5" value={s.outlineWidth} title="Outline width" style="flex:1 1 auto" oninput={(e) => { s.outlineWidth = clamp(+e.target.value || 0, 0, 20); touch(); }} />
          </div>
        </div>
      </div>
    </div>

    <!-- Shadow -->
    <div class="insp-sub" class:closed={!open.shadow}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.shadow = !open.shadow)} onkeydown={(e) => e.key === 'Enter' && (open.shadow = !open.shadow)}>
        Drop Shadow
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="switch-row">
          <div class="switch" class:on={s.shadow.on} role="switch" aria-checked={s.shadow.on} tabindex="0" onclick={() => { s.shadow.on = !s.shadow.on; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.shadow.on = !s.shadow.on), touch())}><span class="knob"></span></div>
          <span class="lbl2">Enable shadow</span>
        </div>
        <div class="insp-sub-body" class:disabled={!s.shadow.on} style="padding:0;border:none;gap:11px">
          <div class="row2">
            <div class="field"><label class="lbl">Offset X</label><input type="number" value={s.shadow.x} oninput={(e) => { s.shadow.x = +e.target.value || 0; touch(); }} /></div>
            <div class="field"><label class="lbl">Offset Y</label><input type="number" value={s.shadow.y} oninput={(e) => { s.shadow.y = +e.target.value || 0; touch(); }} /></div>
          </div>
          <div class="row2">
            <div class="field"><label class="lbl">Blur</label><input type="number" min="0" max="50" value={s.shadow.blur} oninput={(e) => { s.shadow.blur = clamp(+e.target.value || 0, 0, 50); touch(); }} /></div>
            <div class="field">
              <label class="lbl">Opacity</label>
              <div class="slider-row"><input type="range" min="0" max="1" step="0.01" value={s.shadow.opacity} oninput={(e) => { s.shadow.opacity = +e.target.value; touch(); }} /><span class="val">{Math.round(s.shadow.opacity * 100)}%</span></div>
            </div>
          </div>
          <div class="grp">
            <label class="lbl">Shadow color</label>
            <div class="color-field">
              <span class="swatch"><input type="color" bind:value={s.shadow.color} oninput={touch} /></span>
              <input type="text" class="hex" value={s.shadow.color} onchange={(e) => setHex(s.shadow, 'color', e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Warp & Roughen -->
    <div class="insp-sub" class:closed={!open.warp}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.warp = !open.warp)} onkeydown={(e) => e.key === 'Enter' && (open.warp = !open.warp)}>
        Warp & Edges
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="grp">
          <label class="lbl">Curve / arc</label>
          <div class="slider-row">
            <input type="range" min="-100" max="100" step="1" value={s.curve} oninput={(e) => { s.curve = +e.target.value; touch(); }} />
            <span class="val">{s.curve}</span>
          </div>
        </div>
        <div class="switch-row">
          <div class="switch" class:on={s.roughen.on} role="switch" aria-checked={s.roughen.on} tabindex="0" onclick={() => { s.roughen.on = !s.roughen.on; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.roughen.on = !s.roughen.on), touch())}><span class="knob"></span></div>
          <span class="lbl2">Roughen edges</span>
        </div>
        <div class="insp-sub-body" class:disabled={!s.roughen.on} style="padding:0;border:none;gap:11px">
          <div class="grp">
            <label class="lbl">Amount</label>
            <div class="slider-row"><input type="range" min="0" max="20" step="0.5" value={s.roughen.amount} oninput={(e) => { s.roughen.amount = +e.target.value; touch(); }} /><span class="val">{s.roughen.amount}</span></div>
          </div>
          <div class="grp">
            <label class="lbl">Grain</label>
            <div class="slider-row"><input type="range" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} oninput={(e) => { s.roughen.detail = +e.target.value; touch(); }} /><span class="val">{s.roughen.detail.toFixed(3)}</span></div>
          </div>
          <div class="grp">
            <label class="lbl">Seed</label>
            <input type="number" min="0" max="999" value={s.roughen.seed} oninput={(e) => { s.roughen.seed = Math.round(+e.target.value || 0); touch(); }} />
          </div>
        </div>
      </div>
    </div>

    <!-- Transform -->
    <div class="insp-sub" class:closed={!open.transform}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.transform = !open.transform)} onkeydown={(e) => e.key === 'Enter' && (open.transform = !open.transform)}>
        Transform
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="row3">
          <div class="field"><label class="lbl">Rotation</label><input type="number" min="-180" max="180" value={Math.round(s.rotation)} oninput={(e) => { s.rotation = clamp(+e.target.value || 0, -180, 180); touch(); }} /></div>
          <div class="field"><label class="lbl">X</label><input type="number" value={Math.round(box.x)} oninput={(e) => { box.x = +e.target.value || 0; touch(); }} /></div>
          <div class="field"><label class="lbl">Y</label><input type="number" value={Math.round(box.y)} oninput={(e) => { box.y = +e.target.value || 0; touch(); }} /></div>
        </div>
        <div class="row2">
          <div class="field"><label class="lbl">Width</label><input type="number" min="40" value={Math.round(box.w)} oninput={(e) => { box.w = clamp(+e.target.value || 40, 40, 5000); touch(); }} /></div>
          <div class="field"><label class="lbl">Height</label><input type="number" min="30" value={Math.round(box.h)} oninput={(e) => { box.h = clamp(+e.target.value || 30, 30, 5000); touch(); }} /></div>
        </div>
        <div class="field">
          <label class="lbl">Mirror</label>
          <div class="seg">
            <button class:on={s.flipH} title="Flip horizontal (mirror left↔right)" onclick={() => { s.flipH = !s.flipH; touch(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18" stroke-dasharray="2 2" /><path d="M9 8l-5 4 5 4z" /><path d="M15 8l5 4-5 4z" /></svg>
            </button>
            <button class:on={s.flipV} title="Flip vertical (mirror top↔bottom)" onclick={() => { s.flipV = !s.flipV; touch(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h18" stroke-dasharray="2 2" /><path d="M8 9l4-5 4 5z" /><path d="M8 15l4 5 4-5z" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <button class="btn-danger" onclick={() => deleteBox(box.id)}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
      Delete box
    </button>
  </div>
{/if}
