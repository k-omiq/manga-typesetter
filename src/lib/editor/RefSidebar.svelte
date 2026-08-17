<script>
  // The raw page, parked down the left edge as the thing you typeset against.
  // Derived from the old RawPanel: same zoom behaviour, minus the panel header
  // the wireframe does away with — a bare image column with a floating zoom
  // pill over its bottom edge, the same pill chrome as the canvas dock.
  // The width is the rail's business (it is the drag handle); this file only
  // reads it, and whether the sidebar is on screen at all is EditorRoot's `if`.
  //
  // In a longstrip chapter "the raw page" is not one page: the canvas is showing
  // the whole chapter as one column, so the reference is the same chapter's raws
  // as another column beside it, scrolling in step. See strip-sync.svelte.js for
  // why the canvas leads and this follows.
  import { app, page, isLongstrip, rawZoomIn, rawZoomOut, rawZoomBy } from '../store.svelte.js';
  import { stripScroll } from './strip-sync.svelte.js';
  import { scrollTopForFraction } from './strip.js';

  const strip = $derived(isLongstrip());
  const rawWidth = $derived(app.rawZoom === 0 ? '100%' : 100 * app.rawZoom + '%');
  const rawLabel = $derived(app.rawZoom === 0 ? 'Fit' : Math.round(app.rawZoom * 100) + '%');

  // `$state` because the effect below reads it: the sidebar is mounted and
  // unmounted by EditorRoot (hidden, or a translate chapter), and a remount has
  // to pull the fresh element back into step with the canvas without waiting for
  // the next scroll.
  let scrollEl = $state(null);

  // The strip's height must not change when a raw is minted or revoked — the
  // resident window is only a handful of pages, so most of this column is
  // placeholders at any moment, and a placeholder that sized itself differently
  // from the picture that replaces it would move everything below it under the
  // reader. `aspect-ratio` is what makes that possible without knowing the
  // column's pixel width: the page's own proportions, at whatever width the
  // zoom resolves to. A page whose art has never been decoded has no
  // proportions to offer and takes the ratio of an ordinary page.
  const ratioOf = (p) => (p?.w > 0 && p?.h > 0 ? `${p.w} / ${p.h}` : '2 / 3');

  // Every slot's proportions, as one string, purely so the effect below can
  // depend on them. A fraction is only a position once the column's height is
  // known, and this column's height is the sum of the `aspect-ratio`s above:
  // each page that gets measured for the first time — which in a chapter of tall
  // webtoon slices is a large change, `2 / 3` becoming `800 / 6000` — moves
  // everything below it and leaves the sidebar showing a different part of the
  // chapter from the canvas until the reader scrolls the canvas again.
  const ratios = $derived(strip ? app.pages.map((p) => ratioOf(p)).join(',') : '');

  // Slaved to the canvas. Keyed on `seq` rather than on the fraction so a
  // sidebar the reader has scrolled by hand is pulled back into step by the next
  // canvas scroll even when the canvas has not moved — and so that nothing here
  // writes back, which is what keeps the traffic one-way and free of echoes.
  //
  // And on `ratios`, so a decode that changes this column's scroll height
  // re-applies the fraction it was already at rather than waiting for the next
  // canvas scroll to say the same thing. Re-applying the same fraction to an
  // unchanged column is a write of the value already there, which is why this
  // needs no guard of its own.
  $effect(() => {
    stripScroll.seq;
    ratios;
    if (!strip || !scrollEl) return;
    scrollEl.scrollTop = scrollTopForFraction(stripScroll.fraction, scrollEl);
  });

  // Zoom on the column itself, so reading a raw does not mean travelling to the
  // two buttons at its foot for every step. A plain wheel still scrolls the
  // column — that is the gesture for moving down a page and it is not taken
  // away. Only ctrl/cmd+wheel zooms, which is also what WebKit delivers for a
  // trackpad pinch: a pinch arrives as a wheel event with `ctrlKey` set and no
  // key held, so honouring the modifier is what makes the pinch work.
  //
  // Continuous rather than the buttons' fixed step, because it has to answer a
  // gesture that arrives as a stream of small deltas — one `rawZoomIn` per event
  // would cross the whole range in a flick. `exp` keeps it geometric like the
  // buttons, so the same travel is the same ratio wherever the zoom starts, and
  // the 0.3 floor and the ceiling are `rawZoomBy`'s.
  //
  // `passive: false` is what `onwheel` gives here (Svelte does not mark wheel
  // handlers passive), and the preventDefault matters: without it the column
  // scrolls at the same time as it zooms, and the browser may also take the
  // gesture as a page-level pinch-zoom of the whole app.
  const ZOOM_PER_PX = 0.0035;
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return; // an ordinary wheel is an ordinary scroll
    e.preventDefault();
    rawZoomBy(Math.exp(-e.deltaY * ZOOM_PER_PX));
  }
</script>

<aside class="ed-side" style="width:{app.leftWidth}px">
  {#if strip}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ed-side-scroll" bind:this={scrollEl} onwheel={onWheel}>
      <!-- Zero gap, exactly like the canvas's column and for the same reason:
           these are slices of one continuous drawing. -->
      <div class="ed-side-strip">
        {#each app.pages as pg (pg.id)}
          {#if pg.raw}
            <img src={pg.raw} alt="Raw page" style="width:{rawWidth}; aspect-ratio:{ratioOf(pg)}" />
          {:else}
            <div class="ed-side-slot" style="width:{rawWidth}; aspect-ratio:{ratioOf(pg)}"></div>
          {/if}
        {/each}
      </div>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ed-side-scroll" class:empty={!page().raw} onwheel={onWheel}>
      {#if page().raw}
        <img src={page().raw} alt="Raw page" style="width:{rawWidth}" />
      {:else}
        <div class="ed-side-empty">No raw reference.<br />Import Raw to load it here.</div>
      {/if}
    </div>
  {/if}
  <div class="ed-side-zoom">
    <button onclick={rawZoomOut} aria-label="Zoom reference out">−</button>
    <span class="zval">{rawLabel}</span>
    <button onclick={rawZoomIn} aria-label="Zoom reference in">+</button>
  </div>
</aside>
