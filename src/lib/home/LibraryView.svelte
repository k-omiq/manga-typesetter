<script>
  import { onMount } from 'svelte';
  import { library, scanLibrary, createProject, deleteProject } from '../library.svelte.js';
  import { goProject } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';
  import { plural } from '../format.js';
  import ProjectCard from './ProjectCard.svelte';

  let { onNewChapter, onImportPsd } = $props();

  let confirmingId = $state(null); // inline two-step delete confirm
  let naming = $state(false);
  let newName = $state('');
  // How this project's chapters are read, and the one thing about a project that
  // cannot be changed after it exists — see `createProject`. Offered here rather
  // than buried in settings for exactly that reason.
  let layout = $state('pages');

  onMount(scanLibrary);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    naming = false;
    newName = '';
    const chosen = layout;
    layout = 'pages';
    // Every other mutation on this screen reports its own failure; a create
    // that throws must not become a silent unhandled rejection.
    try {
      const p = await createProject(name, { layout: chosen });
      goProject(p.id);
    } catch (e) {
      toast(`Could not create ${name}: ${e?.message ?? e}`);
    }
  }

  function pageCountOf(project) {
    return project.chapters.reduce((n, c) => n + c.pageCount, 0);
  }

  async function onDelete(project) {
    if (confirmingId !== project.id) {
      confirmingId = project.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteProject(project.id);
      toast(`Deleted ${project.name}`);
    } catch (e) {
      toast(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

<div class="home-actions">
  <button class="accent-btn" onclick={onNewChapter}>New chapter</button>
  {#if naming}
    <input
      class="name-input"
      placeholder="Project name"
      bind:value={newName}
      onkeydown={(e) => e.key === 'Enter' && onCreate()}
      autofocus
    />
    <!-- Pages is a chapter you turn a page at a time; Longstrip is a webtoon —
         every page of the chapter stacked into one column with no gaps, which
         is how the art was cut and how it has to be read back. Chosen here
         because it cannot be chosen later. -->
    <div class="seg new-layout">
      <button class:on={layout === 'pages'} onclick={() => (layout = 'pages')}>Pages</button>
      <button class:on={layout === 'longstrip'} onclick={() => (layout = 'longstrip')}>Longstrip</button>
    </div>
    <button class="soft-btn wide" onclick={onCreate}>Create</button>
  {:else}
    <button class="soft-btn wide" onclick={() => (naming = true)}>New project</button>
  {/if}
  <button class="soft-btn wide" onclick={onImportPsd}>Import chapter from PSD</button>
</div>

<div class="section-label">PROJECTS</div>

{#if library.error}
  <div class="home-error" role="alert">
    <div>{library.error}</div>
    <button class="soft-btn" onclick={scanLibrary}>Try again</button>
  </div>
{/if}

{#if library.projects.length}
  <div class="pgrid">
    {#each library.projects as project (project.id)}
      <ProjectCard
        {project}
        onOpen={(p) => goProject(p.id)}
        onDelete={onDelete}
      />
      {#if confirmingId === project.id}
        <div class="confirm-note warn" role="alert">
          Deletes the folder and every chapter in it — {plural(pageCountOf(project), 'page')}. No
          undo. Click Delete again to confirm.
        </div>
      {/if}
    {/each}
  </div>
{:else if library.loading}
  <!-- A scan in flight must say so. Rendering nothing here is what made a
       stalled scan look exactly like a library with nothing in it. -->
  <div class="home-empty">Reading your library…</div>
{:else if !library.error}
  <!-- Only claim the library is empty when it was actually read. -->
  <div class="home-empty">
    <div>No projects yet.</div>
    <div>Start a chapter and the raws you pick will be copied into your library.</div>
  </div>
{/if}
