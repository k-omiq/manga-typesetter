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
  // `boxOwnText`, not `b.text`: a free-typed box's text lives on its queue line
  // and `b.text` is null on both sides of every edit to it, so this panel would
  // compare null against null, record nothing, and the next undo would rewind
  // some earlier edit instead.
  const snapOf = (b) => ({
    style: cloneStyle(b.style),
    text: boxOwnText(b),
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  });
  const geomOf = (snap) => ({ x: snap.x, y: snap.y, w: snap.w, h: snap.h });
  // The two fields the auto-fit is allowed to move, which is all a `style` or
  // `text` entry has any business restoring — the width and the x are the
  // Transform group's, and the `resize` entry is what carries those.
  const fitOf = (snap) => ({ y: snap.y, h: snap.h });

  // `opts.geom` is the panel saying it wrote x/y/w/h itself — the Transform
  // group, and nothing else. It exists because the height is no longer the
  // panel's alone: changing the font, the size or the line height now grows the
  // box through `autoFitBox`, and comparing geometry unconditionally would file
  // a `resize` entry beside the `style` one and charge two presses of undo for
  // one adjustment. An auto-grow gets no entry of its own; it rides on the style
  // entry, which carries the height either side of it (`fitOf` below).
  //
  // An object rather than a boolean because `touch` is also passed straight to
  // `oninput`/`onchange` on several controls, and a bare positional flag would
  // read the Event as "the panel wrote geometry".
  function touch(opts) {
    // A different box than the one still pending settles that one first, rather
    // than letting its entry stand in for an edit to this one.
    if (pending && pending.boxId !== box?.id) settle();
    // The before-snapshot is taken BEFORE the fit, so a run that also moved the
    // width records the height the box had when the run started rather than one
    // the fit had already changed.
    if (box && !pending) pending = { pageId: page().id, boxId: box.id, before: snapOf(box) };
    if (pending && opts?.geom) pending.geom = true;
    if (box) autoFitBox(box);
    markUnsaved();
    rememberStyle(box); // next placed box inherits the latest style tweaks
    clearTimeout(settleT);
    settleT = setTimeout(settle, SETTLE_MS);
  }

  // Everything that would make a pending entry land somewhere it does not
  // belong closes the window through this seam first: the page turn, the undo,
  // the start of a drag. Registered rather than exported, so nothing else has to
  // know this panel is on screen.
  // The seam hands back an unsubscribe that drops this registration and no
  // other, so teardown needs no notion of who currently owns the slot: with two
  // of these mounted — a second inspector, a detached one — the one leaving
  // releases itself and the one staying keeps hearing about settles.
  const releaseSettleHook = setEditSettleHook(settle);
  onDestroy(() => {
    // Settled first, because this panel does not only go away when the editor
    // does: hiding the Options panel unmounts it too — `FloatingPanel` renders
    // its children in the branch the hide chevron leaves — and an edit made and
    // hidden inside the settle window would otherwise stand in the document
    // with no entry to rewind it, so the next undo would rewind the step
    // before it instead. Safe on the teardown path for the same reason
    // `settle` is safe anywhere: `page()` is the frozen stand-in by then, so
    // the pending entry's page id cannot match and nothing is recorded.
    settle();
    releaseSettleHook();
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
    // The height the auto-fit left the box at on either side of the run, so an
    // undo of the style gives the geometry back rather than re-deriving a height
    // a grow-only fit cannot shrink. Harmless beside the `resize` entry below
    // when the panel wrote geometry itself: both pairs come off the same two
    // snapshots, so whichever order the steps are walked in they agree.
    const fit = { geomBefore: fitOf(before), geomAfter: fitOf(after) };
    if (JSON.stringify(before.style) !== JSON.stringify(after.style)) {
      record({ t: 'style', ...key, before: before.style, after: after.style, ...fit });
    }
    // Only when the panel itself wrote geometry. Every other way `h` can differ
    // between the two snapshots is the auto-fit following a style change, which
    // belongs to the `style` entry above and is put back by it.
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
    // See `setBoxText`: which field a box's text lives in is the store's rule,
    // and for a free-typed box it is the line's, not the box's.
    setBoxText(box, v);
    touch();
  }

  // ---------- ⌘Z inside the Text field ----------
  // The field owns its undo because nothing else does any more — see
  // field-undo.svelte.js for what removing the Edit menu's Undo item cost, and
  // why a controlled `value` would have broken WebKit's own stack regardless.
  const fieldUndo = createFieldUndo();
  // The box the stack is currently describing, so a reselect of the *same* box
  // does not throw away a run the user can still walk back through.
  let fieldOwner = null;

  // Anything that changes the field's text without going through `onTextInput`
  // — another box selected, an edit typed on the canvas, the editor history
  // rewinding this box — leaves the stack describing text that is no longer
  // there, and undoing through it would paste a different box's words back in.
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
    // Claimed here rather than left to bubble. The window handler already bows
    // out inside a field, but a build running in an ordinary browser still has
    // a native stack of its own, and letting the default through would undo the
    // same keystroke twice.
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return; // not `!next` — "" is a step like any other
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);
    // The node first, the store second. Svelte's `value` write is a no-op when
    // the node already reads the same string, so the selection set here
    // survives the re-render `setText` triggers.
    el.value = next;
    el.setSelectionRange(caret, caret);
    // And it goes through `setText` like typing does, so the canvas follows the
    // field and the change settles into the editor history as one text edit
    // rather than none.
    setText(next);
  }

  // The four hex lengths CSS actually has — #rgb, #rgba, #rrggbb, #rrggbbaa —
  // and not a `{3,8}` range, which also admitted 5 and 7 digits. `#12345` is not
  // a colour, and letting it through wrote an unparseable value onto the box.
  // `BulkStylePanel` carries the same constant for the same reason.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // `el` is the input the value came from. On a reject its value is put back by
  // hand: the state never changed, so nothing would re-render it, and the field
  // would go on showing text the panel had silently refused.
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
      <!-- A free-typed box's line number is negative and internal — see
           `isFreeLine` — so it is named for what it is rather than shown. Both
           the never-had-a-line box (`lineN == null`, saved before free boxes
           joined the queue) and today's read the same way to the user, because
           to the user they are the same thing. -->
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
        <!-- The balloon. Two controls rather than one, because they answer two
             different questions: the switch is "lay this box out to the shape it
             was fitted to", which a user turns off when the fit is on the wrong
             bubble or they simply want a rectangle; the button is "measure the
             shape again from where the box is NOW", which is what a box dragged
             onto another balloon — or a page cleaned after it was typeset —
             needs. Turning the switch off deliberately keeps the shape, so
             turning it back on costs nothing and does not need a re-measure. -->
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
          <!-- Typing a height smaller than the text needs is answered by the
               auto-fit growing it straight back, which is the point: the box's
               rectangle describes its text. Turn Auto-fit height off in the
               Typeset group to size it by hand. -->
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
