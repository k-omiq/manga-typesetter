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
  import { checkSidecar } from './lib/sidecar.js';
  import { initTheme } from './lib/theme.svelte.js';
  import { initRoot, openChapter } from './lib/library.svelte.js';
  import { route, goBack } from './lib/route.svelte.js';

  let fontModalOpen = $state(false);
  let settingsOpen = $state(false);
  let newChapterOpen = $state(false);
  let newChapterProject = $state(null);
  // The library root is resolved asynchronously. Nothing that scans the library
  // may mount before it is known — a child's onMount runs before its parent's,
  // so LibraryView would otherwise scan an empty path and report an error.
  let booted = $state(false);

  onMount(async () => {
    initTheme();
    await initRoot();
    booted = true;
    restoreFonts();
    // Probe the Python sidecar (only meaningful under Tauri; no-op in the browser).
    checkSidecar().then((h) => {
      if (h) toast(`Sidecar ready · ${h.device}`);
    });
  });

  // Hydrate the editor whenever the route lands on a chapter. The guard read is
  // untracked on purpose: openChapter writes app.chapterRef, so tracking it here
  // would make this effect its own trigger. Its only dependency is the route.
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
      if (newChapterOpen) return (newChapterOpen = false);
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

<NewChapterDialog bind:open={newChapterOpen} projectId={newChapterProject} />
<FontModal bind:open={fontModalOpen} />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
