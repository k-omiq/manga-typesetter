<script>
  import { app, prevPage, nextPage } from './store.svelte.js';
  import { pickJson, pickImages } from './importer.js';
  import { pickPsd } from './psd.js';
  import { detectAllPages, sidecarReady } from './sidecar.js';
  import { goProject, goLibrary } from './route.svelte.js';
  import { projectById, chapterById } from './library.svelte.js';

  let { onFontLib, onSettings } = $props();

  const canDetect = $derived(sidecarReady() && app.pages.some((p) => p?.raw) && !app.detecting);

  const label = $derived.by(() => {
    const ref = app.chapterRef;
    if (!ref) return 'Untitled';
    const p = projectById(ref.projectId);
    const c = chapterById(ref.projectId, ref.chapterId);
    if (!p || !c) return 'Untitled';
    return `${p.name} · ${c.title || 'Chapter ' + c.number}`;
  });

  // Leaving the editor awaits a save before the route moves. A second click in
  // that window would run the leave hook twice and push a duplicate history
  // entry, so the control is inert until the first navigation settles.
  let leaving = $state(false);

  async function goHome() {
    if (leaving) return;
    leaving = true;
    try {
      const pid = app.chapterRef?.projectId;
      // A refused leave has already told the user why and left them here; there
      // is nothing more to do.
      await (pid ? goProject(pid) : goLibrary());
    } finally {
      leaving = false;
    }
  }

  function openExport() {
    app.exportOpen = true;
  }
</script>

<header class="topbar">
  <div class="brand">
    <button class="logo-btn" onclick={goHome} disabled={leaving} title="Back to the project">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 7.4 8 3l5.4 4.4" /><path d="M4.3 6.9v6.3h7.4V6.9" /></svg>
    </button>
    <div class="name">{label}</div>
  </div>

  <nav class="pagenav">
    <button onclick={prevPage} disabled={app.pageIndex === 0} data-tip="Previous page" data-tip-pos="down">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <!-- No chapter open: "Page 0 / 0" rather than a first page that isn't there. -->
    <span class="indicator">Page <b>{app.pages.length ? app.pageIndex + 1 : 0}</b> / {app.pages.length}</span>
    <button onclick={nextPage} disabled={app.pageIndex >= app.pages.length - 1} data-tip="Next page" data-tip-pos="down">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6" /></svg>
    </button>
  </nav>

  <div class="topbar-right">
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
      <button class="btn" disabled={!canDetect} onclick={() => detectAllPages()} data-tip={sidecarReady() ? 'Detect text + OCR on every loaded page (sidecar)' : 'Sidecar not ready'} data-tip-pos="down">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>{app.detectBatch ? `Detecting ${app.detectBatch.done}/${app.detectBatch.total}…` : app.detecting ? 'Detecting…' : 'Detect'}
      </button>
    </div>
    <span class="divider-v"></span>
    <div class="export-combo">
      <select class="fmt" bind:value={app.fmt} data-tip="Export format">
        <option>PNG</option><option>JPG</option><option>WebP</option><option>PSD</option><option>JSON</option>
      </select>
      <button class="btn btn-accent" onclick={openExport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>Export
      </button>
    </div>
    <span class="divider-v"></span>
    <button class="btn btn-icon" onclick={onFontLib} data-tip="Font Library">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    </button>
    <button class="btn btn-icon" onclick={onSettings} data-tip="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
    </button>
  </div>
</header>
