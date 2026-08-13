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
  import { app, deleteBox, deselect, nextPage, prevPage, setTool, closeBulk, toast, setPageSwitchHook } from './lib/store.svelte.js';
  import { initHistory, undo, redo } from './lib/editor/history.svelte.js';
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
  // The library root is resolved asynchronously. Nothing that scans the library
  // may mount before it is known — a child's onMount runs before its parent's,
  // so LibraryView would otherwise scan an empty path and report an error.
  let booted = $state(false);

  onMount(async () => {
    initTheme();
    // Both are registrations, not work: the store hands its edits to the
    // history and its page turns to the file that keeps every other page's
    // stack. Done here, once, so nothing in the editor has to import either.
    initHistory();
    setPageSwitchHook(switchHistoryPage);
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
      //
      // Single-flight. A close request always prevents the native close and
      // destroys afterwards, so a second click on the red button while the first
      // flush is still awaiting a slow, failing write would start a second
      // attempt — and two attempts against one failure spend the escape
      // immediately, force-closing milliseconds after the refusal appears. That
      // is the loss the two-step exists to prevent. Overlapping callers share the
      // one in-flight answer instead.
      let inFlight = null;
      const safeToQuit = () => {
        if (!app.chapterRef) return Promise.resolve(true);
        if (!inFlight) inFlight = flushBeforeLeaving('quit').finally(() => (inFlight = null));
        return inFlight;
      };

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
      //
      // The same pass also strips the Edit submenu's Undo/Redo — see the
      // function for why. Both edits ride one Menu.default()/setAsAppMenu()
      // because two passes would each rebuild from the platform default and the
      // second would discard the first.
      await patchDefaultMenu(safeToQuit, w);
    } catch {
      // No quit hook is better than a boot that fails over one.
    }
  }

  // One pass over Menu.default(), two edits, one install:
  //
  //  1. Quit becomes an ordinary item this code can await in (see armQuitFlush).
  //  2. The Edit submenu's predefined Undo and Redo are removed outright.
  //
  // (2) is what it cost us to learn that a *predefined* Undo item in the default
  // menu silently outranks the web view's keyboard handling. Its ⌘Z / ⇧⌘Z key
  // equivalents are offered the key event at the macOS responder level, ahead of
  // the web view, so no `keydown` for ⌘Z ever reaches the DOM while that item
  // validates as enabled — and a predefined `undo:` item auto-validates as
  // enabled exactly while WebKit's editor has typing to undo. The symptom was
  // ⌘Z straight after the Text tool's click/type/Escape clearing the box's text
  // (WebKit's own text undo, fired by the menu) instead of running onKeydown's
  // undo(); it worked again once focus moved on and the item greyed out, and the
  // dock's undo button — which never routes through a key equivalent — always
  // worked. Nothing in JS can see this happen; it is invisible from the web view.
  //
  // Removing the items rather than replacing them is the whole fix. An ordinary
  // MenuItem carrying ⌘Z would consume the key *unconditionally*, including
  // inside a real text field, leaving that field's own undo to a speculative
  // document.execCommand('undo') delegation. With no item claiming the key
  // equivalent, ⌘Z falls through to the web view and both undos work on their
  // own terms: WebKit's inside a focused editable, onKeydown's everywhere else.
  //
  // Cut/Copy/Paste/Select All stay predefined and untouched — they are audited
  // working, and they are not in the way of anything.
  async function patchDefaultMenu(safeToQuit, w) {
    // macOS only, deliberately. It is the one platform where Tauri installs a
    // default application menu at startup, where that menu's Quit is the
    // dominant way out, and where ⌘Q is the idiom. On Windows there is no menu
    // on this window at all, and setAsAppMenu would attach one — a File/Edit/
    // Window/Help bar appearing above the canvas, shifting the layout, to
    // intercept a Ctrl+Q that is not a Windows quit shortcut. Not worth it.
    if (!/Mac/i.test(navigator.userAgent)) return;
    const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
    const menu = await Menu.default();
    let changed = false;
    let quitDone = false;
    for (const sub of await menu.items()) {
      if (sub.kind !== 'Submenu') continue;
      const items = await sub.items();
      // Descending, so a removal cannot shift an index still to be visited.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind !== 'Predefined') continue;
        // muda names them '&Quit'/'&Undo'; macOS drops the mnemonic marker.
        const text = (await items[i].text()) ?? '';
        if (/^&?(un|re)do\b/i.test(text)) {
          await sub.removeAt(i);
          changed = true;
          continue;
        }
        // The first Quit only: a second replacement would install a duplicate
        // item id, and one intercepted route out is all this needs.
        if (quitDone || !/^&?quit\b/i.test(text)) continue;
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
        quitDone = true;
        changed = true;
      }
    }
    // Nothing matched — leave the platform's own menu in place rather than
    // installing a half-built one. The close-request route still holds.
    if (changed) await menu.setAsAppMenu();
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
      if (sourcesOpen) {
        // A copy in flight must not be dismissible, for the same reason the
        // chapter dialog's is not.
        if (!sourcesBusy) sourcesOpen = false;
        return;
      }
      if (app.exportOpen) return (app.exportOpen = false);
      if (app.bulk.active) return closeBulk();
      if (settingsOpen) return (settingsOpen = false);
      if (fontModalOpen) return (fontModalOpen = false);
      return deselect();
    }
    if (route.name !== 'editor') return;
    // Before the single-letter tool shortcuts, and the reason they are guarded
    // at all: without this, ⌘Z would read as a bare 'z' on its way past and
    // ⌘Y would switch tools. The early returns above already leave the
    // browser's own undo alone inside a field or an inline box edit.
    const mod = e.metaKey || e.ctrlKey;
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId) {
      e.preventDefault();
      deleteBox(app.selectedId);
    }
    // The tool shortcuts are bare letters, and ⌘V/⌘T are not requests to
    // switch tool. Only these two are guarded: the page turns below have always
    // answered to a held modifier, and this is not the task that takes that
    // away.
    if (!mod && (e.key === 'v' || e.key === 'V')) setTool('place');
    if (!mod && (e.key === 't' || e.key === 'T')) setTool('text');
    if (e.key === 'ArrowRight' && !e.shiftKey) nextPage();
    if (e.key === 'ArrowLeft' && !e.shiftKey) prevPage();
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
