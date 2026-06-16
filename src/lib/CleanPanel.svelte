<script>
  // Clean-mode right panel. Full implementation lands in later phases:
  //  - Cleaning Queue: per-text automated clean progress (Phase 3)
  //  - Brush Tools: clone / content-aware fill, backed by Rust (Phase 4)
  //  - Layers: one editable patch layer per detected text (Phase 3)
  import { app } from './store.svelte.js';

  const layerCount = $derived(app.pages[app.pageIndex]?.clean?.layers?.length ?? 0);
</script>

<div class="rpanel">
  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Cleaning Queue
      <span class="count">{layerCount} layer{layerCount === 1 ? '' : 's'}</span>
    </div>
    <div class="section-body">
      <div class="qhint">Automated cleaning not wired yet.<br />Detection + smart fill/inpaint arrives in a later phase.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Brush Tools
    </div>
    <div class="section-body">
      <div class="qhint">Clone &amp; content-aware fill (Rust-backed) — coming soon.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      Layers
    </div>
    <div class="section-body">
      <div class="qhint">Each cleaned text gets its own layer here.</div>
    </div>
  </div>
</div>
