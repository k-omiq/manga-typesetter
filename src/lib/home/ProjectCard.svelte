<script>
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { relativeTime, plural } from '../format.js';
  import { joinPath } from '../paths.js';

  let { project, onOpen, onDelete } = $props();

  const thumb = $derived(convertFileSrc(joinPath(project.dir, 'thumb.png')));
  const chapterLine = $derived(plural(project.chapters.length, 'chapter'));
  const pageCount = $derived(project.chapters.reduce((n, c) => n + c.pageCount, 0));
  // Format chapter count and relative timestamp.
  const touched = $derived(relativeTime(project.updatedAt));
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
      <div class="pcard-sub small">{plural(pageCount, 'page')}{touched ? ` · ${touched}` : ''}</div>
    {/if}
  </div>
  <button class="pcard-del" onclick={() => onDelete(project)} title="Delete project">Delete</button>
</div>
