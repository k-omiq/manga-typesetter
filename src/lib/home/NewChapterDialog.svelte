<script>
  // Reachable from both the library root and a project screen, so it can create
  // the project too — otherwise the library's primary button is dead on an
  // empty library.
  import { untrack } from 'svelte';
  import { library, createProject, createChapter } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickFilesTauri } from '../importer.js';
  import { toast } from '../store.svelte.js';
  import { plural } from '../format.js';

  // `busy` is bindable so the app-level Escape handler can refuse to dismiss the
  // dialog mid-copy, matching the overlay and Cancel guards below.
  let { open = $bindable(), busy = $bindable(false), projectId = null } = $props();

  let target = $state('');
  let newProjectName = $state('');
  let number = $state(1);
  let title = $state('');
  let files = $state([]);
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
    // The picker is Tauri-only; outside the desktop app the import throws and the
    // click would otherwise be a silent unhandled rejection.
    try {
      const picked = await pickFilesTauri({
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
        multiple: true,
      });
      if (picked) files = [...picked];
    } catch (e) {
      error = `Could not open the file picker — ${e?.message ?? e}`;
    }
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
    // Set only when this submit created the project, so a later chapter failure
    // can name what it left behind in the library.
    let createdProject = null;
    try {
      if (target === '__new__') {
        createdProject = await createProject(newProjectName.trim());
      }
      const pid = createdProject ? createdProject.id : target;
      // An emptied number input binds null; that must mean 1, not chapter 000.
      // An explicit 0 is still honoured — chapter 0 prologues are a real thing.
      const n = number === null || number === undefined || number === '' ? 1 : Number(number);
      const chapter = await createChapter({ projectId: pid, number: n, title, files });
      open = false;
      toast(`Created chapter ${chapter.number} · ${plural(files.length, 'page')} copied`);
      await goEditor(pid, chapter.id);
    } catch (e) {
      // Deliberately not deleting `createdProject`: silently removing something
      // the user just named is worse than telling them it is there.
      const orphan = createdProject
        ? ` The project "${createdProject.name}" was created and is now empty.`
        : '';
      error = `Could not create the chapter — ${e?.message ?? e}.${orphan}`;
      // Also toasted, so the message survives the dialog being dismissed.
      toast(error);
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
