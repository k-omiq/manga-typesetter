<script>
  import { app, prevPage, nextPage, setMode, page, toast } from './store.svelte.js';
  import { pickJson, pickImages } from './importer.js';
  import { pickPsd } from './psd.js';
  import { detectCurrentPage, sidecarReady } from './sidecar.js';

  let { onFontLib } = $props();

  const canDetect = $derived(sidecarReady() && !!page()?.raw && !app.detecting);

  function openExport() {
    app.exportOpen = true;
  }
</script>

<header class="topbar">
  <div class="brand">
    <div class="logo">場</div>
    <div class="name">Manga&nbsp;Typesetter <span class="dim">· Untitled</span></div>
  </div>

  <nav class="pagenav">
    <button onclick={prevPage} disabled={app.pageIndex === 0} data-tip="Previous page" data-tip-pos="down">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <span class="indicator">Page <b>{app.pageIndex + 1}</b> / {app.pages.length}</span>
    <button onclick={nextPage} disabled={app.pageIndex === app.pages.length - 1} data-tip="Next page" data-tip-pos="down">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6" /></svg>
    </button>
  </nav>

  <div class="topbar-right">
    <div class="seg version-seg" data-tip="Workspace mode" data-tip-pos="down">
      <button class:on={app.mode === 'clean'} onclick={() => setMode('clean')}>Clean</button>
      <button class:on={app.mode === 'translate'} onclick={() => setMode('translate')}>Translate</button>
    </div>
    <span class="divider-v"></span>
    <div class="btn-group">
      <button class="btn" onclick={() => pickJson()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>JSON
      </button>
      <button class="btn" onclick={() => pickImages('cleaned')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>Cleaned
      </button>
      <button class="btn" onclick={() => pickImages('raw')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>Raw
      </button>
      <button class="btn" onclick={() => pickPsd()} data-tip="Import layered PSD (lossless if exported here)" data-tip-pos="down">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h4a2 2 0 0 1 0 4H7zM7 8v8" /><path d="M15 8v8h2a2 2 0 0 0 0-4h-2" /></svg>PSD
      </button>
      <button class="btn" disabled={!canDetect} onclick={() => detectCurrentPage()} data-tip={sidecarReady() ? 'Detect text + OCR (sidecar)' : 'Sidecar not ready'} data-tip-pos="down">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>{app.detecting ? 'Detecting…' : 'Detect'}
      </button>
    </div>
    <span class="divider-v"></span>
    <div class="export-combo">
      <select class="fmt" bind:value={app.fmt} data-tip="Export format">
        <option>PNG</option><option>JPG</option><option>WebP</option><option>PSD</option>
      </select>
      <button class="btn btn-accent" onclick={openExport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>Export
      </button>
    </div>
    <span class="divider-v"></span>
    <button class="btn btn-icon" onclick={onFontLib} data-tip="Font Library">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    </button>
    <button class="btn btn-icon" onclick={() => toast('Settings — coming soon')} data-tip="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
    </button>
  </div>
</header>
