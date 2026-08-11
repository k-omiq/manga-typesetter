<script>
  import TopBar from './lib/TopBar.svelte';
  import RawPanel from './lib/RawPanel.svelte';
  import Editor from './lib/Editor.svelte';
  import RightPanel from './lib/RightPanel.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import FontModal from './lib/FontModal.svelte';
  import SettingsModal from './lib/SettingsModal.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import Toast from './lib/Toast.svelte';
  import Resizer from './lib/Resizer.svelte';
  import { onMount } from 'svelte';
  import { app, deleteBox, deselect, nextPage, prevPage, setTool, closeBulk, toast, undoBrush } from './lib/store.svelte.js';
  import { restoreFonts } from './lib/fonts.js';
  import { checkSidecar, refreshFluxStatus } from './lib/sidecar.js';

  let fontModalOpen = $state(false);
  let settingsOpen = $state(false);

  onMount(() => {
    restoreFonts();
    // Probe the Python sidecar (only meaningful under Tauri; no-op in the browser).
    // The health probe resolves once the child is up; only then can the FLUX
    // status GET succeed (it has no retry of its own), so chain it here — this
    // is what fixes the panel's stale "AI not installed" after a cold boot.
    checkSidecar().then((h) => {
      if (h) {
        toast(`Sidecar ready · ${h.device}`);
        refreshFluxStatus();
      }
    });
  });

  function onKeydown(e) {
    const t = e.target;
    if (t instanceof Element && t.matches('input,textarea,select')) return;
    // ignore shortcuts while inline-editing a text box
    if (app.editingId) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId) {
      e.preventDefault();
      deleteBox(app.selectedId);
    }
    if (e.key === 'Escape') {
      if (app.exportOpen) app.exportOpen = false;
      else if (app.bulk.active) closeBulk();
      else if (settingsOpen) settingsOpen = false;
      else if (fontModalOpen) fontModalOpen = false;
      else deselect();
    }
    // Brush stroke undo (clean mode) — per-stroke = per-layer.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && app.mode === 'clean') {
      e.preventDefault();
      undoBrush();
      return;
    }
    if (e.key === 'v' || e.key === 'V') setTool('place');
    if (e.key === 't' || e.key === 'T') setTool('text');
    // Brush size nudge while a brush tool is active.
    if (app.tool === 'brush' && (e.key === '[' || e.key === ']')) {
      const d = e.key === ']' ? 4 : -4;
      app.brush.size = Math.max(4, Math.min(240, app.brush.size + d));
    }
    if (e.key === 'ArrowRight' && !e.shiftKey) nextPage();
    if (e.key === 'ArrowLeft' && !e.shiftKey) prevPage();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <TopBar onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />

  <div class="main">
    <!-- Raw reference is a Translate-mode aid (see the original alongside the
         cleaned page you're typesetting on). In Clean mode the editor IS the raw
         you're cleaning, so a separate reference is redundant — hide it. -->
    {#if app.mode !== 'clean'}
      <RawPanel />
      <Resizer side="left" />
    {/if}
    <Editor />
    <Resizer side="right" />
    <RightPanel />
  </div>

  <StatusBar />
</div>

<FontModal bind:open={fontModalOpen} />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
