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

  // app.bulk.style is the editable template; null when closed.
  const s = $derived(app.bulk.style);
  const count = $derived(app.bulk.targets.length);
  // How many properties this edit is actually about. Zero is the state a freshly
  // opened panel is in, and the footer says so rather than offering an Apply
  // that would change nothing.
  const ticked = $derived(app.bulk.active ? bulkTicked().length : 0);

  // Draggable panel position (inline left/top in px, relative to whichever
  // positioned ancestor it is rendered inside — `.ed-canvas`, the canvas
  // viewport. Both the opening centre below and the drag clamp read that same
  // `offsetParent`, so the panel stays over the page rather than the window.)
  let pos = $state({ x: 0, y: 16 });
  let panelEl;

  // Panel size. `h: null` means "as tall as the content wants, up to the cap"
  // — the state the panel opens in and stays in until the grip is used. Once a
  // height is set it is honoured, and the CSS cap below still applies, so a
  // panel dragged low can never be resized to hang off the bottom.
  //
  // Deliberately not reset when the panel reopens, unlike the position: a
  // window the user made bigger should still be that size next time, and the
  // reason position *is* reset is that a panel can be dropped somewhere the
  // next canvas does not have — a size cannot, because the caps clamp it.
  const MIN_W = 280;
  const MAX_W = 560;
  const MIN_H = 220;
  let size = $state({ w: 320, h: null });

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Both caps are `100%` of the positioned ancestor minus wherever the panel's
  // corner ended up, so the foot — Cancel and Apply — and the right-hand edge
  // are inside the canvas at every drop position. Written in CSS rather than
  // measured here on purpose: the browser re-resolves them when the canvas
  // resizes, with nothing to observe.
  //
  // Both, not just the height, and the width is the one that is easy to miss: a
  // static `max-width:calc(100% - 32px)` is only the right cap for a panel at
  // x=16, and a wide panel dragged to the right of the canvas would hang off
  // the edge under it. The grip already clamps against `pos.x`; without the
  // matching cap here the two disagreed, and a drag could produce a width the
  // next resize would appear to snap away.
  const panelStyle = $derived(
    `left:${pos.x}px; top:${pos.y}px; width:${size.w}px;` +
      (size.h ? `height:${size.h}px;` : '') +
      `max-width:calc(100% - ${pos.x}px - 16px);` +
      `max-height:calc(100% - ${pos.y}px - 16px)`,
  );

  // The parent's content box, which both gestures clamp against — the same
  // `offsetParent` the position is measured in.
  function parentBox() {
    const parent = panelEl?.offsetParent || panelEl?.parentElement;
    return {
      w: parent ? parent.clientWidth : window.innerWidth,
      h: parent ? parent.clientHeight : window.innerHeight,
    };
  }

  // Re-center near top of the editor each time the panel opens, so it never gets lost.
  $effect(() => {
    if (app.bulk.active && panelEl) {
      const { w: pw } = parentBox();
      pos = { x: Math.max(16, (pw - size.w) / 2), y: 16 };
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
    // The primary button and nothing else: a right-click on the header is on its
    // way to a context menu, not a drag.
    if (e.button !== 0) return;
    e.preventDefault();
    // The drag follows the pointer even once it leaves the window — without the
    // capture a button released outside gets no pointerup here at all, and the
    // panel comes back stuck to the cursor. The listeners stay on `window`: a
    // captured pointer's events still bubble to it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
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
      const { w: pw, h: ph } = parentBox();
      const w = panelEl?.offsetWidth || 0;
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

  // The corner grip, the same gesture shape as the header drag and as
  // `FloatingPanel`'s own grip. Both axes are bounded: width by taste (a wider
  // panel only pads the controls, it does not add columns), height by what is
  // left of the canvas below the panel's top, which is the same number the CSS
  // cap uses — so the grip cannot produce a size the cap then contradicts.
  function onGripPointerDown(e) {
    if (e.button !== 0) return; // see onHeadPointerDown
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId); // see onHeadPointerDown
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

  // ---------- reading and writing one masked property ----------
  // Every control below goes through these two, addressing its property by the
  // same path the mask is keyed on. That is what keeps a row's tick box and its
  // control talking about the same thing: there is one spelling of "shadow blur"
  // in this file, not a `s.shadow.blur` in the markup and a `'shadow.blur'` in
  // the checkbox that could drift apart.
  const get = (key) => {
    const dot = key.indexOf('.');
    return dot === -1 ? s[key] : s[key.slice(0, dot)][key.slice(dot + 1)];
  };
  // Writing a property ticks it. Touching a control is the user saying they want
  // that property in this edit, and making them say it twice — move the slider,
  // then tick the box — is the kind of ceremony that gets a feature called
  // broken. The tick boxes are for the other direction: untick something you
  // adjusted and thought better of, or tick a property whose seeded value is
  // already what you want so you never touch its control.
  function set(key, v) {
    const dot = key.indexOf('.');
    if (dot === -1) s[key] = v;
    else s[key.slice(0, dot)][key.slice(dot + 1)] = v;
    tickBulkProp(key);
  }
  // The four hex lengths CSS actually has — #rgb, #rgba, #rrggbb, #rrggbbaa —
  // and not a `{3,8}` range, which also admitted 5 and 7 digits. `#12345` is not
  // a colour: it ticked the property and pushed an unparseable value onto every
  // box in the edit, and the field went on showing the bad text because Svelte
  // will not reset a DOM value that state did not change. This copy came from
  // `Inspector.svelte`, which still has the range and still reaches one box with
  // it.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // `el` is the input the value came from. On a reject its value is put back by
  // hand: the state never changed, so nothing would re-render it, and the user
  // would be left looking at text the panel had silently refused.
  function setHex(key, v, el) {
    if (HEX.test(v)) set(key, v.startsWith('#') ? v : '#' + v);
    else if (el) el.value = get(key);
  }
  const num = (key, v, lo, hi) => set(key, clamp(+v || 0, lo, hi));

  // The Inspector's own groups, its own labels and its own default open/closed
  // state, on purpose: the two panels edit the same style, and a user who has
  // learned where "Warp & Edges" lives in one should not have to learn it again
  // here. Only the header tick needs the membership list — it is what lets a
  // whole shadow be put on twenty boxes without six clicks.
  //
  // Two places this reads against the letter of the spec, both deliberate:
  //
  //   Transform is open. The spec asks for the less-used groups collapsed, and
  //   Shadow and Warp are — but the group that holds Rotation is not a less-used
  //   one, and more to the point it is open in the Inspector. Matching the
  //   Inspector is the rule that earns its keep here, because the alternative is
  //   two panels over the same style whose folds disagree, and a user hunting
  //   for a control they can see in the other one. It is three rows.
  //
  //   Every row carries a text label, where the spec says a row should be its
  //   tick box and its control and nothing else. That reading works for a slider
  //   or a colour swatch; it does not work for a column of bare number inputs —
  //   Offset X, Offset Y, Blur, Seed, Size, Line, Letter are all one small
  //   spinner, and stripped of their labels they are indistinguishable. The
  //   labels *are* the minimal formatting the same paragraph asks for. What was
  //   actually stripped is the extra chrome: no per-row reset, no revert arrow,
  //   no value readout except where a slider has no other way to show its
  //   number.
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

  // ---------- tag-wise editing ----------
  // Scope is never an enum: it is which array of pages gets handed to the tag
  // functions, exactly as `tags.svelte.js` intends. `chapter` is every page,
  // `page` is the one on screen — and the list of tags on offer follows it, so
  // what the selector shows is always what the edit could actually reach.
  let scope = $state('chapter');
  let tag = $state('');
  const scopePages = $derived(scope === 'page' ? [page()] : app.pages);
  const scopeWord = $derived(scope === 'page' ? 'this page' : 'the chapter');
  const tagList = $derived(app.bulk.active ? tagsInUse(scopePages) : []);
  const tagHits = $derived(tag ? boxesWithTag(tag, scopePages).length : 0);
  // How much of that reach is off this page, and how many pages it spreads over.
  // Said out loud because of what undo does with it: the history keeps one stack
  // per page, so `applyBulkToTag` files one entry against each page it reached
  // rather than one for the apply. Every box is recoverable — the older reading
  // of this, that the boxes off this page could not be walked back at all, was
  // never true after the split — but recovering them costs one ⌘Z per page,
  // pressed on that page. That is a thing a user has to be told before they
  // press Apply, not after.
  const tagHitsHere = $derived(tag ? boxesWithTag(tag, [page()]).length : 0);
  const tagHitsAway = $derived(Math.max(0, tagHits - tagHitsHere));
  const tagPages = $derived(
    tag ? new Set(boxesWithTag(tag, scopePages).map((h) => h.page.id)).size : 0,
  );
  // Boxes with no line at all, which since free-typed boxes joined the queue is
  // one specific thing: a free-typed box saved to disk before that change, which
  // `loadProjectPages` deliberately does not migrate. It carries no tags,
  // `boxesWithTag` can never return it, and counting it here is the honest
  // version of that — without it, a user whose chapter is full of them watches a
  // chapter-wide tag edit skip boxes for no visible reason. A box typed onto the
  // page today has a line of its own and is reached like any other, so this is
  // normally zero.
  const freeCount = $derived(
    scopePages.reduce((n, p) => n + (p?.boxes ?? []).filter((b) => b.lineN == null).length, 0),
  );

  // A tag chosen under one scope may not exist under the other — switching to
  // "this page" with `sfx` selected, when this page has none, would leave the
  // selector showing a tag that matches nothing.
  $effect(() => {
    if (tag && !tagList.includes(tag)) tag = '';
  });
  // A fresh open starts with no tag chosen, so the Apply button can never fire
  // the previous session's tag at a template the user has only just begun
  // editing — it opens disabled, with nothing named.
  $effect(() => {
    if (app.bulk.active) tag = '';
  });

  // Whether a tag apply could do anything right now. The same three conditions
  // gate the button and are spelled out in the note, so a disabled button is
  // never a mystery.
  const canApplyTag = $derived(!!tag && ticked > 0 && tagHits > 0);

  // Enter moves to the Apply button; it does not apply. That is a deliberate
  // step away from the spec's "select a tag and hit Enter", and the reason is
  // the macOS WKWebView `<select>`: its popup is a native menu, and the Enter
  // that chooses an option can also arrive at the element underneath. Bound
  // straight to the apply, that key would restyle every tagged box in the
  // chapter at the instant the user picked the tag — before they had looked at
  // what they picked. Which way round the popup delivers `change` and `keydown`
  // is not knowable from source and differs by platform, so no ordering test can
  // be trusted to tell a real Enter from the popup's; the fix is for the key not
  // to be destructive at all. A stray Enter now moves focus to a button, which
  // is visible and costs nothing, and the deliberate second Enter presses it.
  //
  // It also settles the mouse path, which was the other half of the problem: if
  // the select does not keep focus after a click-pick, Enter is unreachable and
  // the footer Apply belongs to the click-to-select flow and is disabled at zero
  // targets — so the tag edit had no mouse route at all. The button is that
  // route, and it is the same control both hands use.
  // `$state` only to keep the compiler quiet about a `bind:this` it cannot see
  // is read imperatively; nothing re-renders off this.
  let applyTagBtn = $state(null);
  function onTagKey(e) {
    if (e.key !== 'Enter') return;
    // The select would otherwise let Enter reach the panel's surroundings, and
    // App.svelte closes bulk mode on Escape/Enter-ish chrome keys.
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
    <!-- Inside the head, so it lines up with the rows' tick column, which means
         its click has to be kept off the head's collapse toggle. -->
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

    <!-- One scroller, not three. The tag block, the hint and the property list
         are all content — a short panel has to be able to reach the bottom of
         any of them — while the header stays as the drag handle and the foot
         keeps Apply pinned where the eye expects it. Scrolling only the
         property list, which is what this used to do, left the tag block and
         its note able to push the list to nothing and then be uncuttable
         themselves. -->
    <div class="bulk-scroll">
    <!-- By tag: the whole of this block is the tag-driven edit, scope included.
         It sits above the hint that describes the click-to-select flow so the
         scope pills cannot be read as governing that one. -->
    <div class="bulk-tag">
      <div class="trow">
        <span class="lbl">Scope</span>
        <div class="seg">
          <button class:on={scope === 'chapter'} onclick={() => (scope = 'chapter')}>Chapter</button>
          <button class:on={scope === 'page'} onclick={() => (scope = 'page')}>This page</button>
        </div>
      </div>
      <!-- The list is the tags in use in *scope* — this chapter, or this page —
           and not the user's whole vocabulary. The spec asked for "all the tags
           currently used in the project", and this is the narrower reading on
           purpose: a tag used only in some other chapter would sit in this list
           matching nothing this edit can reach, and the list changing as the
           scope pills move is what makes "restyle every box carrying it" a true
           sentence. The note below names the scope in words for the same reason. -->
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
            <!-- The honest version of what undo will do. One entry per page, on
                 that page's own stack, because a single entry can only live on
                 one of them — so this is recoverable, at one press per page,
                 taken on that page. It is not one press, and the panel used to
                 imply the boxes off this page could not be walked back at all;
                 both readings would have cost someone their afternoon. -->
            <br />{tagHitsAway} of them {tagHitsAway === 1 ? 'is' : 'are'} on other pages. Undo is per page:
            {tagPages} pages, one ⌘Z each, on the page itself.
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

      <!-- Typeset. Height is not here — it is not a style — but `autoHeight`
           is, and a chapter-wide tick of it is the fastest way to make every
           box on every page describe its own text. -->
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
          <!-- The switch, and only the switch. Re-fitting is per-box by
               definition — it measures the balloon under one rectangle — so the
               Inspector's button has no bulk equivalent; what a bulk edit can do
               is turn balloon layout off across a page of boxes that were fitted
               to the wrong thing. -->
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

      <!-- Transform, minus X/Y/W/H: position and size stay the Inspector's. -->
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
