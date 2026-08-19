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
    boxOwnText,
    setBoxText,
    isFreeBox,
    autoFitBox,
    refitBalloon,
  } from './store.svelte.js';
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
  import { onDestroy } from 'svelte';

  const box = $derived(app.selectedId ? byId(app.selectedId) : null);

  let open = $state({ font: true, fill: true, shadow: false, warp: false, typeset: false, transform: true });

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Debounce history recording during continuous adjustments.
  const SETTLE_MS = 400;
  let pending = null;
  let settleT;

  // Capture style, transform geometry, and text for undo history.
  const snapOf = (b) => ({
    style: cloneStyle(b.style),
    text: boxOwnText(b),
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  });
  const geomOf = (snap) => ({ x: snap.x, y: snap.y, w: snap.w, h: snap.h });

  const fitOf = (snap) => ({ y: snap.y, h: snap.h });

  // Explicit geometry edits record resize history.
  function touch(opts) {

    if (pending && pending.boxId !== box?.id) settle();

    if (box && !pending) pending = { pageId: page().id, boxId: box.id, before: snapOf(box) };
    if (pending && opts?.geom) pending.geom = true;
    if (box) autoFitBox(box);
    markUnsaved();
    rememberStyle(box);
    clearTimeout(settleT);
    settleT = setTimeout(settle, SETTLE_MS);
  }

  // Hook to settle pending edits on navigation or undo.
  const releaseSettleHook = setEditSettleHook(settle);
  onDestroy(() => {
    // Settle pending changes on panel unmount.
    clearTimeout(settleT);
    pending = null;
  });

  function settle() {
    clearTimeout(settleT);
    const pend = pending;
    pending = null;
    if (!pend) return;
    // Ignore pending edits for previous pages.
    if (pend.pageId !== page().id) return;

    const b = pageById(pend.pageId)?.boxes.find((x) => x.id === pend.boxId);
    if (!b) return;
    const before = pend.before;
    const after = snapOf(b);
    const key = { pageId: pend.pageId, boxId: b.id };
    // Record style edit with before/after geometry.
    const fit = { geomBefore: fitOf(before), geomAfter: fitOf(after) };
    if (JSON.stringify(before.style) !== JSON.stringify(after.style)) {
      record({ t: 'style', ...key, before: before.style, after: after.style, ...fit });
    }

    if (pend.geom && ['x', 'y', 'w', 'h'].some((k) => before[k] !== after[k])) {
      record({ t: 'resize', ...key, before: geomOf(before), after: geomOf(after) });
    }
    if (before.text !== after.text) {
      record({ t: 'text', ...key, before: before.text ?? null, after: after.text, ...fit });
    }
  }
  function setSize(v) {
    box.style.size = clamp(+v || 6, 6, 200);
    touch();
  }

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

    setBoxText(box, v);
    touch();
  }

  // Text field maintains its own undo stack.
  const fieldUndo = createFieldUndo();

  let fieldOwner = null;

  // Resync undo stack when box or text changes externally.
  $effect(() => {
    const id = box?.id ?? null;
    const v = box ? boxText(box) : '';
    if (id === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = id;
    resyncField(fieldUndo, v);
  });

  function onTextInput(e) {
    recordFieldEdit(fieldUndo, e.target.value, { atomic: isAtomicInput(e.inputType) });
    setText(e.target.value);
  }

  function onTextKey(e) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    // Intercept Cmd+Z/Shift+Cmd+Z for field undo.
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);

    el.value = next;
    el.setSelectionRange(caret, caret);

    setText(next);
  }

  // Validate CSS hex color strings.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  function setHex(obj, key, v, el) {
    if (HEX.test(v)) {
      obj[key] = v.startsWith('#') ? v : '#' + v;
      touch();
    } else if (el) {
      el.value = obj[key];
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

      <label class="lbl">Text {isFreeBox(box) ? '· free' : `· line ${box.lineN}`}</label>
      <textarea value={boxText(box)} oninput={onTextInput} onkeydown={onTextKey} ondblclick={() => beginEdit(box.id)}></textarea>
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
            <input type="text" class="hex" value={s.color} onchange={(e) => setHex(s, 'color', e.target.value, e.target)} />
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
            <input type="text" class="hex" value={s.outline} onchange={(e) => setHex(s, 'outline', e.target.value, e.target)} style="flex:0 0 88px" />
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
              <input type="text" class="hex" value={s.shadow.color} onchange={(e) => setHex(s.shadow, 'color', e.target.value, e.target)} />
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

    <!-- Typeset -->
    <div class="insp-sub" class:closed={!open.typeset}>
      <div class="insp-sub-head" role="button" tabindex="0" onclick={() => (open.typeset = !open.typeset)} onkeydown={(e) => e.key === 'Enter' && (open.typeset = !open.typeset)}>
        Typeset
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <div class="insp-sub-body">
        <div class="switch-row">
          <div class="switch" class:on={s.shape !== 'off'} role="switch" aria-checked={s.shape !== 'off'} tabindex="0" onclick={() => { s.shape = s.shape === 'off' ? 'auto' : 'off'; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.shape = s.shape === 'off' ? 'auto' : 'off'), touch())}><span class="knob"></span></div>
          <span class="lbl2">Shaped line breaks</span>
        </div>
        <div class="grp">
          <label class="lbl">Never alone on a line · under</label>
          <input type="number" min="1" max="8" value={s.minOrphan} title="A word with fewer letters than this is never left alone on a line" oninput={(e) => { s.minOrphan = clamp(Math.round(+e.target.value || 1), 1, 8); touch(); }} />
        </div>
        <div class="switch-row">
          <div class="switch" class:on={s.hyphenate} role="switch" aria-checked={s.hyphenate} tabindex="0" onclick={() => { s.hyphenate = !s.hyphenate; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.hyphenate = !s.hyphenate), touch())}><span class="knob"></span></div>
          <span class="lbl2" title="A word that fits on no line of this block may be split with a hyphen">Hyphenate long words</span>
        </div>

        <div class="switch-row">
          <div class="switch" class:on={s.balloon} role="switch" aria-checked={s.balloon} tabindex="0" onclick={() => { s.balloon = !s.balloon; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.balloon = !s.balloon), touch())}><span class="knob"></span></div>
          <span class="lbl2" title="Lay the text out to the balloon this box was fitted to, instead of to its rectangle">Fit text to balloon</span>
        </div>
        <div class="grp">
          <label class="lbl">{box.fit ? (box.fit.kind === 'ellipse' ? 'Fitted · oval balloon' : 'Fitted · rectangular panel') : 'Not fitted · rectangular layout'}</label>
          <div class="seg">
            <button title="Measure the balloon under this box again, from where the box is now" onclick={() => { refitBalloon(box.id); touch(); }}>
              {box.fit ? 'Re-fit to balloon' : 'Fit to balloon'}
            </button>
          </div>
        </div>
        <div class="switch-row">
          <div class="switch" class:on={s.autoHeight} role="switch" aria-checked={s.autoHeight} tabindex="0" onclick={() => { s.autoHeight = !s.autoHeight; touch(); }} onkeydown={(e) => e.key === 'Enter' && ((s.autoHeight = !s.autoHeight), touch())}><span class="knob"></span></div>
          <span class="lbl2">Auto-fit height</span>
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
          <div class="field"><label class="lbl">X</label><input type="number" value={Math.round(box.x)} oninput={(e) => { box.x = +e.target.value || 0; touch({ geom: true }); }} /></div>
          <div class="field"><label class="lbl">Y</label><input type="number" value={Math.round(box.y)} oninput={(e) => { box.y = +e.target.value || 0; touch({ geom: true }); }} /></div>
        </div>
        <div class="row2">
          <div class="field"><label class="lbl">Width</label><input type="number" min="40" value={Math.round(box.w)} oninput={(e) => { box.w = clamp(+e.target.value || 40, 40, 5000); touch({ geom: true }); }} /></div>

          <div class="field"><label class="lbl">Height</label><input type="number" min="30" value={Math.round(box.h)} oninput={(e) => { box.h = clamp(+e.target.value || 30, 30, 5000); touch({ geom: true }); }} /></div>
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
