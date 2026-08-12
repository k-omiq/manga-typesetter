<script>
  import { convertFileSrc } from '@tauri-apps/api/core';

  let { project, onOpen, onDelete } = $props();

  const thumb = $derived(convertFileSrc(`${project.dir}/thumb.png`));
  const chapterLine = $derived(
    project.chapters.length === 1 ? '1 chapter' : `${project.chapters.length} chapters`,
  );
  const pageCount = $derived(project.chapters.reduce((n, c) => n + c.pageCount, 0));
</script>

<div class="pcard" class:unreadable={project.unreadable}>
  <button class="pcard-cover" onclick={() => onOpen(project)} disabled={project.unreadable}>
    {#if !project.unreadable}
      <img src={thumb} alt="" onerror={(e) => (e.currentTarget.style.visibility = 'hidden')} />
    {/if}
  </button>
  <div class="pcard-meta">
    <div class="pcard-name">{project.name}</div>
    {#if project.duplicate}
      <div class="pcard-sub warn">Same project as another folder — rename or remove {project.slug}</div>
    {:else if project.unreadable}
      <div class="pcard-sub warn">Unreadable — check this folder</div>
    {:else}
      <div class="pcard-sub">{chapterLine}</div>
      <div class="pcard-sub small">{pageCount} pages</div>
    {/if}
  </div>
  <button class="pcard-del" onclick={() => onDelete(project)} title="Delete project">Delete</button>
</div>
