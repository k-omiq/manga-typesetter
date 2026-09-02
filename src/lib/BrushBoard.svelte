<script>
  // The board's canvas: a square of `BOARD_SIZE` page px, drawn with the page's
  // own painter so what is on it is what a placed box will show. The pointer
  // gesture lives here - draw or erase, per the armed mode - and every
  // change goes through `brush-board.svelte.js`, which owns the strokes and
  // their undo stack. This component owns pixels and pointers, nothing else.
  import { untrack } from 'svelte';
  import {
    board,
    BOARD_SIZE,
    addBoardStroke,
    beginBoardGesture,
    endBoardGesture,
    eraseBoardAt,
    undoBoard,
    redoBoard,
  } from './brush-board.svelte.js';
  import { brushTool } from './brush-tool.svelte.js';
  import { buildStroke } from './brush.js';
  import { drawInk } from './text-paint.js';
  import { inkTipIds, settleTips } from './brush-tips.js';

  // How many times the board is drawn over the frame's width. 1 fits.
  let { zoom = 1 } = $props();

  let frameEl = $state(null);
  let canvasEl = $state(null);
  let frameW = $state(0);
  // CSS px per board px.
  const k = $derived(frameW > 0 ? (frameW * zoom) / BOARD_SIZE : 0);
  const cssSize = $derived(Math.max(1, Math.round(BOARD_SIZE * k)));

  // The frame's width follows the panel's; the canvas follows the frame.
  $effect(() => {
    const el = frameEl;
    if (!el) return;
    const ro = new ResizeObserver(() => (frameW = el.clientWidth));
    ro.observe(el);
    frameW = el.clientWidth;
    return () => ro.disconnect();
  });

  // ---- painting -----------------------------------------------------------
  //
  // Committed strokes go into a cache canvas once per change; the visible
  // canvas is that cache plus the stroke under the pointer, which is the only
  // thing re-stamped per frame while drawing.
  const MAX_DEVICE = 4096;
  let cache = null;
  let cacheKey = '';
  let tips = null;
  // Two counters, deliberately: `tipReq` names the settle in flight so a stale
  // answer is dropped, and `tipVer` only moves when the tips in hand actually
  // changed - it is what the cache key reads, so asking the library again
  // (which happens on every repaint) does not by itself throw the cache away.
  let tipReq = 0;
  let tipVer = 0;
  let draft = $state(null);
  let raf = 0;

  function devicePx() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.min(MAX_DEVICE, Math.max(1, Math.round(cssSize * dpr)));
  }

  // The finish drawn around the committed strokes: the layer's own while one
  // is being edited, else the tool's - what a placed layer will get. Around
  // the cache only, never the stroke under the pointer: the outline is a
  // reading of the finished ink, and it moves out to take a stroke in when
  // the stroke is down.
  const finish = $derived(board.editing?.finish ?? brushTool.finish);
  const finishKey = $derived(JSON.stringify(finish));

  function paintCache(W) {
    if (!cache) cache = document.createElement('canvas');
    if (cache.width !== W) cache.width = W;
    if (cache.height !== W) cache.height = W;
    const ctx = cache.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    const s = W / BOARD_SIZE;
    ctx.scale(s, s);
    drawInk(ctx, { on: true, strokes: board.strokes }, undefined, tips, $state.snapshot(finish));
  }

  function paint() {
    raf = 0;
    const el = canvasEl;
    if (!el || !(cssSize > 1)) return;
    const W = devicePx();
    const key = `${board.rev}|${W}|${tipVer}|${finishKey}`;
    if (key !== cacheKey) {
      cacheKey = key;
      paintCache(W);
    }
    if (el.width !== W) el.width = W;
    if (el.height !== W) el.height = W;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    if (cache) ctx.drawImage(cache, 0, 0);
    const d = draft;
    if (d?.length) {
      const s = W / BOARD_SIZE;
      ctx.scale(s, s);
      const live = buildStroke($state.snapshot(d), $state.snapshot(brushTool.settings));
      if (live) drawInk(ctx, { on: true, strokes: [live] }, undefined, tips);
    }
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(paint);
  }

  // Repaint on anything visible changing, and re-ask for the tips - the
  // library may have dropped one between frames (its lifetime contract).
  // Not the draft: a live stroke repaints through `schedule()` from the
  // pointer, and it can only ever use the armed brush, which is tracked here.
  $effect(() => {
    void board.rev;
    void cssSize;
    void brushTool.settings.brush;
    void brushTool.mode;
    void finishKey;
    if (!canvasEl) return;
    untrack(() => {
      schedule();
      const ids = inkTipIds({ strokes: board.strokes });
      if (brushTool.mode === 'draw') inkTipIds({ strokes: [brushTool.settings] }, ids);
      if (!ids.size) {
        tipReq++;
        if (tips) {
          tips = null;
          tipVer++;
          schedule();
        }
        return;
      }
      const seq = ++tipReq;
      settleTips(ids).then(
        (map) => {
          if (seq !== tipReq || !canvasEl) return;
          let same = !!tips && tips.size === map.size;
          if (same) for (const [id, t] of map) if (tips.get(id) !== t) same = false;
          if (same) return;
          tips = map;
          tipVer++;
          schedule();
        },
        () => {},
      );
    });
  });

  // The pixels go back with the component, cache included: a board that is
  // not on screen must not be the last thing holding a decoded tip alive.
  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf);
    if (cache) {
      cache.width = 0;
      cache.height = 0;
      cache = null;
    }
    tips = null;
    tipReq++;
  });

  // ---- the pointer ----------------------------------------------------------

  const live = new Set();
  // Unmounted mid-drag - the tab switched, the tool disarmed - the gesture is
  // ended as a cancel, not merely unlistened: a bracket left open in the board
  // module would swallow the next undo.
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
    draft = null;
    endBoardGesture(false);
  });

  // A pointer event in board px.
  function at(ev) {
    const r = canvasEl.getBoundingClientRect();
    return [(ev.clientX - r.left) / k, (ev.clientY - r.top) / k];
  }

  let ring = $state(null);
  const mode = $derived(brushTool.mode ?? 'draw');
  const ringR = $derived(mode === 'erase' ? (brushTool.settings.size / 2) * k : 0);

  function onMove(e) {
    if (ringR > 0) ring = at(e);
  }
  function onLeave() {
    if (!live.size) ring = null;
  }

  function onDown(e) {
    // One pointer at a time. A second finger or a pen tapped mid-drag would
    // otherwise start a gesture on top of the one still running.
    if (e.button !== 0 || !(k > 0) || live.size) return;
    e.preventDefault();
    frameEl?.focus({ preventScroll: true });
    if (mode === 'erase') return eraseGesture(e);
    drawGesture(e);
  }

  function drawGesture(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const t0 = e.timeStamp;
    const sample = (ev) => {
      const [x, y] = at(ev);
      const pressure = ev.pressure ?? 0.5;
      brushTool.pen = { type: ev.pointerType || 'unknown', pressure };
      return { x, y, pressure, t: ev.timeStamp - t0 };
    };
    draft = [sample(e)];
    const ac = new AbortController();
    const move = (ev) => {
      if (ev.pointerId !== pid || !draft) return;
      const coalesced = ev.getCoalescedEvents?.();
      for (const one of coalesced?.length ? coalesced : [ev]) {
        const p = sample(one);
        const last = draft[draft.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) draft.push(p);
      }
      schedule();
    };
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const raw = draft;
      draft = null;
      if (!raw) return;
      const stroke = buildStroke($state.snapshot(raw), $state.snapshot(brushTool.settings));
      if (stroke) addBoardStroke(stroke);
      else schedule();
    };
    const cancel = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      draft = null;
      schedule();
    };
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel({ pointerId: pid });
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  // Erase: one gesture is one board step, however many strokes it touched,
  // and a cancelled one puts the board back as the pointer found it.
  function editGesture(e, step) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const ac = new AbortController();
    beginBoardGesture();
    let last = at(e);
    let lastT = e.timeStamp;
    ring = last;
    step(last, last, 1);
    const finish = (keep) => {
      live.delete(ac);
      ac.abort();
      endBoardGesture(keep);
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const p = at(ev);
      const dt = ev.timeStamp - lastT;
      lastT = ev.timeStamp;
      ring = p;
      step(p, last, Number.isFinite(dt) ? (dt > 0 ? dt / 16.7 : 0) : 1);
      last = p;
    };
    const up = (ev) => {
      if (ev.pointerId === pid) finish(true);
    };
    const cancel = (ev) => {
      if (ev.pointerId === pid) finish(false);
    };
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  function eraseGesture(e) {
    const r = brushTool.settings.size / 2;
    editGesture(e, ([x, y]) => eraseBoardAt(x, y, r));
  }

  // Undo and redo for the BOARD, not the document: while the board has focus
  // the shortcut is its own, and the press is stopped here so the app's window
  // handler cannot also rewind the page.
  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) redoBoard();
    else undoBoard();
  }

  // Ended from outside: the mode changed under a drag, or the panel closed.
  $effect(() => {
    void mode;
    untrack(() => {
      for (const ac of live) ac.abort();
      live.clear();
      if (draft) {
        draft = null;
        schedule();
      }
      endBoardGesture(false);
      ring = null;
    });
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="frame"
  class:draw={mode === 'draw'}
  class:tool={mode !== 'draw'}
  bind:this={frameEl}
  tabindex="0"
  role="img"
  aria-label="Brush board, {board.strokes.length} strokes"
  onkeydown={onKey}
>
  <div class="sheet" style="width:{cssSize}px;height:{cssSize}px">
    <canvas
      bind:this={canvasEl}
      style="width:{cssSize}px;height:{cssSize}px"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerenter={onMove}
      onpointerleave={onLeave}
    ></canvas>
    {#if ring && ringR > 0}
      <div class="ring" style="left:{ring[0] * k}px;top:{ring[1] * k}px;width:{ringR * 2}px;height:{ringR * 2}px" aria-hidden="true"></div>
    {/if}
  </div>
</div>

<style>
  /* Square, the panel's width, scrolling once zoomed past it. Paper in both
     themes: the board is ink on paper, exactly like a tip cell. */
  .frame {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: auto;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--paper);
    touch-action: none;
    outline: none;
  }
  .frame:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .sheet {
    position: relative;
  }
  canvas {
    display: block;
    cursor: crosshair;
  }
  .frame.tool canvas {
    cursor: none;
  }
  .ring {
    position: absolute;
    transform: translate(-50%, -50%);
    border: 1px solid var(--tintline);
    border-radius: 50%;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6);
  }
</style>
