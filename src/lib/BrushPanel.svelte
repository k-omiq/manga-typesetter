<script>
  // The brush tool's panel. It replaces the Inspector's body while the brush is
  // armed, the way CSP's Tool Property replaces itself per tool: what is on
  // screen is the options for what you are doing, not for what is selected.
  //
  // Collapsible sections rather than sub-tabs. Fourteen controls that are mostly
  // set once do not want tab-hunting, and four tabs truncated to "DYNA..." at
  // the panel's width - see the spec for the discarded attempt.
  import { brushTool } from './brush-tool.svelte.js';
  import { DYN_SOURCES } from './brush.js';
  import { drawInk } from './text-paint.js';
  import {
    BUILTIN_BRUSH,
    brushLibrary,
    brushTip,
    importBrushes,
    installedBrushes,
    loadBrushLibrary,
    removeBrush,
    resolveBrush,
  } from './brush-library.svelte.js';
  import { settleTips } from './brush-tips.js';
  import { filterBrushes, importSentence, pickedSettings, tipDims } from './brush-picker.js';
  import { isTauri } from './importer.js';
  import { toast } from './store.svelte.js';

  const s = $derived(brushTool.settings);

  // The library is app-wide and loaded once. Idempotent, so a panel opened and
  // closed all afternoon costs one read - and it has to happen here, because a
  // letterer can open this panel before any chapter has asked for a tip.
  loadBrushLibrary();

  // Which sections are open. Session state on the module would outlive the
  // panel; per-instance is right, because closing the panel is closing the tool.
  let open = $state({ shape: false, dyn: false, fix: false });

  // ---- the picker -------------------------------------------------------

  // The round tip stands in the grid as a brush like any other, and always
  // first: it is the one tip that is always there, and it is how a letterer
  // gets back to a plain pen after trying an imported one.
  const ROUND = { id: BUILTIN_BRUSH, name: 'Round', builtin: true };

  let query = $state('');
  let importing = $state(false);
  // Removal is two-step, the way the Inspector's preset delete is: the first
  // press arms it and the arming wears off on its own, so a parked click on a
  // panel nobody is looking at cannot uninstall a brush.
  let rmArm = $state('');
  let rmArmT;

  const shown = $derived(filterBrushes([ROUND, ...installedBrushes], query));
  // What `s.brush` means right now: an installed entry, the round tip, or a
  // brush this install does not have. The last one is why the row under the
  // grid can say `missing` - removing the brush you are drawing with does not
  // silently rewrite the tool, it says what happened.
  const current = $derived(resolveBrush(s.brush));
  const currentName = $derived(
    current.name ?? (current.missing ? `Missing brush ${current.id.slice(0, 6)}` : ROUND.name),
  );

  function armRemove(id) {
    rmArm = id;
    clearTimeout(rmArmT);
    rmArmT = setTimeout(() => (rmArm = ''), 2500);
  }
  function disarmRemove() {
    rmArm = '';
    clearTimeout(rmArmT);
  }
  $effect(() => () => clearTimeout(rmArmT));

  // The 2.3 selection contract, in one line - see `pickedSettings`.
  //
  // Snapshots rather than the live proxies: an entry's `settings` belong to the
  // installed library, and spreading the proxy would hand the tool the SAME
  // nested `taperIn` object the library row holds - a taper dragged in the
  // panel afterwards would rewrite the brush's own stored settings the next
  // time the index was written.
  function pick(entry) {
    disarmRemove();
    brushTool.settings = pickedSettings(
      $state.snapshot(brushTool.settings),
      $state.snapshot(entry),
    );
  }

  async function onRemove(entry) {
    if (rmArm !== entry.id) {
      armRemove(entry.id);
      return;
    }
    disarmRemove();
    toast((await removeBrush(entry.id)) ? 'Brush removed' : 'That brush could not be removed');
  }

  async function onImport() {
    if (importing) return;
    if (brushLibrary.readOnly) {
      toast(brushLibrary.error);
      return;
    }
    if (!isTauri()) {
      toast('Importing brushes needs the desktop app');
      return;
    }
    importing = true;
    try {
      const { open: pickFiles } = await import('@tauri-apps/plugin-dialog');
      const picked = await pickFiles({
        multiple: true,
        filters: [{ name: 'Clip Studio brush', extensions: ['sut'] }],
      });
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (!paths.length) return;
      toast(importSentence(await importBrushes(paths)));
    } catch (e) {
      toast(`Couldn't import brushes: ${e?.message ?? e}`);
    } finally {
      importing = false;
    }
  }

  // ---- the tip cells ----------------------------------------------------

  // The backing size of one cell's canvas, in CSS px. The grid's cells are
  // about 64 px wide at the panel's default width and stretch with it; the
  // canvas is drawn at this size and scaled by CSS, which is what every other
  // thumbnail in this app does.
  const CELL = 64;
  // Ink, not the stroke colour: the cell is a tip on paper, and a white brush
  // painted on white paper would show an empty square.
  const INK = [34, 33, 30];

  // A tip PNG is 8-bit greyscale with the ink at 255 and an opaque alpha, which
  // is white-on-white until it is turned into coverage. Same transform the
  // painter's `buildTinted` runs, at cell size.
  function inkify(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const cov = (d[i] * d[i + 3]) / 255;
      d[i] = INK[0];
      d[i + 1] = INK[1];
      d[i + 2] = INK[2];
      d[i + 3] = cov;
    }
    ctx.putImageData(px, 0, 0);
  }

  async function paintCell(node, id, gone) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(CELL * dpr));
    node.width = W;
    node.height = W;
    const ctx = node.getContext('2d');
    if (!ctx) return;
    if (id === BUILTIN_BRUSH) {
      ctx.fillStyle = `rgb(${INK[0]},${INK[1]},${INK[2]})`;
      ctx.beginPath();
      ctx.arc(W / 2, W / 2, W * 0.3, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // One frame's worth of tip - see THE TIP LIFETIME CONTRACT. It is read,
    // drawn, and let go of; the cache decides how long the bitmap itself lives.
    const tip = await brushTip(id);
    // A cell that has since been scrolled out of the grid, or a panel that has
    // closed: its canvas has already given its pixels back.
    if (gone() || !tip?.image) return;
    const iw = Number(tip.image.width) || tip.width;
    const ih = Number(tip.image.height) || tip.height;
    if (!(iw > 0 && ih > 0)) return;
    const pad = Math.round(3 * dpr);
    const k = Math.min((W - pad * 2) / iw, (W - pad * 2) / ih);
    const w = Math.max(1, Math.round(iw * k));
    const h = Math.max(1, Math.round(ih * k));
    // Down to cell size first, then converted: the conversion is a pass over
    // every pixel, and the corpus's biggest tip is 27 megapixels.
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    try {
      const sctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!sctx) return;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(tip.image, 0, 0, w, h);
      inkify(sctx, w, h);
      if (gone()) return;
      ctx.drawImage(scratch, Math.round((W - w) / 2), Math.round((W - h) / 2));
    } catch {
      /* a tip that will not decode leaves an empty cell; the name still names it */
    } finally {
      scratch.width = 0;
      scratch.height = 0;
    }
  }

  // Keyed by brush id in the grid, so a cell's node never changes brush: create
  // and destroy is the whole lifetime. Destroy hands the pixels back, because a
  // library of a hundred brushes is a hundred canvases.
  function tipCell(node, id) {
    let dead = false;
    paintCell(node, id, () => dead).catch(() => {});
    return {
      destroy() {
        dead = true;
        node.width = 0;
        node.height = 0;
      },
    };
  }

  // ---- the live preview -------------------------------------------------

  // The preview: one sample stroke drawn with the live settings, by the painter
  // that draws the real thing. A number on a slider does not tell a letterer
  // what a taper does; this does.
  let prevEl = $state(null);
  // The decoded tip the preview is drawing with, and the token that says which
  // settle is still the current one. Plain `let`, not `$state`: the effect
  // below writes them and must not re-run because it did.
  let prevTips = null;
  let prevSeq = 0;
  const PREV_W = 288;
  const PREV_H = 46;
  const sample = [
    [10, 31, 1], [52, 14, 1], [96, 34, 1], [140, 20, 1], [196, 12, 1], [278, 27, 1],
  ];

  function paintPreview(el, tips) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = PREV_W * dpr;
    el.height = PREV_H * dpr;
    const ctx = el.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PREV_W, PREV_H);
    drawInk(ctx, {
      on: true,
      strokes: [{
        brush: s.brush, size: Math.min(s.size, 26), color: s.color, opacity: s.opacity,
        spacing: s.spacing, hardness: s.hardness, angle: s.angle,
        angleJitter: s.angleJitter, flatness: s.flatness, antialias: s.antialias,
        waterEdge: s.waterEdge, waterEdgeWidth: s.waterEdgeWidth, waterEdgePower: s.waterEdgePower,
        taperIn: { ...s.taperIn }, taperOut: { ...s.taperOut }, seed: 1, pts: sample,
      }],
    }, undefined, tips);
  }

  $effect(() => {
    const el = prevEl;
    if (!el) return;
    // Read every setting so the effect re-runs when any of them moves.
    const live = JSON.stringify($state.snapshot(s));
    // Paint now with whatever is already decoded - usually the tip the last
    // frame settled - and re-ask, because the cache may have dropped it. Same
    // two-step TextBox's ink canvas uses, and for the same reason.
    paintPreview(el, prevTips);
    const id = s.brush;
    if (!id || id === BUILTIN_BRUSH) {
      prevTips = null;
      prevSeq++;
      void live;
      return;
    }
    const seq = ++prevSeq;
    settleTips([id]).then(
      (map) => {
        if (seq !== prevSeq || prevEl !== el || !el.width) return;
        const before = prevTips;
        prevTips = map;
        if ((before?.get(id) ?? null) !== (map?.get(id) ?? null)) paintPreview(el, map);
      },
      () => {},
    );
    void live;
  });
  $effect(() => () => {
    prevTips = null;
    prevSeq++;
    if (prevEl) {
      prevEl.width = 0;
      prevEl.height = 0;
    }
  });

  const num = (obj, key, v, lo, hi) => {
    obj[key] = Math.min(hi, Math.max(lo, Number(v) || 0));
  };
  const DYN_LABEL = { off: 'Off', pressure: 'Pressure', velocity: 'Velocity', random: 'Random' };
</script>

<div class="insp-pane">
  <canvas class="bpv" bind:this={prevEl} style="width:{PREV_W}px;height:{PREV_H}px" aria-label="Brush preview"></canvas>

  <div class="picker-head">
    <input
      class="find"
      type="text"
      placeholder="Find a brush"
      aria-label="Find a brush"
      bind:value={query}
      disabled={!installedBrushes.length}
    />
    <button
      type="button"
      class="icobtn"
      aria-label="Import brushes"
      title={brushLibrary.readOnly ? brushLibrary.error : 'Import .sut brushes'}
      disabled={importing || brushLibrary.readOnly}
      onclick={onImport}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M12 15V4" /><path d="M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      </svg>
    </button>
  </div>

  {#if !installedBrushes.length}
    <!-- The empty state teaches the feature rather than reporting a void. The
         round tip is not shown as a cell here: with nothing to choose between,
         a grid of one is a control that does nothing. -->
    <div class="tip-grid empty">
      <div class="emptymsg">
        <strong>No brushes yet</strong>
        <span>Import <code>.sut</code> or <code>.abr</code> files. The round tip works meanwhile.</span>
      </div>
    </div>
    <button type="button" class="addbtn" disabled={importing || brushLibrary.readOnly} onclick={onImport}>
      Import brushes…
    </button>
  {:else if !shown.length}
    <div class="tip-grid empty">
      <div class="emptymsg">
        <span>No brush is called “{query}”.</span>
      </div>
    </div>
  {:else}
    <div class="tip-grid">
      {#each shown as b (b.id)}
        <div class="cell" class:armed={rmArm === b.id}>
          <button
            type="button"
            class="tip"
            class:on={s.brush === b.id}
            aria-pressed={s.brush === b.id}
            title={b.source === 'thumbnail' ? `${b.name} - preview quality` : b.name}
            aria-label={b.name}
            onclick={() => pick(b)}
            oncontextmenu={(e) => {
              if (b.builtin) return;
              e.preventDefault();
              armRemove(b.id);
            }}
          >
            <canvas class="tipc" use:tipCell={b.id} aria-hidden="true"></canvas>
          </button>
          {#if !b.builtin && !brushLibrary.readOnly}
            <!-- Outside the cell button rather than inside it, because a button
                 cannot hold a button. Two-step: the first press arms. -->
            <button
              type="button"
              class="rm"
              class:arm={rmArm === b.id}
              title={rmArm === b.id ? `Click again to remove "${b.name}"` : `Remove "${b.name}"`}
              aria-label={rmArm === b.id ? `Remove ${b.name}, click again to confirm` : `Remove ${b.name}`}
              onclick={() => onRemove(b)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="tip-name">
    <span class="nm" title={currentName}>{currentName}</span>
    {#if current.missing}
      <!-- The stroke keeps the id it was drawn with; importing the `.sut` again
           brings the real tip back. See `resolveBrush`. -->
      <span class="chip" title="This brush is not installed here. Strokes drawn with it use the round tip.">missing</span>
    {:else if current.source === 'thumbnail'}
      <span class="chip" title="The pixels could not be read, so this is CSP's own preview of the tip.">preview quality</span>
    {/if}
    <span class="dim">{tipDims(current)}</span>
  </div>

  {#if brushLibrary.error}
    <p class="hint warn">{brushLibrary.error}</p>
  {/if}

  <div class="insp-rule"></div>

  <div class="grp">
    <span class="lbl">Size</span>
    <div class="slider-row">
      <input type="range" min="1" max="400" step="1" value={s.size} aria-label="Size" oninput={(e) => num(s, 'size', e.target.value, 1, 2000)} />
      <input class="num-s" type="number" min="1" max="2000" step="1" value={s.size} aria-label="Size, page px" onchange={(e) => num(s, 'size', e.target.value, 1, 2000)} />
    </div>
  </div>

  <div class="grp">
    <span class="lbl">Opacity</span>
    <div class="slider-row">
      <input type="range" min="0" max="100" step="1" value={Math.round(s.opacity * 100)} aria-label="Opacity" oninput={(e) => (s.opacity = Math.min(1, Math.max(0, Number(e.target.value) / 100)))} />
      <input class="num-s" type="number" min="0" max="100" step="1" value={Math.round(s.opacity * 100)} aria-label="Opacity, percent" onchange={(e) => (s.opacity = Math.min(1, Math.max(0, Number(e.target.value) / 100)))} />
    </div>
  </div>

  <div class="switch-row">
    <button type="button" class="switch" class:on={s.antialias} role="switch" aria-checked={s.antialias} aria-label="Anti-alias" onclick={() => (s.antialias = !s.antialias)}><span class="knob"></span></button>
    <span class="lbl2">Anti-alias</span>
  </div>

  <div class="subs">
    <div class="insp-sub" class:closed={!open.shape}>
      <button class="insp-sub-head" onclick={() => (open.shape = !open.shape)}>Shape
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div class="insp-sub-body">
        <div class="grp">
          <span class="lbl">Spacing</span>
          <div class="slider-row">
            <input type="range" min="1" max="100" step="1" value={s.spacing} title="How far the tip moves between stamps, as a percentage of its size" aria-label="Spacing" oninput={(e) => num(s, 'spacing', e.target.value, 1, 200)} />
            <input class="num-s" type="number" min="1" max="200" step="1" value={s.spacing} aria-label="Spacing, percent" onchange={(e) => num(s, 'spacing', e.target.value, 1, 200)} />
          </div>
        </div>
        <div class="grp">
          <span class="lbl">Angle</span>
          <div class="slider-row">
            <input type="range" min="0" max="359" step="1" value={s.angle} aria-label="Angle" oninput={(e) => num(s, 'angle', e.target.value, 0, 359)} />
            <input class="num-s" type="number" min="0" max="359" step="1" value={s.angle} aria-label="Angle, degrees" onchange={(e) => num(s, 'angle', e.target.value, 0, 359)} />
          </div>
        </div>
        <div class="grp">
          <span class="lbl">Hardness</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={s.hardness} title="100 is a flat disc; lower softens the edge" aria-label="Hardness" oninput={(e) => num(s, 'hardness', e.target.value, 0, 100)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={s.hardness} aria-label="Hardness, percent" onchange={(e) => num(s, 'hardness', e.target.value, 0, 100)} />
          </div>
        </div>
        <div class="grp">
          <span class="lbl">Flatness</span>
          <div class="slider-row">
            <input type="range" min="1" max="100" step="1" value={Math.round(s.flatness * 100)} title="Squashes the tip across its angle" aria-label="Flatness" oninput={(e) => (s.flatness = Math.min(1, Math.max(0.01, Number(e.target.value) / 100)))} />
            <input class="num-s" type="number" min="1" max="100" step="1" value={Math.round(s.flatness * 100)} aria-label="Flatness, percent" onchange={(e) => (s.flatness = Math.min(1, Math.max(0.01, Number(e.target.value) / 100)))} />
          </div>
        </div>
        <div class="switch-row">
          <button type="button" class="switch" class:on={s.waterEdge} role="switch" aria-checked={s.waterEdge} aria-label="Watercolour edge" onclick={() => (s.waterEdge = !s.waterEdge)}><span class="knob"></span></button>
          <span class="lbl2">Watercolour edge</span>
        </div>
        <!-- Hidden rather than greyed, unlike the taper's numbers: with the
             edge off these two say nothing at all, and Shape is already the
             longest section in the panel. -->
        {#if s.waterEdge}
          <div class="nest">
            <div class="grp">
              <span class="lbl">Band</span>
              <div class="slider-row">
                <input type="range" min="1" max="20" step="1" value={s.waterEdgeWidth} title="How far in from the stroke's edge the rim darkens, in page px" aria-label="Watercolour edge band" oninput={(e) => num(s, 'waterEdgeWidth', e.target.value, 1, 20)} />
                <input class="num-s" type="number" min="1" max="20" step="1" value={s.waterEdgeWidth} aria-label="Watercolour edge band, page px" onchange={(e) => num(s, 'waterEdgeWidth', e.target.value, 1, 20)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Strength</span>
              <div class="slider-row">
                <input type="range" min="0" max="100" step="1" value={Math.round(s.waterEdgePower * 100)} title="How much denser the rim goes than the ink inside it" aria-label="Watercolour edge strength" oninput={(e) => (s.waterEdgePower = Math.min(1, Math.max(0, Number(e.target.value) / 100)))} />
                <input class="num-s" type="number" min="0" max="100" step="1" value={Math.round(s.waterEdgePower * 100)} aria-label="Watercolour edge strength, percent" onchange={(e) => (s.waterEdgePower = Math.min(1, Math.max(0, Number(e.target.value) / 100)))} />
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="insp-sub" class:closed={!open.dyn}>
      <button class="insp-sub-head" onclick={() => (open.dyn = !open.dyn)}>Dynamics
        <span class="sbadge">{DYN_LABEL[s.dyn.src]}</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div class="insp-sub-body">
        <div class="grp">
          <span class="lbl">Size follows</span>
          <div class="seg">
            {#each DYN_SOURCES as src (src)}
              <button type="button" class:on={s.dyn.src === src} onclick={() => (s.dyn.src = src)}>{DYN_LABEL[src]}</button>
            {/each}
          </div>
        </div>
        <div class="grp">
          <span class="lbl">Amount</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={s.dyn.amount} disabled={s.dyn.src === 'off'} aria-label="Amount" oninput={(e) => num(s.dyn, 'amount', e.target.value, 0, 100)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={s.dyn.amount} disabled={s.dyn.src === 'off'} aria-label="Amount, percent" onchange={(e) => num(s.dyn, 'amount', e.target.value, 0, 100)} />
          </div>
        </div>
        {#if s.dyn.src === 'velocity'}
          <p class="hint">Velocity thins the middle of a fast stroke and leaves the ends thick.</p>
        {/if}
        <div class="insp-rule"></div>
        {#each [['taperIn', 'Taper in'], ['taperOut', 'Taper out']] as [key, label] (key)}
          <div class="switch-row">
            <button type="button" class="switch" class:on={s[key].on} role="switch" aria-checked={s[key].on} aria-label={label} onclick={() => (s[key].on = !s[key].on)}><span class="knob"></span></button>
            <span class="lbl2">{label}</span>
          </div>
          <div class="nest" class:disabled={!s[key].on}>
            <div class="grp">
              <span class="lbl">Length</span>
              <div class="slider-row">
                <input type="range" min="0" max="200" step="1" value={s[key].len} disabled={!s[key].on} aria-label="{label} length" oninput={(e) => num(s[key], 'len', e.target.value, 0, 500)} />
                <input class="num-s" type="number" min="0" max="500" step="1" value={s[key].len} disabled={!s[key].on} aria-label="{label} length, page px" onchange={(e) => num(s[key], 'len', e.target.value, 0, 500)} />
              </div>
            </div>
            <div class="grp">
              <span class="lbl">Sharpness</span>
              <div class="slider-row">
                <input type="range" min="0" max="100" step="1" value={s[key].ratio} disabled={!s[key].on} aria-label="{label} sharpness" oninput={(e) => num(s[key], 'ratio', e.target.value, 0, 100)} />
                <input class="num-s" type="number" min="0" max="100" step="1" value={s[key].ratio} disabled={!s[key].on} aria-label="{label} sharpness, percent" onchange={(e) => num(s[key], 'ratio', e.target.value, 0, 100)} />
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <div class="insp-sub" class:closed={!open.fix}>
      <button class="insp-sub-head" onclick={() => (open.fix = !open.fix)}>Correction
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div class="insp-sub-body">
        <div class="grp">
          <span class="lbl">Stabilisation</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={s.stabilise} aria-label="Stabilisation" oninput={(e) => num(s, 'stabilise', e.target.value, 0, 100)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={s.stabilise} aria-label="Stabilisation, percent" onchange={(e) => num(s, 'stabilise', e.target.value, 0, 100)} />
          </div>
        </div>
        {#if s.stabilise > 40}
          <p class="hint">Above 40 the stroke visibly trails the cursor. That is the trade for a steady curve.</p>
        {/if}
        <div class="insp-rule"></div>
        <div class="grp">
          <span class="lbl">Post-correction</span>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="1" value={s.postCorrect} title="Smooths the finished stroke once the pointer lifts" aria-label="Post-correction" oninput={(e) => num(s, 'postCorrect', e.target.value, 0, 100)} />
            <input class="num-s" type="number" min="0" max="100" step="1" value={s.postCorrect} aria-label="Post-correction, percent" onchange={(e) => num(s, 'postCorrect', e.target.value, 0, 100)} />
          </div>
        </div>
        <div class="switch-row">
          <button type="button" class="switch" class:on={s.sharpAngles.on} role="switch" aria-checked={s.sharpAngles.on} aria-label="Sharp angles" onclick={() => (s.sharpAngles.on = !s.sharpAngles.on)}><span class="knob"></span></button>
          <span class="lbl2">Sharp angles</span>
        </div>
        <div class="nest" class:disabled={!s.sharpAngles.on}>
          <div class="grp">
            <span class="lbl">Threshold</span>
            <div class="slider-row">
              <input type="range" min="5" max="170" step="1" value={s.sharpAngles.deg} disabled={!s.sharpAngles.on} title="A turn sharper than this is left alone by post-correction" aria-label="Sharp angle threshold" oninput={(e) => num(s.sharpAngles, 'deg', e.target.value, 5, 170)} />
              <input class="num-s" type="number" min="5" max="170" step="1" value={s.sharpAngles.deg} disabled={!s.sharpAngles.on} aria-label="Sharp angle threshold, degrees" onchange={(e) => num(s.sharpAngles, 'deg', e.target.value, 5, 170)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  /* The preview: ink on paper, because that is what it is. The width is the
     panel's default content width, and it gives it back rather than pushing a
     scrollbar when the panel is gripped narrower - the drawing scales, which is
     what a preview is for. */
  .bpv {
    display: block;
    max-width: 100%;
    height: 46px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--paper);
  }
  /* Search and Import share one row: the field takes the width and the button
     is a square at the end of it, so the grid below starts at the same place
     whether there are twelve brushes or none. */
  .picker-head {
    display: flex;
    gap: 6px;
  }
  .find {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    padding: 0 9px;
  }
  .find::placeholder {
    color: var(--t3);
  }
  .find:disabled {
    opacity: 0.45;
  }
  .icobtn {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--t2);
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .icobtn svg {
    width: 15px;
    height: 15px;
  }
  .icobtn:hover:not(:disabled) {
    color: var(--text);
  }
  .icobtn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* The picker's frame: four columns, scrolling past about two and a half rows
     rather than pushing the size slider off the panel. */
  .tip-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    max-height: 168px;
    overflow: auto;
    padding: 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
  }
  .tip-grid.empty {
    grid-template-columns: 1fr;
    place-items: center;
    min-height: 132px;
    max-height: none;
    overflow: visible;
  }
  .cell {
    position: relative;
    aspect-ratio: 1;
    min-width: 0;
  }
  /* A tip is ink on paper in BOTH themes. Inverting it in the dark theme would
     show a letterer a brush that is not the one they are about to draw with. */
  .tip {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 3px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: var(--paper);
    cursor: pointer;
  }
  .tipc {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  .tip:hover {
    border-color: var(--line2);
  }
  .tip.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  /* Hidden until the cell is pointed at or focused, and always visible once
     armed - the grid is for choosing a brush, not for deleting one. */
  .rm {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 15px;
    height: 15px;
    display: none;
    place-items: center;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 4px;
    background: var(--surface);
    color: var(--t3);
    cursor: pointer;
  }
  .rm svg {
    width: 9px;
    height: 9px;
  }
  .cell:hover .rm,
  .cell:focus-within .rm,
  .cell.armed .rm {
    display: grid;
  }
  .rm:hover,
  .rm.arm {
    border-color: var(--warn);
    color: var(--warn);
  }
  .cell.armed .tip {
    border-color: var(--warn);
  }
  /* The name of the brush that is selected, its true pixel size, and what is
     wrong with it if anything. */
  .tip-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
    min-width: 0;
  }
  .tip-name .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tip-name .dim {
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .chip {
    flex: 0 0 auto;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--warn);
    color: var(--warn);
    font-size: 9.5px;
    letter-spacing: 0.08em;
  }
  /* The empty state's own import button. The icon in the head does the same
     thing, but a panel with nothing in it should say what to do in words. */
  .addbtn {
    height: 28px;
    border: 1px dashed var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .addbtn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--line2);
  }
  .addbtn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .emptymsg {
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: center;
    padding: 14px;
    max-width: 236px;
  }
  .emptymsg strong {
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }
  .emptymsg span {
    font-size: 11px;
    line-height: 1.5;
    color: var(--t3);
  }
  .emptymsg code {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px;
    color: var(--t2);
  }
  .subs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* The active dynamics source, readable without opening the section. */
  .sbadge {
    font-size: 10px;
    letter-spacing: 0.3px;
    text-transform: none;
    color: var(--t3);
    border: 1px solid var(--line2);
    border-radius: 4px;
    padding: 0 5px;
    font-weight: 500;
  }
  /* A group of controls under a switch, indented so the switch reads as owning
     them. Same idea as the Inspector's disabled sub-bodies. */
  .nest {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding-left: 11px;
    border-left: 1px solid var(--line);
  }
  .nest.disabled {
    opacity: 0.45;
    pointer-events: none;
  }
  .hint {
    font-size: 11px;
    line-height: 1.45;
    color: var(--t3);
    margin: 0;
  }
</style>
