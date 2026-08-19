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

  // `pg` is the page this box is on. It defaults to the current page, which is
  // the only page a paged canvas draws — but a longstrip canvas draws every page
  // in the chapter at once, and a box two slices below the one the scroll
  // position calls current still has to resolve its own line, clamp to its own
  // page's height and measure against its own frame. Everything below that used
  // to call `page()` reads this instead; the default is what keeps the paged
  // call site identical.
  let { box, pageFrameEl, pg = page() } = $props();

  const z = $derived(app.zoom);
  const selected = $derived(app.selectedId === box.id);
  const editing = $derived(app.editingId === box.id);
  const bulkOn = $derived(app.bulk.active);
  const bulkTarget = $derived(isBulkTarget(box.id));
  const s = $derived(box.style);
  const text = $derived(boxText(box, pg));
  // Japanese reference for the box's source line (overlay only — never the text content).
  const line = $derived(box.lineN != null ? lineByN(pg, box.lineN) : null);
  const jp = $derived(line?.jp ?? '');
  const isSfx = $derived(line?.type === 'sfx');

  const effSize = $derived(s.size * z);
  const effLs = $derived(s.letterSpacing * z);
  // Doubled, because both painters centre their stroke on the glyph path and
  // then cover the inner half with the fill — so what you actually see is half
  // the width you asked for. The exporter already accounts for that
  // (`ctx.lineWidth = s.outlineWidth * 2` in exporter.js, and the PSD writer
  // emits an *outside* stroke of `s.outlineWidth`), which made `outlineWidth`
  // mean "visible outline" everywhere except here: this preview drew
  // `outlineWidth` centred, showed `outlineWidth / 2`, and every export came
  // back twice as heavy as the canvas it was set on. Same convention now in all
  // three, so the number in the Inspector is the outline the reader sees.
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
    s.curve && s.curve !== 0 && !editing && text !== '' ? arcLayout(applyCase(text, s), s, effSize) : null,
  );

  // The lines the canvas actually draws, when shaping is on. Two things about
  // how they are computed are load-bearing:
  //
  //   the size is s.size, NOT effSize. The exporter breaks lines at the style's
  //   own size and the box's own content width; asking the same question with
  //   the same numbers here is what makes the canvas and the PNG break in the
  //   same places at every zoom level. Rendering then happens at effSize, which
  //   only scales the picture.
  //
  //   the text is case-applied. The CSS does the uppercasing visually, but
  //   uppercase glyphs are wider, so the *measurement* has to see the same
  //   string the exporter measures. Rendering the case-applied line under a
  //   `text-transform:uppercase` that would produce it anyway changes nothing.
  //
  // Null while editing: the contenteditable is uncontrolled and its caret logic
  // is delicate, so the raw editable is left exactly as it was and the shaped
  // block reappears when the edit ends.
  const shaped = $derived.by(() => {
    if (editing || layout) return null;
    if ((s.shape ?? 'auto') === 'off') return null;
    // A font arriving is a change to every width this measures with, and it is
    // not otherwise reactive: the family named in the style is the same string
    // before and after the face loads. Without this the block keeps the breaks
    // it derived against the fallback family for the rest of the session, and
    // the export — which waits for the fonts before it measures — draws
    // different ones. See `noteFontsChanged`.
    app.fontsVersion;
    // The fifth argument is the balloon this box was fitted to, as one usable
    // width per line, and it is null for a box that has none — which is every
    // box that ever existed before fitting did, so that path is unchanged down
    // to the character. `balloonWidthsFor` reads `box.fit`, `s.balloon`,
    // `s.lineHeight` and `s.valign` through the reactive proxy, so changing any
    // of them re-breaks the block here without another dependency being named.
    return layoutLines(
      applyCase(text, s),
      s,
      s.size,
      Math.max(1, box.w - BOX_PAD * 2),
      balloonWidthsFor(box, s, s.size),
    );
  });

  // The safety net, and only that. Every path that changes a box's text or its
  // metrics fits the box itself (see `autoFitBox` in the store), because a box on
  // a page the user is not looking at has no component to run an effect in. What
  // this covers is the residue: any path added later that forgets.
  //
  // `app.fontsVersion` is in the list because a face loading changes what every
  // width measures to. The store refits the whole chapter on the same signal, so
  // this is genuinely redundant for a box that was already on screen — and not
  // for one whose page is opened between the bump and now, whose height was
  // written from the fallback metric by a `loadProjectPages` that ran before the
  // font existed.
  //
  // Untracked around the call because `autoFitBox` reads `box.h` and writes it —
  // tracked, that is a loop. The dependencies are the ones named here on purpose:
  // what the box has to fit, and nothing it produces.
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

  // Mirror flip applied to the rendered glyphs (not the box chrome / handles).
  // Rotation lives on .tbox (outer) and the flip on the text (inner), so the
  // composition matches the exporter's rotate-then-flip order.
  const mirror = $derived(
    s.flipH || s.flipV ? `scale(${s.flipH ? -1 : 1}, ${s.flipV ? -1 : 1})` : '',
  );

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Every gesture in flight, so an unmount can end them all — the same net
  // FloatingPanel keeps, for the same reason: the listeners live on `document`
  // and nothing guarantees a further pointer event once this box is gone (an
  // undo that deletes it, a page turn), so they would go on writing geometry
  // onto a box nobody can see. A set rather than one slot because a move and a
  // handle drag can both be down at once, and a lone slot would let the second
  // overwrite the first one's net.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onBoxPointerDown(e) {
    if (editing) return; // let caret work
    // The primary button and nothing else. A right-click is on its way to a
    // context menu and a middle one is a paste on some platforms; neither is a
    // request to select this box, drag it, or add it to a bulk edit.
    if (e.button !== 0) return;
    // Before anything is selected or recorded. In a strip the box under the
    // pointer may be on a page the index is not on, and selection, the live undo
    // stack and the inspector are all scoped to the current page — so touching a
    // box is what makes its page current. A no-op in a paged chapter, where the
    // only boxes on screen are this page's.
    focusPage(pg);
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
    focusPage(pg); // see onBoxPointerDown
    beginEdit(box.id);
  }

  function startMove(e) {
    e.preventDefault();
    // The drag follows the pointer even once it leaves the window: without the
    // capture, a button released outside gets no pointerup here at all and the
    // box comes back stuck to the cursor. The listeners still live on
    // `document` — a captured pointer's events are retargeted at the capture
    // element and go on bubbling from there.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Whatever the Inspector is still holding is written now, from the geometry
    // this drag is about to change. Left to its own timer it would fire
    // mid-drag, record a resize from the pre-tweak geometry, and cost the user
    // two of their five steps for one gesture.
    settleEdits();
    const zz = app.zoom;
    const dims = pg;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;
    // One drag is one entry, so the before-state is taken here and the record
    // written on the end handler — never in `move`, which fires per pixel and
    // would spend the whole five-step history on a single gesture.
    const pageId = dims.id;
    const before = { x: ox, y: oy };
    const move = (ev) => {
      // A second pointer — another touch, or a pen alongside the mouse — would
      // otherwise drive this same closure from a start point it never measured
      // against.
      if (ev.pointerId !== pid) return;
      box.x = clamp(ox + (ev.clientX - sx) / zz, -box.w + 20, dims.w - 20);
      box.y = clamp(oy + (ev.clientY - sy) / zz, -box.h + 20, dims.h - 20);
      markUnsaved();
    };
    // One controller for both endings, and the record written from the one
    // handler both reach. A gesture does not always end in a pointerup: an OS
    // gesture claiming the pointer, or a lost capture, fires pointercancel
    // instead — and a drag that ended there left the geometry moved and
    // markUnsaved already fired with no entry to rewind it, so the next undo
    // would step over it onto the edit before.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      // A click that never moved is not an edit.
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
    if (e.button !== 0) return; // see onBoxPointerDown
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId); // see startMove
    focusPage(pg); // see onBoxPointerDown
    if (!selected) selectBox(box.id);
    settleEdits(); // same as startMove: one gesture must not cost two steps
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;
    // `o` is both the origin the drag measures against and the before-state the
    // record is written from — the same five fields either way.
    const o = { x: box.x, y: box.y, w: box.w, h: box.h, size: s.size };
    const isRot = dir === 'rot';
    // Held rather than re-read per frame, exactly as `startMove` holds it: the
    // auto-fit clamps against this page's height, and the page cannot change
    // under a drag that is already in flight.
    const dims = pg;
    const pageId = dims.id;
    // The rotate handle writes `style.rotation`, which is not one of those five
    // and does not belong to a geometry record at all — `resize` would try to
    // set it on the box itself. So the rotation gesture records the style it
    // actually changed. Unrecorded, it would leave the next undo rewinding some
    // earlier edit instead, which is worse than having no undo for it.
    const styleBefore = isRot ? cloneStyle(box.style) : null;
    // Rotation changes no measurement, so the fit cannot move — but the entry
    // says so explicitly rather than leaving the history to re-derive a height
    // from whatever the box reads by the time it is walked back.
    const fitBefore = isRot ? { y: box.y, h: box.h } : null;
    const cx = () => box.x + box.w / 2;
    const cy = () => box.y + box.h / 2;

    const move = (ev) => {
      if (ev.pointerId !== pid) return; // see startMove
      if (isRot) {
        // The frame can be missing for a beat in a strip: the canvas binds one
        // element per page and hands each box its own, and a box that renders
        // before that binding has landed has nothing to measure the angle
        // against. Skipped rather than thrown from — the frame arrives a tick
        // later and the next move of the same drag finds it.
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
        // The pointer's travel, turned into the box's OWN frame before anything
        // is done with it. The handles are drawn on a rotated box but the
        // geometry underneath is not — `box.w/h/x/y` are axis-aligned in page
        // coordinates and `style.rotation` is a transform painted on top — so a
        // screen-space delta fed straight into them made the East handle of a
        // box rotated 90° widen it when the user was dragging downward along its
        // own edge. Rotating by -rotation is what makes every handle work along
        // the axis it is drawn on, at any angle; at rotation 0 the sin/cos
        // collapse to 0/1 and the arithmetic below is the arithmetic that was
        // here before, to the pixel.
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
        // The edge the user is NOT holding stays where it is on screen. On an
        // unrotated box that is the one-liner it always was — drag the west edge
        // and `x` follows it — but on a rotated one it is a statement about the
        // centre, because the centre is what the rotation turns around: growing
        // the box by g along its local x axis moves the centre by g/2 along that
        // same axis, and the opposite edge then lands exactly where it started.
        // The shift is computed in the box's frame and rotated back into page
        // coordinates, which at rotation 0 reduces to the old two lines exactly.
        const shiftX = hasE ? (nw - o.w) / 2 : hasW ? (o.w - nw) / 2 : 0;
        const shiftY = hasS ? (nh - o.h) / 2 : hasN ? (o.h - nh) / 2 : 0;
        const nx = o.x + o.w / 2 + (shiftX * cos + shiftY * sin) - nw / 2;
        const ny = o.y + o.h / 2 + (shiftY * cos - shiftX * sin) - nh / 2;
        box.w = nw; box.h = nh; box.x = nx; box.y = ny;
        // `o.h` is whatever the box carried, and `loadProjectPages` copies that
        // straight off disk with no floor under it — a chapter written by an
        // older build, or edited by hand, can hand this a box of height 0. The
        // ratio is then Infinity and one corner drag snaps the type to the 200
        // cap. No measured height, no scaling: the drag still resizes the box.
        if (corner && o.h > 0) box.style.size = clamp(Math.round(o.size * (nh / o.h)), 6, 200);
        // Live, inside the drag, so the user sees the height the text needs
        // while they are choosing the width. It costs no second undo step: the
        // `resize` record below is written from `box` after this has run, so its
        // `after` is exactly what is on screen and one press rewinds the whole
        // gesture. Grow-only means the drag is still deterministic — each frame
        // starts from `o.h`, so there is no ratchet.
        autoFitBox(box, dims);
        // The top handle is the one edge the fit fights, so it is the one edge
        // the drag takes back. `growToFit` anchors by `valign` — a middle- or
        // bottom-aligned box grows UPWARDS — and while the user is dragging the
        // top edge down, every line-wrap threshold crossed sent that edge back
        // up past the pointer and the box appeared to flinch. The drag owns the
        // edge it is holding; the fit only gets to decide how tall the box is.
        //
        // Only this handle. On a width drag the same upward growth is what keeps
        // a centred block centred on its bubble, and no edge under the pointer
        // moves, so nothing there needs correcting. Re-clamped into the page the
        // way `growToFit` clamps its own answer, so re-anchoring can never push
        // the box off the paper.
        if (hasN && box.y !== ny)
          box.y = dims.h > 0 ? clamp(ny, 0, Math.max(0, dims.h - box.h)) : ny;
      }
      markUnsaved();
    };
    // Same net as startMove: one controller, both endings, the record written
    // from the handler a cancelled gesture reaches too.
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

  // ⌘Z inside the editable, which the web view no longer does for us — see
  // field-undo.svelte.js. One per component instance, not per edit session: this
  // box outlives every edit made in it, so the stack does too. What keeps it
  // honest is `resyncField` in `focusSelect`, which throws the previous
  // session's steps away and re-seeds from the text the node is being seeded
  // with. Without that, ⌘Z in a second edit would walk back into the first —
  // restoring text from before an edit the editor history has its own record of.
  const fieldUndo = createFieldUndo();

  function focusSelect(node) {
    // Seed the editable content ONCE on mount so the node stays uncontrolled
    // while typing (its content is NOT derived from reactive state, so input
    // never re-renders the text node and the caret never resets to 0).
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
    sel(); // synchronous (works even when rAF is throttled)
    return {};
  }

  // `setBoxText` rather than `box.text = …`: a free-typed box's text lives on
  // its queue line, not on the box, and writing `box.text` here would put a
  // box-level override on top of the line the queue's textarea is still editing.
  // The two would then say different things about the same box for the rest of
  // the session. See `setBoxText` in the store for which field is which.
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
      // Claimed rather than left to bubble: App's window handler bows out while
      // `editingId` is set, but a browser build still has a native stack that
      // would otherwise undo the same keystroke a second time.
      e.preventDefault();
      const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
      if (next != null) restoreEdit(e.currentTarget, next); // "" is a step too
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  // Writing `textContent` collapses whatever structure WebKit built while the
  // user typed — a hard return leaves a <div> or a <br> behind — back to the
  // single text node the edit started as, which is also the only shape a caret
  // can be placed in by plain offset. The offset comes from the two strings
  // rather than from the DOM because a contenteditable's node/offset pairs do
  // not map onto `innerText` positions across a line break, and `box.text` is
  // kept in `innerText` terms.
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
    // The same two writes `onEditInput` makes, because that is what this is:
    // the store follows the node, and the one history record for the whole
    // session is still settled by whoever ends the edit.
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
    <!-- One element per computed line, with `white-space:pre` on each (see
         `.txt.shaped` in styles.css) so the browser cannot re-wrap a line we
         already measured and break it somewhere the exporter would not. The
         width still comes from the box, so an over-long unbreakable word hangs
         over the edge here exactly as it does in the export. -->
    <div class="txt shaped" style="{textStyle}{mirror ? `transform:${mirror};` : ''}">
      <!-- A zero-width space stands in for a blank line: an empty block has no
           line box at all and would collapse to nothing, while the exporter
           counts that paragraph as a line and the auto-height reserves room for
           it. U+200B has a line box and no advance, so it costs no width and
           does not shift a centred block. -->
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
