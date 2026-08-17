<script>
  import { projectById, deleteChapter, setChapterMode } from '../library.svelte.js';
  import { route, goLibrary, goEditor } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';
  import { relativeTime, plural } from '../format.js';

  let { onNewChapter, onImportPsd, onSources } = $props();

  // Slice 1 knows two facts about a chapter: whether it has pages, and whether
  // anything has been placed on them. Three states, no progress model — a
  // percentage would be a number this app cannot honestly produce yet.
  function status(c) {
    if (!c.pageCount) return { mark: '·', label: 'No pages', on: false };
    if (!c.typeset) return { mark: '○', label: 'Raws only', on: false };
    return { mark: '●', label: 'Typeset', on: true };
  }

  const project = $derived(projectById(route.projectId));
  const pageTotal = $derived((project?.chapters ?? []).reduce((n, c) => n + c.pageCount, 0));

  let confirmingId = $state(null);
  // The row whose mode is being written, so a slow disk cannot be clicked twice
  // into two writes of the same file.
  let switchingId = $state(null);

  // The chapter's workflow mode, switched from the row rather than from inside
  // the editor: it decides what the editor *is* when it opens, and a control
  // that reshapes the window you are looking at belongs on the screen you choose
  // the chapter from. Two states, so the badge is the switch — a menu for a
  // binary would be one more click for no more choice.
  //
  // A chapter that is currently open takes a different path inside
  // `setChapterMode` (the state changes and autosave persists it), so this works
  // either way and the caller does not have to know which.
  async function onToggleMode(c) {
    if (switchingId) return;
    switchingId = c.id;
    const next = c.mode === 'translate' ? 'typeset' : 'translate';
    try {
      await setChapterMode(project.id, c.id, next);
      toast(`Chapter ${c.number} is now a ${next} chapter`);
    } catch (e) {
      toast(`Could not change the mode: ${e?.message ?? e}`);
    } finally {
      switchingId = null;
    }
  }

  async function onDelete(chapter) {
    if (confirmingId !== chapter.id) {
      confirmingId = chapter.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteChapter(project.id, chapter.id);
      toast(`Deleted chapter ${chapter.number}`);
    } catch (e) {
      toast(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

{#if project}
  <button class="back-link" onclick={goLibrary}>← Projects</button>

  <div class="project-head">
    <div class="project-title">
      <div class="project-name">{project.name}</div>
      <div class="project-meta">
        {plural(project.chapters.length, 'chapter')} · {plural(pageTotal, 'page')}
      </div>
    </div>
    <button class="soft-btn" onclick={() => onImportPsd(project.id)}>Import from PSD</button>
    <button class="soft-btn" onclick={() => onNewChapter(project.id)}>New chapter</button>
  </div>

  <div class="section-label spaced">CHAPTERS</div>

  <div class="chapter-table">
    {#each project.chapters as c (c.id)}
      <div class="chapter-row" class:unreadable={c.unreadable}>
        <button
          class="chapter-open"
          onclick={() => goEditor(project.id, c.id)}
          disabled={c.unreadable}
        >
          <div class="chapter-mark" class:on={!c.unreadable && status(c).on} aria-hidden="true">
            {c.unreadable ? '—' : status(c).mark}
          </div>
          <div class="chapter-num">{c.unreadable ? '—' : c.number}</div>
          <div class="chapter-title">
            {#if c.duplicate}
              <div class="warn">Same chapter as another folder</div>
              <div class="chapter-sub">{c.slug} — rename or remove the copy</div>
            {:else if c.unreadable}
              <div class="warn">Unreadable chapter</div>
              <div class="chapter-sub">{c.slug} — check this folder</div>
            {:else}
              <div>{c.title || `Chapter ${c.number}`}</div>
              <div class="chapter-sub">{c.slug}</div>
            {/if}
          </div>
          <div class="chapter-chip">{c.unreadable ? '' : status(c).label}</div>
          <div class="chapter-pages">{c.unreadable ? '' : plural(c.pageCount, 'page')}</div>
          <div class="chapter-time">{c.unreadable ? '' : relativeTime(c.updatedAt)}</div>
        </button>
        <button
          class="chapter-act chapter-mode"
          class:on={c.mode === 'translate'}
          onclick={() => onToggleMode(c)}
          disabled={c.unreadable || switchingId === c.id}
          title={c.mode === 'translate'
            ? 'Opens as a translation workspace — click to typeset instead'
            : 'Opens as the full typesetting editor — click to translate instead'}
          >{c.mode === 'translate' ? 'Translate' : 'Typeset'}</button
        >
        <button
          class="chapter-act"
          onclick={() => onSources(project.id, c.id)}
          disabled={c.unreadable}
          title="Cleaned pages and translations">Sources</button
        >
        <button class="chapter-del" onclick={() => onDelete(c)} title="Delete chapter">Delete</button>
      </div>
      {#if confirmingId === c.id}
        <div class="confirm-note warn" role="alert">
          Deletes this chapter's folder, including its {plural(c.pageCount, 'copied raw')}. No undo. Click Delete again to confirm.
        </div>
      {/if}
    {:else}
      <div class="home-empty">No chapters yet.</div>
    {/each}
  </div>
{:else}
  <div class="home-empty">That project is no longer in the library.</div>
{/if}
