<script>

  import { onDestroy } from 'svelte';
  import { app, saveExportPrefs, toast } from './store.svelte.js';
  import { checkSidecar, modelsCacheInfo, clearModelsCache } from './sidecar.js';
  import { theme, setTheme } from './theme.svelte.js';
  import { library, setRoot, scanLibrary, withinHome } from './library.svelte.js';
  import { resetPanels } from './editor/panels.svelte.js';
  import { processMemory, ROLE_LABELS } from './memory.js';
  import { prefs, setPref } from './prefs.svelte.js';
  import {
    shortcutGroups,
    comboFor,
    defaultCombo,
    isCustomCombo,
    setCombo,
    resetCombo,
    resetAllCombos,
    formatCombo,
  } from './shortcuts.svelte.js';
  import { createRebindCapture } from './rebind-capture.js';

  let { open = $bindable() } = $props();

  // ---------- shortcuts ----------
  // The registry is a fixed list; only which combo each row shows is reactive,
  // and that comes from `comboFor` reading the preferences.
  const groups = shortcutGroups();
  let capturing = $state(null); // shortcut id currently listening for a keypress
  let captureErr = $state('');
  let confirmResetKeys = $state(false);

  const capture = createRebindCapture(typeof window === 'undefined' ? null : window, {
    onKey: (combo, done) => {
      const r = setCombo(capturing, combo);
      if (r.ok) {
        done();
        capturing = null;
        captureErr = '';
        return;
      }
      captureErr =
        r.reason === 'conflict'
          ? `${formatCombo(combo)} is already “${r.conflict.label}”`
          : 'That key cannot be used - try another';
    },
    onCancel: () => {
      // Both cancel paths land here - bare Escape and the modal closing -
      // so the row stops presenting itself as still listening.
      capturing = null;
      captureErr = '';
    },
  });

  function beginCapture(id) {
    captureErr = '';
    capturing = capture.begin(id);
  }

  // While a row is listening, its keys are captured on the way down and
  // stopped there, so binding Cmd+1 does not also switch tool and Escape does
  // not close the settings modal out from under the row. The listener is armed
  // only while the modal is open AND a row is listening: closing the modal
  // mid-capture cancels the capture instead of leaving a window-wide key
  // snatcher behind.
  $effect(() => {
    capture.setOpen(open);
    capturing = capture.current;
  });
  onDestroy(() => capture.setOpen(false));

  function onResetKeys() {
    if (!confirmResetKeys) {
      confirmResetKeys = true;
      return;
    }
    confirmResetKeys = false;
    capture.end();
    capturing = null;
    captureErr = '';
    resetAllCombos();
    toast('Shortcuts back to their defaults');
  }

  let cache = $state(null); // { entries:[{path,exists,bytes}], total_bytes } | null
  let cacheLoading = $state(false);
  let clearing = $state(false);
  let confirmClear = $state(false); // inline two-step confirm (webviews may block window.confirm)
  let confirmResetPanels = $state(false); // same two-step; a reset cannot be undone

  // PSD export self-test (dev builds only).
  const DEV = !!import.meta.env?.DEV;
  let selfTesting = $state(false);
  let selfTest = $state(null); // the last report, or { error }

  async function onPsdSelfTest() {
    if (!app.pages.length) {
      toast('Open a chapter first - the self-test runs on the page you are looking at');
      return;
    }
    selfTesting = true;
    selfTest = null;
    try {

      const { psdSelfTest } = await import('./psd.js');
      selfTest = await psdSelfTest(app.pages[app.pageIndex]);
      toast(selfTest.ok ? 'PSD self-test passed' : 'PSD self-test FAILED - see Settings');
    } catch (e) {
      selfTest = { ok: false, error: String(e?.message ?? e) };
      toast('PSD self-test threw - see Settings');
    } finally {
      selfTesting = false;
    }
  }

  // Process memory tracking.
  let mem = $state(null); // MemoryReport | null (null = not the desktop app)
  let memLive = $state(false);

  async function loadMemory() {
    mem = await processMemory();
  }

  // Poll memory only while modal is open and live toggle is on.
  $effect(() => {
    if (!open || !memLive) return;
    const t = setInterval(loadMemory, 2000);
    return () => clearInterval(t);
  });


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
      toast(r?.ok ? `Cleared cache · freed ${fmtBytes(r.freed_bytes)}` : 'Cache clear had errors - see logs');
      await loadCache();
    } catch (e) {
      toast(`Clear cache failed: ${e}`);
    } finally {
      clearing = false;
    }
  }

  // Reset floating panel layout.
  function onResetPanels() {
    if (!confirmResetPanels) {
      confirmResetPanels = true;
      return;
    }
    confirmResetPanels = false;

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

    if (app.chapterRef) {
      toast('Close the open chapter before changing the library folder');
      return;
    }
    try {
      const { open: pick } = await import('@tauri-apps/plugin-dialog');
      const dir = await pick({ directory: true, defaultPath: library.root });
      if (!dir) return;
      // Library folder must be inside home directory.
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


  $effect(() => {
    if (open) {
      confirmClear = false;
      confirmResetPanels = false;
      confirmResetKeys = false;
      capturing = null;
      captureErr = '';
      checkSidecar();
      loadCache();
    }
  });

  const sidecarOk = $derived(app.sidecar?.status === 'ok');

  const sidecarLabel = $derived(
    app.sidecar?.status === 'ok'
      ? `Ready · ${app.sidecar.info?.engine ?? 'onnx-rust'} · ${app.sidecar.device ?? '-'}`
      : app.sidecar?.status === 'unavailable'
        ? 'Unavailable - desktop app only'
        : app.sidecar?.status === 'error'
          ? 'Error - see logs'
          : 'Checking…',
  );

</script>

<!-- One switch, written once. Every preference toggle in here is the same three
     things - a knob, the preference it writes, and the name a screen reader
     reads - and the row that spells them out by hand is the row that ends up
     writing the wrong key. `disabled` is a look and a refusal, not an attribute:
     the element is a div, so it also leaves the tab order. -->
{#snippet toggle(key, label, on, disabled = false)}
  <div
    class="switch"
    class:on
    class:disabled
    role="switch"
    aria-checked={on}
    aria-label={label}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
    onclick={() => !disabled && setPref(key, !on)}
    onkeydown={(e) => {
      if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setPref(key, !on);
      }
    }}
  ><span class="knob"></span></div>
{/snippet}

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
              {confirmResetPanels ? 'Confirm - reset?' : 'Reset'}
            </button>
            {#if confirmResetPanels}
              <button class="btn tiny" onclick={() => (confirmResetPanels = false)}>Cancel</button>
            {/if}
          </div>
        </div>
        <div class="qhint">Puts the Text Box Options and Text Queue windows back to their starting size and place.</div>
      </div>

      <!-- The typesetting engine used to hang off every text box as its own
           Inspector sub-menu, which put a half-finished feature in front of
           everyone editing a line of dialogue. It is one preference, it applies
           to the whole app, and it lives here now - off, and labelled. -->
      <div class="settings-section ts-section">
        <div class="settings-title">TYPESETTING <span class="beta-badge">Beta · work in progress</span></div>
        <div class="field">
          <span>Smart line breaking</span>
          {@render toggle('typeset', 'Smart line breaking (beta)', prefs.typeset)}
        </div>
        <div class="qhint">
          Breaks lines to the shape of the balloon, hyphenates words that fit
          nowhere, and lays text out to a fitted balloon instead of its box.
          Unfinished - with it off, boxes wrap plainly and the extra controls
          stay out of the Inspector.
        </div>

        <!-- The defaults a new box is born with. Auto height stands outside the
             beta gate because it is not part of it: it is on in every build and
             it is what makes a box grow with its text. The other four only mean
             anything while the engine above is on, so they are dimmed with it
             rather than hidden - a switch that vanishes is a switch nobody finds
             again. -->
        <div class="group-label">Defaults for new text boxes</div>
        <div class="field">
          <span>Auto height</span>
          {@render toggle('defaultAutoHeight', 'Auto height', prefs.defaultAutoHeight)}
        </div>
        <div class="qhint">
          The box grows and shrinks so its text fits, anchored by its vertical
          alignment. Its width is never touched.
        </div>
        <div class="ts-defaults" class:dim={!prefs.typeset}>
          <div class="field">
            <span>Shaped line breaks</span>
            {@render toggle('defaultShape', 'Shaped line breaks', prefs.defaultShape, !prefs.typeset)}
          </div>
          <div class="field">
            <span>Hyphenate long words</span>
            {@render toggle('defaultHyphenate', 'Hyphenate long words', prefs.defaultHyphenate, !prefs.typeset)}
          </div>
          <div class="field">
            <span>Fit text to balloon</span>
            {@render toggle('defaultBalloon', 'Fit text to balloon', prefs.defaultBalloon, !prefs.typeset)}
          </div>
          <div class="field">
            <label for="ts-orphan">Shortest word left alone on a line</label>
            <input
              id="ts-orphan"
              class="ts-num"
              type="number"
              min="1"
              max="8"
              step="1"
              disabled={!prefs.typeset}
              value={prefs.defaultMinOrphan}
              title="A word shorter than this is never left alone at the end of a line"
              onchange={(e) => { setPref('defaultMinOrphan', e.target.value); e.target.value = prefs.defaultMinOrphan; }}
            />
          </div>
        </div>
        <div class="qhint">
          Applies to new text boxes · per-box via Bulk style. Boxes already on a
          page keep whatever they were given.
        </div>
      </div>

      <!-- Every key the editor answers to by name. The three contextual ones -
           Escape, Tab and the arrows - are listed at the bottom as what they
           are: fixed, because their meaning depends on what is selected. -->
      <div class="settings-section">
        <div class="settings-title">SHORTCUTS</div>
        <div class="qhint sc-intro">
          Click a shortcut, then press the keys you want. <b>Esc</b> cancels.
        </div>

        {#each groups as g (g.name)}
          <div class="group-label">{g.name}</div>
          {#each g.items as s (s.id)}
            <div class="sc-row" class:capturing={capturing === s.id}>
              <span class="sc-label">{s.label}</span>
              <button
                class="sc-combo"
                class:custom={isCustomCombo(s.id)}
                class:listening={capturing === s.id}
                title={capturing === s.id
                  ? 'Press the keys - Esc cancels'
                  : `Click to rebind · default ${formatCombo(defaultCombo(s.id))}`}
                onclick={() => beginCapture(s.id)}
              >
                {capturing === s.id ? 'Press keys…' : formatCombo(comboFor(s.id))}
              </button>
              <button
                class="btn tiny sc-reset"
                disabled={!isCustomCombo(s.id)}
                title="Back to {formatCombo(defaultCombo(s.id))}"
                onclick={() => { resetCombo(s.id); if (capturing === s.id) { capture.end(); capturing = null; } }}
              >
                Default
              </button>
            </div>
            {#if capturing === s.id && captureErr}
              <div class="sc-err">{captureErr}</div>
            {/if}
          {/each}
        {/each}

        <div class="mc-actions">
          <button class="btn" class:danger={confirmResetKeys} onclick={onResetKeys}>
            {confirmResetKeys ? 'Confirm - reset every shortcut?' : 'Reset all shortcuts'}
          </button>
          {#if confirmResetKeys}
            <button class="btn" onclick={() => (confirmResetKeys = false)}>Cancel</button>
          {/if}
        </div>

        <div class="qhint">
          Fixed, because what they do depends on what you have selected:
          <b>Esc</b> closes whatever is open and then deselects,
          <b>Tab</b> steps through the boxes on the page, and the
          <b>arrows</b> nudge the selected box - or turn the page when nothing
          is selected. Hold <b>Shift</b> with an arrow for a bigger nudge.
        </div>
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
                {#if cacheLoading}Measuring…{:else if cache}{fmtBytes(cache.total_bytes)} on disk{:else}Size unavailable - desktop app only{/if}
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
                <span class="path-size">{e.exists ? fmtBytes(e.bytes) : '-'}</span>
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
            {#if clearing}Clearing…{:else if confirmClear}Confirm - delete weights?{:else}Clear cache{/if}
          </button>
          {#if confirmClear}
            <button class="btn" disabled={clearing} onclick={() => (confirmClear = false)}>Cancel</button>
          {/if}
          <button class="btn" disabled={cacheLoading || !isTauri()} onclick={loadCache}>Recheck</button>
        </div>

        {#if !sidecarOk}
          <div class="qhint">The detection engine isn't reporting - cache actions need the desktop app.</div>
        {/if}
      </div>

      <div class="group-label">Memory</div>


      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="10" rx="2" /><path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3" /></svg>
            <div>
              <div class="mc-name">Live footprint</div>
              <div class="mc-sub">
                {#if !mem}Desktop app only - a browser tab cannot see its own host process.
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
          column uses - not RSS, which counts the shared system libraries once
          per process and would make this total several times too big. The
          web&nbsp;view is where page images live, so it is the row that moves
          when you open a long chapter.
        </p>

        {#if mem?.supported && mem?.incomplete}
          <div class="qhint">One or more processes went away while being measured - the total is short.</div>
        {/if}

        {#if mem?.processes?.some((pr) => pr.via === 'session')}
          <div class="qhint">
            Web view rows matched by launch session - this is a development build started
            from a terminal. A released app matches its web view exactly.
          </div>
        {/if}

        <div class="mc-actions">
          <button class="btn" disabled={!isTauri()} onclick={loadMemory}>Refresh</button>

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
                {app.exportDir || 'Not set - the export dialog asks each time'}
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
            <div class="qhint">Open a chapter first - the self-test runs on the page you are looking at.</div>
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

  /* One shortcut: what it does on the left, the keys on the right. The keys are
     the button - there is no second "change" control to hunt for, and the row
     says what it is going to do when you press it. */
  .sc-intro {
    margin-top: 0;
    margin-bottom: 12px;
  }
  /* The registry's own group headings sit between rows rather than above a
     card, so they need the air the card gave the ones further down. */
  .settings-section .group-label {
    margin-top: 16px;
  }
  .sc-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    border-bottom: 1px solid var(--line);
  }
  .sc-label {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sc-combo {
    flex: none;
    min-width: 92px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    cursor: pointer;
  }
  .sc-combo:hover {
    background: var(--accent-soft);
  }
  /* A rebound key is worth spotting at a glance when you are wondering why a
     press does something unexpected. */
  .sc-combo.custom {
    border-color: var(--line2);
    font-weight: 600;
  }
  .sc-combo.listening {
    border-color: var(--warn);
    color: var(--warn);
    font-family: inherit;
  }
  .sc-reset {
    flex: none;
  }
  .sc-reset:disabled {
    /* Present but silent on a default binding - the row keeps its shape, so
       nothing shifts sideways when a shortcut is changed. */
    opacity: 0.28;
  }
  .sc-err {
    font-size: 12px;
    color: var(--warn);
    padding: 4px 0 6px;
    line-height: 1.4;
  }

  /* Typesetting. The rows here are sentences, not the two-word labels the fixed
     110px column further up was cut for, so the label takes the room and the
     control sits at the right edge - which also lines every switch in the
     section up with every other one. */
  .ts-section .field > span,
  .ts-section .field > label {
    width: auto;
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--t2);
  }
  /* The four beta defaults mean nothing while the engine above them is off, so
     they dim with it rather than vanishing: a control that disappears is one
     nobody finds again when they turn the beta on. */
  .ts-defaults.dim {
    opacity: 0.5;
  }
  .ts-section :global(.switch.disabled) {
    cursor: default;
  }
  .ts-num {
    flex: none;
    width: 62px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .ts-num:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
