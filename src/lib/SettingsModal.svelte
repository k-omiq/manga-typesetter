<script>
  // Settings. Model cache, the default export directory, and engine status.
  // Reuses the detection bridges + Tauri dialog.
  import { app, saveExportPrefs, toast } from './store.svelte.js';
  import { checkSidecar, modelsCacheInfo, clearModelsCache } from './sidecar.js';
  import { theme, setTheme } from './theme.svelte.js';
  import { library, setRoot, scanLibrary, withinHome } from './library.svelte.js';
  import { resetPanels } from './editor/panels.svelte.js';
  import { processMemory, ROLE_LABELS } from './memory.js';

  let { open = $bindable() } = $props();

  let cache = $state(null); // { entries:[{path,exists,bytes}], total_bytes } | null
  let cacheLoading = $state(false);
  let clearing = $state(false);
  let confirmClear = $state(false); // inline two-step confirm (webviews may block window.confirm)
  let confirmResetPanels = $state(false); // same two-step; a reset cannot be undone

  // ---------- PSD export self-test (dev builds only) ----------
  // `psdSelfTest` builds a PSD from the open page, parses it back, and compares
  // the serialized page, the layer rasters, the merged composite and the group
  // structure. It needs a real canvas, so no test in the suite can run it — from
  // node, psd.test.js can only reach a page with no art and no boxes, which is
  // to say it cannot check the two things most likely to break: that the base
  // layers go in unresampled and that each text layer carries its box's pixels.
  //
  // Behind a button rather than run on export, because it costs a whole extra
  // build and parse of the page, and a check the user pays for on every export
  // is a check that gets removed. Behind DEV, because it reports in a
  // developer's vocabulary — `rasterMaxChannelDiff`, group names — and there is
  // nothing here a reader of the app could act on.
  const DEV = !!import.meta.env?.DEV;
  let selfTesting = $state(false);
  let selfTest = $state(null); // the last report, or { error }

  async function onPsdSelfTest() {
    if (!app.pages.length) {
      toast('Open a chapter first — the self-test runs on the page you are looking at');
      return;
    }
    selfTesting = true;
    selfTest = null;
    try {
      // Dynamic, so a production bundle that has already dropped this branch
      // does not keep the module alive on this modal's account.
      const { psdSelfTest } = await import('./psd.js');
      selfTest = await psdSelfTest(app.pages[app.pageIndex]);
      toast(selfTest.ok ? 'PSD self-test passed' : 'PSD self-test FAILED — see Settings');
    } catch (e) {
      selfTest = { ok: false, error: String(e?.message ?? e) };
      toast('PSD self-test threw — see Settings');
    } finally {
      selfTesting = false;
    }
  }

  // ---------- live memory ----------
  // What this app is actually costing, counting the processes it does not look
  // like it owns. The web view is a separate process on macOS — it is where the
  // page, the scripts and every decoded page image live — and any ML child the
  // app spawns is another. Activity Monitor lists them under different names,
  // so the app's own row there has never been the answer.
  let mem = $state(null); // MemoryReport | null (null = not the desktop app)
  let memLive = $state(false);

  async function loadMemory() {
    mem = await processMemory();
  }

  // Polled only while the modal is open AND the user asked for it. Reading it
  // is a walk of every process on the machine, which is cheap but not free, and
  // a settings panel left open should not spin on it — so the poll is opt-in
  // and the interval is cleared by the same effect that started it, whether the
  // toggle went off or the modal closed.
  $effect(() => {
    if (!open || !memLive) return;
    const t = setInterval(loadMemory, 2000);
    return () => clearInterval(t);
  });

  // One reading whenever the modal opens, so the section is never blank.
  $effect(() => {
    if (open) loadMemory();
  });

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }

  function isTauri() {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  }

  function fmtBytes(n) {
    if (!n || n < 1) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  async function loadCache() {
    cacheLoading = true;
    cache = await modelsCacheInfo();
    cacheLoading = false;
  }

  async function onClearCache() {
    if (!confirmClear) {
      confirmClear = true;
      return;
    }
    confirmClear = false;
    clearing = true;
    try {
      const r = await clearModelsCache();
      toast(r?.ok ? `Cleared cache · freed ${fmtBytes(r.freed_bytes)}` : 'Cache clear had errors — see logs');
      await loadCache();
    } catch (e) {
      toast(`Clear cache failed: ${e}`);
    } finally {
      clearing = false;
    }
  }

  // The panels are windows the user drags, and a layout dragged off the edge or
  // shrunk to nothing is the one state they cannot get out of by dragging. This
  // is that way out, and it belongs here rather than in the editor because the
  // layout it repairs may be exactly what makes the editor unusable.
  function onResetPanels() {
    if (!confirmResetPanels) {
      confirmResetPanels = true;
      return;
    }
    confirmResetPanels = false;
    // The live window, because that is what the layout has to fit — and this
    // modal opens from the library screen too, where there is no panel on screen
    // to measure. `resetPanels` clamps to it and persists through the same
    // storage the editor loads from, so a reset done with no editor mounted is
    // still there when one is.
    resetPanels(window.innerWidth, window.innerHeight);
    toast('Panel layout reset');
  }

  async function onChangeExportDir() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }
    try {
      const { open: pickDir } = await import('@tauri-apps/plugin-dialog');
      const dir = await pickDir({ directory: true, defaultPath: app.exportDir || undefined });
      if (dir) {
        saveExportPrefs(dir, app.exportName);
        toast('Default export folder set');
      }
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }

  async function chooseRoot() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }
    // Rescanning replaces library.projects wholesale, which would orphan the open
    // chapter's ref and turn every later autosave into a silent no-op.
    if (app.chapterRef) {
      toast('Close the open chapter before changing the library folder');
      return;
    }
    try {
      const { open: pick } = await import('@tauri-apps/plugin-dialog');
      const dir = await pick({ directory: true, defaultPath: library.root });
      if (!dir) return;
      // Both filesystem scopes are $HOME/** in this slice (see
      // src-tauri/capabilities/default.json). Outside it, every read and write
      // is denied, and the library would appear simply broken — say so here
      // instead, where the choice is being made.
      if (!(await withinHome(dir))) {
        toast('The library has to live inside your home folder for now.');
        return;
      }
      await setRoot(dir);
      await scanLibrary();
      toast('Library folder changed');
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }

  // Refresh live engine status + cache size each time the panel opens.
  $effect(() => {
    if (open) {
      confirmClear = false;
      confirmResetPanels = false;
      checkSidecar();
      loadCache();
    }
  });

  const sidecarOk = $derived(app.sidecar?.status === 'ok');
  // `engine` says what is doing the work, `device` what it is running on — the
  // two things that changed when detection moved in-process, and the two a user
  // reporting a slow or wrong detection is asked for.
  const sidecarLabel = $derived(
    app.sidecar?.status === 'ok'
      ? `Ready · ${app.sidecar.info?.engine ?? 'onnx-rust'} · ${app.sidecar.device ?? '—'}`
      : app.sidecar?.status === 'unavailable'
        ? 'Unavailable — desktop app only'
        : app.sidecar?.status === 'error'
          ? 'Error — see logs'
          : 'Checking…',
  );

</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      <h3>Settings</h3>
      <button class="x" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="modal-body">
      <div class="settings-section">
        <div class="settings-title">APPEARANCE</div>
        <div class="field">
          <span>Theme</span>
          <!-- `theme.mode` is the choice, `theme.resolved` is what is on screen.
               System is lit like any other state rather than being an absence of
               one, and it says which way it currently resolves — otherwise the
               only way to know what "System" means right now is to look at the
               app it is describing. -->
          <div class="seg">
            <button class:on={theme.mode === 'light'} onclick={() => setTheme('light')}>Light</button>
            <button class:on={theme.mode === 'dark'} onclick={() => setTheme('dark')}>Dark</button>
            <button class:on={theme.mode === 'system'} onclick={() => setTheme('system')}>
              System{theme.mode === 'system' ? ` · ${theme.resolved}` : ''}
            </button>
          </div>
        </div>
        <div class="field">
          <span>Panel layout</span>
          <div class="field-actions">
            <button class="btn tiny" class:danger={confirmResetPanels} onclick={onResetPanels}>
              {confirmResetPanels ? 'Confirm — reset?' : 'Reset'}
            </button>
            {#if confirmResetPanels}
              <button class="btn tiny" onclick={() => (confirmResetPanels = false)}>Cancel</button>
            {/if}
          </div>
        </div>
        <div class="qhint">Puts the Text Box Options and Text Queue windows back to their starting size and place.</div>
      </div>

      <div class="settings-section">
        <div class="settings-title">LIBRARY</div>
        <div class="field">
          <span>Folder</span>
          <code class="path" title={library.root}>{library.root}</code>
        </div>
        <button
          class="btn"
          disabled={!isTauri() || !!app.chapterRef}
          title={app.chapterRef ? 'Close the open chapter first' : 'Pick a different library folder'}
          onclick={chooseRoot}
        >
          Change folder…
        </button>
        {#if app.chapterRef}
          <div class="qhint">Close the open chapter before changing the library folder.</div>
        {/if}
      </div>

      <!-- Detection engine status. No restart control: the engine runs inside
           this process, so there is nothing to respawn. -->
      <div class="srow">
        <span class="slabel">Detection engine</span>
        <span class="dot {sidecarOk ? 'ok' : app.sidecar?.status === 'error' ? 'err' : 'off'}"></span>
        <span class="sval">{sidecarLabel}</span>
      </div>

      <div class="group-label">Models</div>

      <!-- Detection/OCR models (auto-managed, read-only) -->
      <div class="model-card muted">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>
            <div>
              <div class="mc-name">Detection &amp; OCR</div>
              <div class="mc-sub">comic-text-detector · manga-ocr · panel YOLO</div>
            </div>
          </div>
          <span class="tag auto">Auto</span>
        </div>
        <p class="mc-desc">Downloaded automatically on first <b>Detect</b> and cached locally. No action needed.</p>
      </div>

      <!-- Model cache footprint + clear -->
      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" /></svg>
            <div>
              <div class="mc-name">Model cache</div>
              <div class="mc-sub">
                {#if cacheLoading}Measuring…{:else if cache}{fmtBytes(cache.total_bytes)} on disk{:else}Size unavailable — desktop app only{/if}
              </div>
            </div>
          </div>
          {#if cache}<span class="tag">{fmtBytes(cache.total_bytes)}</span>{/if}
        </div>

        {#if cache?.entries?.length}
          <div class="paths">
            {#each cache.entries as e}
              <div class="path-row">
                <span class="path" title={e.path}>{e.path}</span>
                <span class="path-size">{e.exists ? fmtBytes(e.bytes) : '—'}</span>
              </div>
            {/each}
          </div>
        {/if}

        <p class="mc-desc">
          Downloaded detector/OCR weights. Clearing frees disk; they re-download
          on the next <b>Detect</b>.
        </p>

        <div class="mc-actions">
          <button
            class="btn"
            class:danger={confirmClear}
            disabled={clearing || !sidecarOk || !cache || cache.total_bytes === 0}
            onclick={onClearCache}
          >
            {#if clearing}Clearing…{:else if confirmClear}Confirm — delete weights?{:else}Clear cache{/if}
          </button>
          {#if confirmClear}
            <button class="btn" disabled={clearing} onclick={() => (confirmClear = false)}>Cancel</button>
          {/if}
          <button class="btn" disabled={cacheLoading || !isTauri()} onclick={loadCache}>Recheck</button>
        </div>

        {#if !sidecarOk}
          <div class="qhint">The detection engine isn't reporting — cache actions need the desktop app.</div>
        {/if}
      </div>

      <div class="group-label">Memory</div>

      <!-- Live footprint, per process. The rows are the point: a single total
           is what Activity Monitor already gives, and it is the split between
           the web view and the app itself that tells you which one to go after. -->
      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="10" rx="2" /><path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3" /></svg>
            <div>
              <div class="mc-name">Live footprint</div>
              <div class="mc-sub">
                {#if !mem}Desktop app only — a browser tab cannot see its own host process.
                {:else if !mem.supported}Not available on this platform.
                {:else}{mem.processes.length} process{mem.processes.length === 1 ? '' : 'es'}, this app and everything it is responsible for.{/if}
              </div>
            </div>
          </div>
          {#if mem?.supported}<span class="tag">{fmtBytes(mem.total)}</span>{/if}
        </div>

        {#if mem?.supported && mem.processes.length}
          <div class="paths">
            {#each mem.processes as pr (pr.pid)}
              <div class="path-row">
                <span class="path" title="{pr.name} · pid {pr.pid} · matched by {pr.via}">
                  {ROLE_LABELS[pr.role] ?? pr.name}
                </span>
                <span class="path-size">{fmtBytes(pr.bytes)}</span>
              </div>
            {/each}
          </div>
        {/if}

        <p class="mc-desc">
          Physical footprint, the same measure Activity Monitor's <b>Memory</b>
          column uses — not RSS, which counts the shared system libraries once
          per process and would make this total several times too big. The
          web&nbsp;view is where page images live, so it is the row that moves
          when you open a long chapter.
        </p>

        {#if mem?.incomplete}
          <div class="qhint">One or more processes went away while being measured — the total is short.</div>
        {/if}
        <!-- A dev build launched from a terminal inherits its responsibility
             from the shell, so its web view cannot be matched to it exactly and
             is matched by launch session instead. Said out loud, because it is
             the one row here that could in principle belong to something else
             started from the same shell. A double-clicked app never shows it. -->
        {#if mem?.processes?.some((pr) => pr.via === 'session')}
          <div class="qhint">
            Web view rows matched by launch session — this is a development build started
            from a terminal. A released app matches its web view exactly.
          </div>
        {/if}

        <div class="mc-actions">
          <button class="btn" disabled={!isTauri()} onclick={loadMemory}>Refresh</button>
          <!-- `btn-accent` rather than an `on` class: the stylesheet has no
               `.btn.on`, and a toggle whose only state change is invisible is
               not a toggle. -->
          <button class="btn" class:btn-accent={memLive} disabled={!isTauri()} onclick={() => (memLive = !memLive)}>
            {memLive ? 'Stop live' : 'Live (2s)'}
          </button>
        </div>
      </div>

      <div class="group-label">Export</div>

      <!-- Default export directory -->
      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            <div>
              <div class="mc-name">Default export folder</div>
              <div class="mc-sub path" title={app.exportDir || ''}>
                {app.exportDir || 'Not set — the export dialog asks each time'}
              </div>
            </div>
          </div>
        </div>
        <p class="mc-desc">Where <b>Export</b> saves by default. You can still choose a different folder at export time.</p>
        <div class="mc-actions">
          <button class="btn" disabled={!isTauri()} onclick={onChangeExportDir}>Change…</button>
          {#if app.exportDir}
            <button class="btn" onclick={() => { saveExportPrefs('', app.exportName); toast('Cleared default export folder'); }}>Clear</button>
          {/if}
        </div>
        {#if !isTauri()}
          <div class="qhint">Choosing a folder needs the desktop app; browser exports download to your default location.</div>
        {/if}
      </div>

      {#if DEV}
        <div class="group-label">Developer</div>

        <!-- The only caller of psdSelfTest, and the only place in the app where
             buildPagePsd's layer output is checked at all — see the note above
             it in psd.js for why no test can do this. -->
        <div class="model-card">
          <div class="mc-top">
            <div class="mc-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6v4l4 10a3 3 0 0 1-3 4H8a3 3 0 0 1-3-4L9 7z" /><path d="M8 14h8" /></svg>
              <div>
                <div class="mc-name">PSD export self-test</div>
                <div class="mc-sub">Runs on the page you have open</div>
              </div>
            </div>
          </div>
          <p class="mc-desc">
            Builds a PSD from the current page, reads it back, and checks the round-tripped project, the
            per-layer pixels, the flat-white composite and the group structure. Needs a real canvas, so
            the test suite cannot run it.
          </p>
          <div class="mc-actions">
            <button class="btn" disabled={selfTesting || !app.pages.length} onclick={onPsdSelfTest}>
              {selfTesting ? 'Running…' : 'Run self-test'}
            </button>
          </div>
          {#if !app.pages.length}
            <div class="qhint">Open a chapter first — the self-test runs on the page you are looking at.</div>
          {/if}
          {#if selfTest}
            <pre class="mc-report" class:bad={!selfTest.ok}>{JSON.stringify(selfTest, null, 2)}</pre>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .srow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 4px 2px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 14px;
  }
  .slabel {
    color: var(--t2);
  }
  .sval {
    margin-left: 2px;
    color: var(--text);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--t3);
  }
  .dot.ok {
    background: var(--text);
  }
  .dot.err {
    background: var(--warn);
  }
  .group-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t2);
    margin-bottom: 8px;
  }
  .model-card {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    background: var(--panel2);
  }
  .model-card.muted {
    opacity: 0.85;
  }
  .mc-top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .mc-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }
  .mc-title svg {
    flex: none;
    color: var(--t2);
  }
  .mc-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
  }
  .mc-sub {
    font-size: 11.5px;
    color: var(--t2);
  }
  .mc-desc {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--t2);
    margin: 10px 0 0;
  }
  /* The self-test report, verbatim. A developer's output, so it is shown as
     what it is rather than summarised into a sentence that would hide which of
     the six checks failed. Scrolls in both directions so a long check list
     cannot stretch the modal. */
  .mc-report {
    margin: 10px 0 0;
    padding: 8px 10px;
    max-height: 220px;
    overflow: auto;
    border-radius: 6px;
    background: var(--panel2);
    color: var(--t2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
  }
  .mc-report.bad {
    color: var(--warn);
  }
  .mc-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .tag {
    flex: none;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel2);
    color: var(--t2);
    height: fit-content;
  }
  .tag.auto {
    background: var(--accent-soft);
    color: var(--text);
  }
  .btn {
    padding: 7px 14px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  /* Small button. Not pushed right by an `auto` margin — inside `.field-actions`
     that would shove the two buttons of the confirm step apart. The row is
     pushed to the right edge by the wrapper instead, once. */
  .btn.tiny {
    padding: 4px 10px;
    font-size: 12px;
  }
  .field-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  .btn.danger {
    background: color-mix(in srgb, var(--warn) 16%, transparent);
    border-color: var(--warn);
    color: var(--warn);
    font-weight: 600;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .paths {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .path-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 11.5px;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t2);
    font-family: ui-monospace, monospace;
  }
  .path-size {
    flex: none;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .qhint {
    font-size: 12px;
    color: var(--t2);
    margin-top: 10px;
    line-height: 1.4;
  }
</style>
