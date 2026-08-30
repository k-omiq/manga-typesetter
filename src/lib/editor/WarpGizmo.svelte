<script>
  // ===== The free-transform gizmo =====
  //
  // The handles of the mesh warp, over the selected box: a dot at every control
  // point, the hairline mesh between them, and the box's original outline as a
  // dashed ghost so the deformation can be read against where it started.
  //
  // It is a child of the box element, like the path gizmo and the mask overlay,
  // and for the same three reasons: the box's `left`/`top` places it, the box's
  // `transform: rotate()` rotates it (so a handle on a tilted box sits on the
  // corner it belongs to, with no rotation maths here at all), and being outside
  // the clip wrapper means the mask cannot hide the controls.
  //
  // What a drag costs is the one thing this file does differently from the
  // others. A warped box is not DOM text - it is a picture the exporter paints -
  // and repainting that picture per pointermove means re-rendering the type, the
  // ink, the blur, the smear and the mask forty times a second for a gesture
  // that changes none of them. So the texture is rendered ONCE, on pointerdown,
  // and every frame after that re-runs only the mesh over it. That is the
  // `painter` prop: `begin` caches, `frame` warps the cache, `end` releases it
  // and hands the box back to its own reactive repaint.
  import {
    HANDLE_R,
    handlePoints,
    meshSegments,
    ghostOutline,
    beginWarpDrag,
    dragWarpTo,
    cancelWarpDrag,
    commitWarpDrag,
    resetWarp,
  } from '../warp-gizmo.js';

  // `toLocal` turns a pointer event into box-local page px - the box's own
  // frame, rotation undone. The box owns that conversion (its mask tool needs
  // the identical one), so it is passed in rather than worked out twice.
  let { box, pageId, z, toLocal, painter = null } = $props();

  const s = $derived(box.style);
  const pts = $derived(handlePoints(s.warp, box.w, box.h));
  const segs = $derived(meshSegments(s.warp, box.w, box.h));
  const ghost = $derived(ghostOutline(box.w, box.h));
  // Nothing to reset until something has been dragged. The empty array is the
  // stored form of "never touched" (see data.js), so this is exactly that test.
  const dirty = $derived(Array.isArray(s.warp.pts) && s.warp.pts.length > 0);

  // Which handle is under the pointer, for the highlight. -1 is none.
  let held = $state(-1);

  // Gestures in flight, aborted if the box goes away underneath one.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onHandleDown(e, i) {
    if (e.button !== 0) return;
    // Both, and both matter: `preventDefault` keeps the pointer from starting a
    // text selection across the page, and `stopPropagation` is what stops the
    // box's own pointerdown from reading this as "move the box". The box's
    // resize handles are not mounted at all while the gizmo is up (see
    // TextBox.svelte), so a corner handle of a 1x1 mesh - which sits exactly
    // where the resize corner would - has nothing to contend with.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;

    const before = beginWarpDrag(box);
    // The grab offset: the pointer rarely lands on the handle's exact centre,
    // and without this the point jumps to the cursor on the first move.
    const start = toLocal(e);
    const p0 = box.style.warp.pts[i] ?? [start[0], start[1]];
    const gx = p0[0] - start[0];
    const gy = p0[1] - start[1];

    held = i;
    painter?.begin();

    const ac = new AbortController();
    let done = false;
    const finish = (cancelled) => {
      if (done) return;
      done = true;
      live.delete(ac);
      ac.abort();
      held = -1;
      if (cancelled) cancelWarpDrag(box, before);
      else commitWarpDrag(box, pageId, before);
      // After the document is final, never before: the authoritative repaint
      // this releases the cache into has to draw the mesh that was committed.
      painter?.end();
    };

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const [x, y] = toLocal(ev);
      dragWarpTo(box, i, x + gx, y + gy);
      painter?.frame();
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      finish(false);
    };
    const cancel = (ev) => {
      if (ev.pointerId !== pid) return;
      finish(true);
    };
    // Escape puts the mesh back exactly as the pointer found it. Capture phase
    // on the document, so it is answered before the window's own shortcut
    // handler can read the same press as "deselect", and stopped there.
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };

    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }
</script>

<!-- Hairlines and ghost first, handles last: the dots are the pointer targets
     and must be the topmost thing in the overlay. `overflow: visible` because a
     dragged handle is routinely outside the box rect - that is the feature. -->
<svg
  class="warp-gizmo"
  width={box.w * z}
  height={box.h * z}
  aria-hidden="true"
  data-warp-gizmo={box.id}
>
  <polygon class="ghost" points={ghost.map(([x, y]) => `${x * z},${y * z}`).join(' ')} />
  {#each segs as [x1, y1, x2, y2], i (i)}
    <line class="mesh" x1={x1 * z} y1={y1 * z} x2={x2 * z} y2={y2 * z} />
  {/each}
  {#each pts as p (p.i)}
    <circle
      class="wh"
      class:held={held === p.i}
      data-warp-handle={p.i}
      cx={p.x * z}
      cy={p.y * z}
      r={HANDLE_R}
      onpointerdown={(e) => onHandleDown(e, p.i)}
    />
  {/each}
</svg>

{#if dirty}
  <!-- Reset is on the gizmo as well as in the panel, because the panel may be
       anywhere on screen and the thing being reset is here. Above the box's
       top-left, outside the mesh, so it never sits under a handle. -->
  <button
    type="button"
    class="warp-reset"
    title="Reset the mesh to the box's own outline"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      resetWarp(box, pageId);
    }}>Reset</button
  >
{/if}

<style>
  /* Same shape as the path gizmo: the svg lets clicks through to the box and
     only the handles take the pointer. z-index 4 puts it over the brush's
     capture surface (3), so an armed brush cannot swallow a handle. */
  .warp-gizmo {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 4;
  }
  /* The original outline. Dashed and thin - it is a reference, not a control -
     and `vector-effect` keeps it one device pixel at every zoom. */
  .ghost {
    fill: none;
    stroke: #888;
    stroke-width: 1;
    stroke-dasharray: 5 4;
    vector-effect: non-scaling-stroke;
  }
  .mesh {
    stroke: #00d5e0;
    stroke-width: 1;
    opacity: 0.75;
    vector-effect: non-scaling-stroke;
  }
  .wh {
    fill: #fff;
    stroke: #00a8b0;
    stroke-width: 1.5;
    pointer-events: all;
    cursor: grab;
  }
  .wh.held {
    fill: #00d5e0;
    cursor: grabbing;
  }
  .warp-reset {
    position: absolute;
    left: 0;
    top: -24px;
    z-index: 4;
    padding: 2px 8px;
    font: 500 11px/1.4 var(--ui-font, system-ui, sans-serif);
    color: #fff;
    background: #00a8b0;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .warp-reset:hover {
    background: #00c2cc;
  }
</style>
