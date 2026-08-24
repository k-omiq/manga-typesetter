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

  const s = $derived(brushTool.settings);

  // Which sections are open. Session state on the module would outlive the
  // panel; per-instance is right, because closing the panel is closing the tool.
  let open = $state({ shape: false, dyn: false, fix: false });

  // The preview: one sample stroke drawn with the live settings, by the painter
  // that draws the real thing. A number on a slider does not tell a letterer
  // what a taper does; this does.
  let prevEl = $state(null);
  const PREV_W = 288;
  const PREV_H = 46;
  const sample = [
    [10, 31, 1], [52, 14, 1], [96, 34, 1], [140, 20, 1], [196, 12, 1], [278, 27, 1],
  ];
  $effect(() => {
    const el = prevEl;
    if (!el) return;
    // Read every setting so the effect re-runs when any of them moves.
    const live = JSON.stringify($state.snapshot(s));
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
        angleJitter: s.angleJitter, flatness: s.flatness,
        taperIn: { ...s.taperIn }, taperOut: { ...s.taperOut }, seed: 1, pts: sample,
      }],
    });
    void live;
  });
  $effect(() => () => {
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

  <div class="tip-grid empty">
    <div class="emptymsg">
      <strong>No brushes yet</strong>
      <span>Import <code>.sut</code> or <code>.abr</code> files. The round tip works meanwhile.</span>
    </div>
  </div>

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
  /* The picker's frame. Phase 1 has no library, so it only ever shows the empty
     state; the frame is here so the panel does not change shape when it fills. */
  .tip-grid {
    display: grid;
    place-items: center;
    min-height: 132px;
    padding: 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
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
