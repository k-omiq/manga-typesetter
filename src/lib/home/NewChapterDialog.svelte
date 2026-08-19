<script>
  // New chapter creation dialog (file import or PSD reconstruction).
  import { untrack } from 'svelte';
  import { library, createProject, createChapter, createChapterFromPages } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickImageFiles, pickJsonFile, readTranslations } from '../importer.js';
  import { chapterPagesFromPsdFiles, pickPsdFiles } from '../psd.js';
  import { toast } from '../store.svelte.js';
  import { plural } from '../format.js';

  // In-flight creation blocks dismissal.
  let { open = $bindable(), busy = $bindable(false), projectId = null, mode = 'files' } = $props();

  let target = $state('');
  let newProjectName = $state('');
  let number = $state(1);
  let title = $state('');
  let files = $state([]);
  let cleaned = $state([]);
  let psdFiles = $state([]);
  let translations = $state(null); // { name, pages } from a picked JSON
  let error = $state('');
  // Chapter workflow mode.
  let workflow = $state('typeset');
  // Project layout selection.
  let newProjectLayout = $state('pages');

  const isPsd = $derived(mode === 'psd');

  function nextNumberFor(id) {
    const p = library.projects.find((x) => x.id === id);
    return p ? (p.chapters.at(-1)?.number ?? 0) + 1 : 1;
  }

  // Reset dialog state on open.
  $effect(() => {
    if (!open) return;
    const pid = projectId;
    mode;
    untrack(() => {
      target = pid ?? library.projects.find((p) => !p.unreadable)?.id ?? '__new__';
      number = nextNumberFor(target);
      title = '';
      files = [];
      cleaned = [];
      psdFiles = [];
      translations = null;
      error = '';
      newProjectName = '';
      newProjectLayout = 'pages';
      workflow = 'typeset';
    });
  });

  function onTargetChange() {
    number = nextNumberFor(target);
  }

  // Native file pickers (Tauri only).
  async function picking(label, fn) {
    try {
      await fn();
    } catch (e) {
      error = `${label} — ${e?.message ?? e}`;
    }
  }

  const PICKER = 'Could not open the file picker';

  const pickRaws = () =>
    picking(PICKER, async () => {
      const picked = await pickImageFiles(true);
      if (picked) files = [...picked];
    });

  const pickCleaned = () =>
    picking(PICKER, async () => {
      const picked = await pickImageFiles(true);
      if (picked) cleaned = [...picked];
    });

  const pickPsds = () =>
    picking(PICKER, async () => {
      const picked = await pickPsdFiles();
      if (picked) psdFiles = [...picked];
    });

  const pickTranslations = () =>
    picking('Could not read that translations file', async () => {
      const picked = await pickJsonFile();
      if (!picked || !picked[0]) return;
      // Validate translation JSON on selection.
      translations = { name: picked[0].name, pages: await readTranslations(picked[0]) };
    });

  // Preview positional page count.
  const summary = $derived.by(() => {
    if (isPsd) {
      if (!psdFiles.length) return [];
      return [{ text: `${plural(psdFiles.length, 'PSD')} — one page each.`, warn: false }];
    }
    if (!files.length) return [];
    const notes = [{ text: `${plural(files.length, 'page')} in this chapter.`, warn: false }];

    if (!cleaned.length) {
      notes.push({ text: 'No cleaned pages — every page typesets on its raw.', warn: false });
    } else if (cleaned.length === files.length) {
      notes.push({ text: `All ${files.length} pages will use a cleaned image.`, warn: false });
    } else if (cleaned.length < files.length) {
      notes.push({
        text: `${cleaned.length} of ${files.length} pages will use a cleaned image; pages ${cleaned.length + 1}–${files.length} keep their raw.`,
        warn: true,
      });
    } else {
      notes.push({
        text: `${files.length} cleaned images pair with a page; the last ${cleaned.length - files.length} are ignored.`,
        warn: true,
      });
    }

    if (translations) {
      const covered = Math.min(translations.pages.length, files.length);
      const lines = translations.pages.slice(0, covered).reduce((n, pg) => n + pg.lines.length, 0);
      if (translations.pages.length === files.length) {
        notes.push({ text: `Translations for all ${files.length} pages — ${plural(lines, 'line')}.`, warn: false });
      } else if (translations.pages.length < files.length) {
        notes.push({
          text: `Translations cover pages 1–${translations.pages.length} of ${files.length} — ${plural(lines, 'line')}.`,
          warn: true,
        });
      } else {
        notes.push({
          text: `Translations describe ${translations.pages.length} pages; the last ${translations.pages.length - files.length} are ignored.`,
          warn: true,
        });
      }
    }
    return notes;
  });

  async function submit() {
    error = '';
    if (isPsd ? !psdFiles.length : !files.length) {
      error = isPsd ? 'Pick at least one PSD.' : 'Pick at least one raw page.';
      return;
    }
    if (target === '__new__' && !newProjectName.trim()) {
      error = 'Name the new project.';
      return;
    }
    // Default chapter number to 1.
    const n = number === null || number === undefined || number === '' ? 1 : Number(number);
    if (!Number.isFinite(n) || n < 0) {
      error = 'Enter a valid chapter number.';
      return;
    }
    busy = true;

    let createdProject = null;
    try {
      if (target === '__new__') {
        createdProject = await createProject(newProjectName.trim(), { layout: newProjectLayout });
      }
      const pid = createdProject ? createdProject.id : target;

      let chapter;
      let note;
      if (isPsd) {
        const { pages, lossless, cleanedOnly, problems } = await chapterPagesFromPsdFiles(psdFiles);
        if (!pages.length) {
          throw new Error(problems.join(' · ') || 'No pages could be read from those files');
        }
        chapter = await createChapterFromPages({ projectId: pid, number: n, title, pages });
        note = `${plural(pages.length, 'page')} from PSD (${lossless} lossless)`;
        if (problems.length) note += ` · skipped ${problems.length}`;
        // PSD reconstruction uses raster layers.
        if (cleanedOnly) note += ` · ${cleanedOnly} with no separate raw`;
      } else {
        chapter = await createChapter({
          projectId: pid,
          number: n,
          title,
          files,
          cleanedFiles: cleaned,
          translations: translations?.pages ?? null,
          mode: workflow,
        });
        note = `${plural(files.length, 'page')} copied`;
        if (cleaned.length) note += ` · ${Math.min(cleaned.length, files.length)} cleaned`;
      }
      open = false;
      toast(`Created chapter ${chapter.number} · ${note}`);
      await goEditor(pid, chapter.id);
    } catch (e) {

      const orphan = createdProject
        ? ` The project "${createdProject.name}" was created and is now empty.`
        : '';
      error = `Could not create the chapter — ${e?.message ?? e}.${orphan}`;

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
      <div class="modal-head">{isPsd ? 'Import chapter from PSD' : 'New chapter'}</div>

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

        <div class="field">
          <span>Layout</span>
          <div class="seg">
            <button class:on={newProjectLayout === 'pages'} onclick={() => (newProjectLayout = 'pages')} disabled={busy}>Pages</button>
            <button class:on={newProjectLayout === 'longstrip'} onclick={() => (newProjectLayout = 'longstrip')} disabled={busy}>Longstrip</button>
          </div>
        </div>
      {/if}

      <label class="field">
        <span>Chapter number</span>
        <input type="number" min="0" bind:value={number} />
      </label>

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Optional" />
      </label>

      {#if isPsd}
        <div class="field">
          <span>PSD files</span>
          <button class="soft-btn" onclick={pickPsds} disabled={busy}>
            {psdFiles.length ? `${psdFiles.length} selected — change` : 'Choose files…'}
          </button>
        </div>
        <div class="pair-note warn">
          A PSD holds rasters, not the files they came from, so these pages are written as new
          PNGs. Every other page in your library keeps its original bytes.
        </div>
      {:else}

        <div class="field">
          <span>Mode</span>
          <div class="seg">
            <button class:on={workflow === 'typeset'} onclick={() => (workflow = 'typeset')} disabled={busy}>Typeset</button>
            <button class:on={workflow === 'translate'} onclick={() => (workflow = 'translate')} disabled={busy}>Translate</button>
          </div>
        </div>

        <div class="field">
          <span>Raw pages</span>
          <button class="soft-btn" onclick={pickRaws} disabled={busy}>
            {files.length ? `${files.length} selected — change` : 'Choose files…'}
          </button>
        </div>

        <div class="field">
          <span>Cleaned pages</span>
          <button class="soft-btn" onclick={pickCleaned} disabled={busy}>
            {cleaned.length ? `${cleaned.length} selected — change` : 'Choose files…'}
          </button>
          {#if cleaned.length}
            <button class="soft-btn slim" onclick={() => (cleaned = [])} disabled={busy}>Clear</button>
          {/if}
        </div>

        <div class="field">
          <span>Translations</span>
          <button class="soft-btn" onclick={pickTranslations} disabled={busy}>
            {translations ? `${translations.name} — change` : 'Choose a JSON…'}
          </button>
          {#if translations}
            <button class="soft-btn slim" onclick={() => (translations = null)} disabled={busy}>Clear</button>
          {/if}
        </div>
      {/if}

      {#each summary as note}
        <div class="pair-note" class:warn={note.warn}>{note.text}</div>
      {/each}

      {#if error}<div class="home-error">{error}</div>{/if}

      <div class="modal-foot">
        <button class="soft-btn" onclick={() => (open = false)} disabled={busy}>Cancel</button>
        <button class="accent-btn narrow" onclick={submit} disabled={busy}>
          {busy ? (isPsd ? 'Importing…' : 'Copying…') : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}
