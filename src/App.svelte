<script module>
  // Holds page-switch unsubscribe across component remounts.
  let releasePageSwitch = null;
</script>

<script>
  import EditorRoot from './lib/editor/EditorRoot.svelte';
  import FontModal from './lib/FontModal.svelte';
  import SettingsModal from './lib/SettingsModal.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import Toast from './lib/Toast.svelte';
  import HomeFrame from './lib/home/HomeFrame.svelte';
  import LibraryView from './lib/home/LibraryView.svelte';
  import ProjectView from './lib/home/ProjectView.svelte';
  import NewChapterDialog from './lib/home/NewChapterDialog.svelte';
  import ChapterSourcesSheet from './lib/home/ChapterSourcesSheet.svelte';
  import { onMount, untrack } from 'svelte';
  import { app, deleteBox, deselect, nextPage, prevPage, setTool, closeBulk, toast, setPageSwitchHook, flushSidebar, noteFontsChanged, isLongstrip, isTranslateMode } from './lib/store.svelte.js';
  import { initHistory, undo, redo } from './lib/editor/history.svelte.js';
  import { flushPanels } from './lib/editor/panels.svelte.js';
  import { switchHistoryPage } from './lib/editor/history-file.svelte.js';
  import { restoreFonts } from './lib/fonts.js';
  import { isTauri } from './lib/importer.js';
  import { checkSidecar } from './lib/sidecar.js';
  import { initTheme } from './lib/theme.svelte.js';
  import { library, initRoot, openChapter, flushBeforeLeaving } from './lib/library.svelte.js';
  import { route, goBack } from './lib/route.svelte.js';

  let fontModalOpen = $state(false);
  let settingsOpen = $state(false);
  let newChapterOpen = $state(false);
  let newChapterBusy = $state(false);
  let newChapterProject = $state(null);
  let newChapterMode = $state('files');
  let sourcesOpen = $state(false);
  let sourcesBusy = $state(false);
  let sourcesRef = $state({ projectId: null, chapterId: null });
  // Library root resolves asynchronously before child views mount.
  let booted = $state(false);

  onMount(async () => {
    initTheme();
    // Register history and page-switch hooks.
    initHistory();
    releasePageSwitch?.();
    releasePageSwitch = setPageSwitchHook(switchHistoryPage);
    try {
      await initRoot();
    } catch (e) {
      // Display root resolution failure on the library screen.
      library.error = `Could not work out where your library lives — ${e?.message ?? e}`;
    } finally {
      // Mark booted regardless of success.
      booted = true;
    }
    restoreFonts();
    // Recompute measurements when web fonts finish loading.
    document.fonts?.ready.then(() => noteFontsChanged());
    armQuitFlush();
    // Probe detection engine (Tauri only).
    checkSidecar().then((h) => {
      if (h) toast(`Detection ready · ${h.device}`);
    });
  });

  // Quitting with the editor open flushes pending debounced writes.
  async function armQuitFlush() {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      // Track single in-flight quit flush.
      let inFlight = null;
      const safeToQuit = () => {
        // Flush preference tiers and open chapter before quitting.
        flushSidebar();
        flushPanels();
        if (!app.chapterRef) return Promise.resolve(true);
        if (!inFlight) inFlight = flushBeforeLeaving('quit').finally(() => (inFlight = null));
        return inFlight;
      };

      // Route 1: window close button.
      await w.onCloseRequested(async (e) => {
        if (!app.chapterRef) {
          // Flush preferences when closing without an open chapter.
          flushSidebar();
          flushPanels();
          return;
        }
        e.preventDefault();
        if (await safeToQuit()) await w.destroy();
      });

      // Route 2: Cmd+Q and Quit menu item.
      await patchDefaultMenu(safeToQuit, w);
    } catch {

    }
  }

  // Strip predefined Undo/Redo from macOS application menu so DOM keydowns work.
  async function patchDefaultMenu(safeToQuit, w) {
    // macOS only: patch default menu for Cmd+Q intercept and Undo/Redo removal.
    if (!/Mac/i.test(navigator.userAgent)) return;
    const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
    const menu = await Menu.default();
    let changed = false;
    let quitDone = false;
    for (const sub of await menu.items()) {
      if (sub.kind !== 'Submenu') continue;
      const items = await sub.items();
      // Descending so removals do not shift unvisited indices.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind !== 'Predefined') continue;

        const text = (await items[i].text()) ?? '';
        if (/^&?(un|re)do\b/i.test(text)) {
          await sub.removeAt(i);
          changed = true;
          continue;
        }
        // Replace only the first Quit item.
        if (quitDone || !/^&?quit\b/i.test(text)) continue;
        const replacement = await MenuItem.new({
          id: 'mt-quit',
          text,
          accelerator: 'CmdOrCtrl+Q',
          action: async () => {
            if (await safeToQuit()) await w.destroy();
          },
        });
        await sub.removeAt(i);
        await sub.insert(replacement, i);
        quitDone = true;
        changed = true;
      }
    }
    // Apply as application menu if modified.
    if (changed) await menu.setAsAppMenu();
  }

  // Hydrate editor when routing to a chapter.
  $effect(() => {
    if (route.name !== 'editor') return;
    const { projectId, chapterId } = route;
    if (untrack(() => app.chapterRef?.chapterId) === chapterId) return;
    openChapter(projectId, chapterId).catch((e) => {
      toast(`Could not open that chapter — ${e?.message ?? e}`);
      goBack();
    });
  });

  function openNewChapter(projectId = null, mode = 'files') {
    newChapterProject = projectId;
    newChapterMode = mode;
    newChapterOpen = true;
  }

  function openSources(projectId, chapterId) {
    sourcesRef = { projectId, chapterId };
    sourcesOpen = true;
  }

  function onKeydown(e) {
    const t = e.target;
    if (t instanceof Element && t.matches('input,textarea,select')) return;
    if (app.editingId) return;
    if (e.key === 'Escape') {
      if (newChapterOpen) {
        // In-flight chapter copy is not dismissible.
        if (!newChapterBusy) newChapterOpen = false;
        return;
      }
      if (sourcesOpen) {
        // In-flight copy is not dismissible.
        if (!sourcesBusy) sourcesOpen = false;
        return;
      }
      if (app.exportOpen) return (app.exportOpen = false);
      if (app.bulk.active) return closeBulk();
      if (settingsOpen) return (settingsOpen = false);
      if (fontModalOpen) return (fontModalOpen = false);
      return deselect();
    }
    // Suppress global editor shortcuts while modal overlay is open.
    if (typeof document !== 'undefined' && document.querySelector('.modal-overlay.open')) return;
    if (route.name !== 'editor') return;
    // Guard tool shortcuts against modifier keys.
    const mod = e.metaKey || e.ctrlKey;
    const isHistoryKey = mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y');
    // Translate chapters have no canvas edits to undo.
    if (isHistoryKey && isTranslateMode()) {
      e.preventDefault();
      toast('Nothing to undo here — a translate chapter edits the queue, not the canvas');
      return;
    }
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId && !isTranslateMode()) {
      e.preventDefault();
      deleteBox(app.selectedId);
    }
    // Tool shortcuts (v, t, h).
    if (!mod && (e.key === 'v' || e.key === 'V')) setTool('place');
    if (!mod && (e.key === 't' || e.key === 'T')) setTool('text');
    if (!mod && (e.key === 'h' || e.key === 'H')) setTool('pan');
    // Longstrip navigation is handled by scroll container.
    if (!isLongstrip()) {
      if (e.key === 'ArrowRight' && !e.shiftKey) nextPage();
      if (e.key === 'ArrowLeft' && !e.shiftKey) prevPage();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if route.name === 'editor'}
  <EditorRoot onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />
{:else if booted}
  <HomeFrame onSettings={() => (settingsOpen = true)}>
    {#if route.name === 'project'}
      <ProjectView
        onNewChapter={(id) => openNewChapter(id)}
        onImportPsd={(id) => openNewChapter(id, 'psd')}
        onSources={openSources}
      />
    {:else}
      <LibraryView
        onNewChapter={() => openNewChapter(null)}
        onImportPsd={() => openNewChapter(null, 'psd')}
      />
    {/if}
  </HomeFrame>
{:else}
  <div class="boot"></div>
{/if}

<NewChapterDialog
  bind:open={newChapterOpen}
  bind:busy={newChapterBusy}
  projectId={newChapterProject}
  mode={newChapterMode}
/>
<ChapterSourcesSheet
  bind:open={sourcesOpen}
  bind:busy={sourcesBusy}
  projectId={sourcesRef.projectId}
  chapterId={sourcesRef.chapterId}
/>
<FontModal bind:open={fontModalOpen} />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
