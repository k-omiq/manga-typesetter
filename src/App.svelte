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
  import HomeFrame from './lib/home/HomeFrame.svelte';
  import LibraryView from './lib/home/LibraryView.svelte';
  import ProjectView from './lib/home/ProjectView.svelte';
  import NewChapterDialog from './lib/home/NewChapterDialog.svelte';
  import { onMount, untrack } from 'svelte';
  import { app, deleteBox, deselect, nextPage, prevPage, setTool, closeBulk, toast } from './lib/store.svelte.js';
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
  // The library root is resolved asynchronously. Nothing that scans the library
  // may mount before it is known — a child's onMount runs before its parent's,
  // so LibraryView would otherwise scan an empty path and report an error.
  let booted = $state(false);

  onMount(async () => {
    initTheme();
    try {
      await initRoot();
    } catch (e) {
      // Resolving the root is the one thing between launch and a window with
      // anything in it. If it fails, say so on the library screen — which owns
      // every other library failure, and already renders library.error as an
      // alert with a retry — rather than leaving a blank frame with no way out.
      library.error = `Could not work out where your library lives — ${e?.message ?? e}`;
    } finally {
      // Always. A boot that cannot finish still has to render something.
      booted = true;
    }
    restoreFonts();
    armQuitFlush();
    // Probe the Python sidecar (only meaningful under Tauri; no-op in the browser).
    checkSidecar().then((h) => {
      if (h) toast(`Sidecar ready · ${h.device}`);
    });
  });

  // Every edit reaches disk through an 800ms debounce, so quitting with the
  // editor open drops up to 800ms of work unless something flushes on the way
  // out. A desktop window being destroyed fires no unload the page can await, so
  // both routes out of the app have to be caught explicitly.
  //
  // These are the only @tauri-apps imports outside the filesystem facade and the
  // importer: fsx is the seam for *filesystem* calls, and window lifecycle is
  // not one.
  async function armQuitFlush() {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      // Shared by both routes out. Resolves true when it is safe to go; false
      // when the flush failed and the user has been told (the second consecutive
      // failure returns true, so a disk that will never write cannot pin the
      // window open — see flushBeforeLeaving).
      const safeToQuit = () => (app.chapterRef ? flushBeforeLeaving('quit') : Promise.resolve(true));

      // Route 1: the red close button.
      await w.onCloseRequested(async (e) => {
        if (!app.chapterRef) return; // nothing pending; let it close
        e.preventDefault();
        if (await safeToQuit()) await w.destroy();
      });

      // Route 2: ⌘Q and the menu's Quit item — the dominant way this app is
      // closed on macOS, and one that raises no close request at all. tao's
      // macOS app delegate implements `applicationWillTerminate` and nothing
      // earlier: there is no `applicationShouldTerminate`, so by the time the
      // app hears about the quit the run loop is already ending and the webview
      // can no longer be asked for anything. Tauri's RunEvent::ExitRequested is
      // no help either — tauri-runtime-wry only raises it when the last window
      // is destroyed or when app.exit() is called, never from LoopDestroyed.
      //
      // The last point that is still ordinary application time is the menu item
      // itself. The default menu's Quit is a *predefined* item, which on macOS
      // sends `terminate:` straight to NSApp. Swapping it for an ordinary item
      // carrying the same ⌘Q accelerator turns the quit into a menu event this
      // code can await in — flush first, then destroy the window, which exits.
      await interceptQuitMenuItem(safeToQuit, w);
    } catch {
      // No quit hook is better than a boot that fails over one.
    }
  }

  async function interceptQuitMenuItem(safeToQuit, w) {
    const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
    const menu = await Menu.default();
    for (const sub of await menu.items()) {
      if (sub.kind !== 'Submenu') continue;
      const items = await sub.items();
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'Predefined') continue;
        // muda names it '&Quit'; macOS drops the mnemonic marker.
        const text = (await items[i].text()) ?? '';
        if (!/^&?quit\b/i.test(text)) continue;
        const replacement = await MenuItem.new({
          id: 'mt-quit',
          text, // whatever the platform already called it
          accelerator: 'CmdOrCtrl+Q',
          action: async () => {
            if (await safeToQuit()) await w.destroy();
          },
        });
        await sub.removeAt(i);
        await sub.insert(replacement, i);
        await menu.setAsAppMenu();
        return;
      }
    }
    // Nothing matched — leave the platform's own menu in place rather than
    // installing a half-built one. The close-request route still holds.
  }

  // Hydrate the editor whenever the route lands on a chapter. The guard read is
  // untracked on purpose: openChapter writes app.chapterRef, so tracking it here
  // would make this effect its own trigger. The invariant is that nothing the
  // editor writes can re-run this — the route, plus whatever openChapter's own
  // synchronous prefix reads (library.projects, p.chapters, c.unreadable), are
  // its dependencies, and a rescan re-opening the same chapter is a no-op.
  $effect(() => {
    if (route.name !== 'editor') return;
    const { projectId, chapterId } = route;
    if (untrack(() => app.chapterRef?.chapterId) === chapterId) return;
    openChapter(projectId, chapterId).catch((e) => {
      toast(`Could not open that chapter — ${e?.message ?? e}`);
      goBack();
    });
  });

  function openNewChapter(projectId = null) {
    newChapterProject = projectId;
    newChapterOpen = true;
  }

  function onKeydown(e) {
    const t = e.target;
    if (t instanceof Element && t.matches('input,textarea,select')) return;
    // ignore shortcuts while inline-editing a text box
    if (app.editingId) return;
    if (e.key === 'Escape') {
      if (newChapterOpen) {
        // A chapter copy in flight must not be dismissible — the same guard the
        // dialog's overlay and Cancel already carry. Unmounting mid-copy would
        // hide the failure in a component nobody can see.
        if (!newChapterBusy) newChapterOpen = false;
        return;
      }
      if (app.exportOpen) return (app.exportOpen = false);
      if (app.bulk.active) return closeBulk();
      if (settingsOpen) return (settingsOpen = false);
      if (fontModalOpen) return (fontModalOpen = false);
      return deselect();
    }
    if (route.name !== 'editor') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId) {
      e.preventDefault();
      deleteBox(app.selectedId);
    }
    if (e.key === 'v' || e.key === 'V') setTool('place');
    if (e.key === 't' || e.key === 'T') setTool('text');
    if (e.key === 'ArrowRight' && !e.shiftKey) nextPage();
    if (e.key === 'ArrowLeft' && !e.shiftKey) prevPage();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if route.name === 'editor'}
  <div class="app">
    <TopBar onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />

    <div class="main">
      <!-- Raw reference: the original page alongside the one you're typesetting. -->
      <RawPanel />
      <Resizer side="left" />
      <Editor />
      <Resizer side="right" />
      <RightPanel />
    </div>

    <StatusBar />
  </div>
{:else if booted}
  <HomeFrame onSettings={() => (settingsOpen = true)}>
    {#if route.name === 'project'}
      <ProjectView onNewChapter={openNewChapter} />
    {:else}
      <LibraryView onNewChapter={() => openNewChapter(null)} />
    {/if}
  </HomeFrame>
{:else}
  <div class="boot"></div>
{/if}

<NewChapterDialog bind:open={newChapterOpen} bind:busy={newChapterBusy} projectId={newChapterProject} />
<FontModal bind:open={fontModalOpen} />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
