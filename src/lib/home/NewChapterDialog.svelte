<script>
  // Reachable from both the library root and a project screen, so it can create
  // the project too — otherwise the library's primary button is dead on an
  // empty library.
  import { untrack } from 'svelte';
  import { library, createProject, createChapter } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickFilesTauri } from '../importer.js';
  import { toast } from '../store.svelte.js';

  let { open = $bindable(), projectId = null } = $props();

  let target = $state('');
  let newProjectName = $state('');
  let number = $state(1);
  let title = $state('');
  let files = $state([]);
  let busy = $state(false);
  let error = $state('');

  function nextNumberFor(id) {
    const p = library.projects.find((x) => x.id === id);
    return p ? (p.chapters.at(-1)?.number ?? 0) + 1 : 1;
  }

  // Only `open` and `projectId` may reset the form. Everything the body touches
  // is untracked: reading `target` here would make picking a different project
  // in the select re-run this and silently throw away the files already chosen.
  $effect(() => {
    if (!open) return;
    const pid = projectId;
    untrack(() => {
      target = pid ?? library.projects.find((p) => !p.unreadable)?.id ?? '__new__';
      number = nextNumberFor(target);
      title = '';
      files = [];
      error = '';
      newProjectName = '';
    });
  });

  function onTargetChange() {
    number = nextNumberFor(target);
  }

  async function pickRaws() {
    const picked = await pickFilesTauri({
      name: 'Images',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
      multiple: true,
    });
    if (picked) files = [...picked];
  }

  async function submit() {
    error = '';
    if (!files.length) {
      error = 'Pick at least one raw page.';
      return;
    }
    if (target === '__new__' && !newProjectName.trim()) {
      error = 'Name the new project.';
      return;
    }
    busy = true;
    try {
      const pid =
        target === '__new__' ? (await createProject(newProjectName.trim())).id : target;
      const chapter = await createChapter({ projectId: pid, number: Number(number), title, files });
      open = false;
      toast(`Created chapter ${chapter.number} · ${files.length} pages copied`);
      await goEditor(pid, chapter.id);
    } catch (e) {
      error = `Could not create the chapter — ${e?.message ?? e}`;
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal dialog-narrow">
      <div class="modal-head">New chapter</div>

      <label class="field">
        <span>Project</span>
        <select bind:value={target} onchange={onTargetChange}>
          {#each library.projects.filter((p) => !p.unreadable) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="__new__">New project…</option>
        </select>
      </label>

      {#if target === '__new__'}
        <label class="field">
          <span>Project name</span>
          <input bind:value={newProjectName} placeholder="Series name" />
        </label>
      {/if}

      <label class="field">
        <span>Chapter number</span>
        <input type="number" min="0" bind:value={number} />
      </label>

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Optional" />
      </label>

      <div class="field">
        <span>Raw pages</span>
        <button class="soft-btn" onclick={pickRaws} disabled={busy}>
          {files.length ? `${files.length} selected — change` : 'Choose files…'}
        </button>
      </div>

      {#if error}<div class="home-error">{error}</div>{/if}

      <div class="modal-foot">
        <button class="soft-btn" onclick={() => (open = false)} disabled={busy}>Cancel</button>
        <button class="accent-btn narrow" onclick={submit} disabled={busy}>
          {busy ? 'Copying…' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}
