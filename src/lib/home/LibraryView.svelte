<script>
  import { onMount } from 'svelte';
  import { library, scanLibrary, createProject, deleteProject } from '../library.svelte.js';
  import { goProject } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';
  import ProjectCard from './ProjectCard.svelte';

  let { onNewChapter } = $props();

  let confirmingId = $state(null); // inline two-step delete confirm
  let naming = $state(false);
  let newName = $state('');

  onMount(scanLibrary);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    naming = false;
    newName = '';
    const p = await createProject(name);
    goProject(p.id);
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
    <button class="soft-btn wide" onclick={onCreate}>Create</button>
  {:else}
    <button class="soft-btn wide" onclick={() => (naming = true)}>New project</button>
  {/if}
</div>

<div class="section-label">PROJECTS</div>

{#if library.error}
  <div class="home-error">{library.error}</div>
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
          Deletes the folder and every chapter in it — {pageCountOf(project)} pages. No undo. Click
          Delete again to confirm.
        </div>
      {/if}
    {/each}
  </div>
{:else if !library.loading}
  <div class="home-empty">
    <div>No projects yet.</div>
    <div>Start a chapter and the raws you pick will be copied into your library.</div>
  </div>
{/if}
