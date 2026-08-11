<script>
  import { app, saveExportPrefs, markSaved } from './store.svelte.js';
  import { exportImages } from './exporter.js';

  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

  // JSON exports the detected/typeset text, not a rendered page — one document
  // for the whole scope rather than one file per page.
  const isJson = $derived(app.fmt === 'JSON');

  function close() {
    app.exportOpen = false;
  }
  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) close();
  }
  function onName(e) {
    saveExportPrefs(null, e.target.value.trim() || 'page');
  }
  async function go(scope) {
    close();
    const ok = await exportImages(app.fmt, scope);
    if (ok) markSaved();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open={app.exportOpen} onclick={onOverlayClick}>
  <div class="modal export-modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
      <h3>Export</h3>
      <button class="x" onclick={close}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="grp">
        <label class="lbl">File name (base)</label>
        <input type="text" value={app.exportName} oninput={onName} placeholder="page" />
        <div class="exp-sub">
          {#if isJson}
            Saved as <code>{app.exportName}-text.json</code> — the detected text (JP + your
            translation), reading order and box geometry for every page in scope.
          {:else}
            Saved as <code>{app.exportName}-&lt;page&gt;.{app.fmt.toLowerCase()}</code>
          {/if}
        </div>
      </div>

      <div class="grp">
        <label class="lbl">Output folder</label>
        {#if isTauri}
          <div class="exp-dir">{app.exportDir || 'Not set — you’ll pick on export'}</div>
        {:else}
          <div class="exp-dir warn">Browser preview — files download to your Downloads folder. The native picker works in the desktop app.</div>
        {/if}
      </div>

      <div class="grp">
        <label class="lbl">What to export?</label>
        <div class="exp-choices">
          <button class="exp-card" onclick={() => go('current')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
            <div class="t">This page</div>
            <div class="d">Page {app.pageIndex + 1} only</div>
          </button>
          <button class="exp-card" onclick={() => go('all')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="13" height="15" rx="2" /><path d="M8 2h11a2 2 0 0 1 2 2v13" /></svg>
            <div class="t">All pages</div>
            <div class="d">{app.pages.length} {isJson ? 'pages, one file' : 'images'}</div>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
