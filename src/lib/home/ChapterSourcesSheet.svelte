<script>
  // Where a chapter's inputs are managed after creation: which raw each page
  // is, which cleaned image it typesets on, and the lines a translations file
  // supplies.
  //
  // Everything here writes through library.svelte.js, which refuses outright
  // while the chapter is open in the editor — editing a chapter's files
  // underneath the open document is how slice 1 lost data twice.
  import { untrack } from 'svelte';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import {
    chapterById,
    readChapterSources,
    replaceCleanedPages,
    setPageCleaned,
    clearPageCleaned,
    removeAllCleaned,
    applyTranslations,
  } from '../library.svelte.js';
  import { pickImageFiles, pickJsonFile, readTranslations } from '../importer.js';
  import { toast } from '../store.svelte.js';
  import { plural } from '../format.js';

  // `busy` is bindable so the app-level Escape handler can refuse to dismiss
  // the sheet mid-copy, matching the overlay guard below.
  let { open = $bindable(), busy = $bindable(false), projectId = null, chapterId = null } = $props();

  let sources = $state(null); // { rawsDir, cleanedDir, pages }
  let error = $state('');
  let pendingBulk = $state(null); // files picked for a bulk replace, awaiting Apply
  let confirmingRemoveAll = $state(false);

  const chapter = $derived(projectId && chapterId ? chapterById(projectId, chapterId) : null);
  const pages = $derived(sources?.pages ?? []);
  const cleanedCount = $derived(pages.filter((pg) => pg.cleaned).length);
  const missingCount = $derived(pages.filter((pg) => pg.missing).length);

  // Reload whenever the sheet is opened on a chapter, and drop what it read on
  // the way out so a later open cannot render the previous chapter's pages.
  //
  // Untracked, like the new-chapter dialog's reset: readChapterSources reads the
  // catalogue, so tracking it would let any catalogue write re-run this and
  // silently discard a bulk selection the user had staged.
  $effect(() => {
    if (!open || !projectId || !chapterId) {
      sources = null;
      return;
    }
    const pid = projectId;
    const cid = chapterId;
    untrack(() => reload(pid, cid));
  });

  // Every read takes a ticket, the way scanLibrary does. readChapterSources
  // costs one existence check per cleaned page, so a long chapter's read
  // routinely lands after a short one started later — and page ids are
  // per-chapter integers, so painting chapter A's rows under chapter B's id
  // would aim Remove at B's page of the same number. Only the newest read may
  // put its result anywhere.
  let readSeq = 0;

  async function read(pid, cid) {
    const token = ++readSeq;
    const next = await readChapterSources(pid, cid);
    if (token !== readSeq) return null;
    sources = next;
    return next;
  }

  async function reload(pid, cid) {
    error = '';
    pendingBulk = null;
    confirmingRemoveAll = false;
    try {
      await read(pid, cid);
    } catch (e) {
      // A superseded read's failure describes a chapter that is no longer on
      // screen, and reporting it would blank one that read perfectly well.
      if (pid !== projectId || cid !== chapterId) return;
      sources = null;
      error = `Could not read this chapter — ${e?.message ?? e}`;
    }
  }

  // Every mutation runs the same way: block the sheet, do it, say what happened,
  // then re-read from disk so what is on screen is what is in the record. The
  // re-read is aimed at the chapter the mutation was aimed at, not at whatever
  // the props say by the time it lands.
  async function run(pid, cid, fn) {
    if (busy) {
      // Never drop a requested action in silence — the user picked a file for it.
      toast('Still working on the last change — try again in a moment');
      return;
    }
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = `${e?.message ?? e}`;
      toast(error);
    } finally {
      try {
        await read(pid, cid);
      } catch {
        /* the error above already says what went wrong */
      }
      // Released last, so nothing else can start against the state this one is
      // still re-reading.
      busy = false;
    }
  }

  // The picker is Tauri-only, so a click outside the desktop app would otherwise
  // be a silent unhandled rejection. `label` names the step that failed —
  // an unreadable translations file must not be reported as a picker failure.
  async function picking(label, fn) {
    try {
      await fn();
    } catch (e) {
      error = `${label} — ${e?.message ?? e}`;
    }
  }

  const pickBulk = () =>
    picking('Could not open the file picker', async () => {
      const picked = await pickImageFiles(true);
      if (picked) pendingBulk = [...picked];
    });

  // Positional, exactly as at creation: the Nth picked file pairs with the Nth
  // page. Stated in full before the user commits, because a mismatched count is
  // the one thing this rule cannot survive silently.
  const bulkNotes = $derived.by(() => {
    if (!pendingBulk) return [];
    const n = Math.min(pendingBulk.length, pages.length);
    const notes = [];
    if (pendingBulk.length < pages.length) {
      notes.push({
        text: `Pages 1–${n} get a cleaned image; pages ${n + 1}–${pages.length} keep what they have.`,
        warn: true,
      });
    } else if (pendingBulk.length > pages.length) {
      notes.push({
        text: `${pages.length} of ${pendingBulk.length} images pair with a page; the last ${pendingBulk.length - pages.length} are ignored.`,
        warn: true,
      });
    } else {
      notes.push({ text: `All ${pages.length} pages get a cleaned image.`, warn: false });
    }
    const replaced = pages.slice(0, n).filter((pg) => pg.cleaned).length;
    if (replaced) {
      notes.push({
        text: `${plural(replaced, 'page')} already ${replaced === 1 ? 'has' : 'have'} a cleaned image. Applying replaces ${replaced === 1 ? 'it' : 'them'} — the old ${replaced === 1 ? 'file is' : 'files are'} deleted. No undo.`,
        warn: true,
      });
    }
    return notes;
  });

  async function applyBulk() {
    const files = pendingBulk;
    if (!files?.length) return;
    const pid = projectId;
    const cid = chapterId;
    await run(pid, cid, async () => {
      const { replaced, ignored } = await replaceCleanedPages(pid, cid, files);
      // Cleared only once it worked. A failed apply keeps the selection rather
      // than sending the user back to re-pick two hundred files.
      pendingBulk = null;
      toast(
        `Set the cleaned image on ${plural(replaced, 'page')}${ignored ? ` · ${ignored} ignored` : ''}`,
      );
    });
  }

  function onRemoveAll() {
    if (!confirmingRemoveAll) {
      confirmingRemoveAll = true;
      return;
    }
    confirmingRemoveAll = false;
    const pid = projectId;
    const cid = chapterId;
    return run(pid, cid, async () => {
      const n = await removeAllCleaned(pid, cid);
      toast(`Removed the cleaned image from ${plural(n, 'page')}`);
    });
  }

  // Which chapter this is aimed at is captured BEFORE the picker's await, along
  // with the page it names. Both come from the sheet as it was when the user
  // clicked; resolving them afterwards would aim the write at whatever the
  // sheet has become.
  const onAddTranslations = () => {
    const pid = projectId;
    const cid = chapterId;
    return picking('Could not read that translations file', async () => {
      const picked = await pickJsonFile();
      if (!picked || !picked[0]) return;
      const parsed = await readTranslations(picked[0]);
      await run(pid, cid, async () => {
        const { covered, kept, ignored, lines, orphaned } = await applyTranslations(pid, cid, parsed);
        const notes = [];
        if (kept) notes.push(`${plural(kept, 'later page')} left unchanged`);
        if (ignored) notes.push(`${plural(ignored, 'page')} past the end ignored`);
        // A placed box follows its line by number. If the new file numbers its
        // lines differently, those boxes have nothing to say any more — say so
        // rather than let the user find blank boxes later.
        if (orphaned) notes.push(`${plural(orphaned, 'placed box')} no longer matches a line`);
        toast(
          `Applied ${plural(lines, 'line')} to ${plural(covered, 'page')}${notes.length ? ' — ' + notes.join(' · ') : ''}`,
        );
      });
    });
  };

  const onSetPage = (pg) => {
    const pid = projectId;
    const cid = chapterId;
    const n = pageNumber(pg);
    return picking('Could not open the file picker', async () => {
      const picked = await pickImageFiles(false);
      if (!picked || !picked[0]) return;
      await run(pid, cid, async () => {
        const name = await setPageCleaned(pid, cid, pg.id, picked[0]);
        toast(`Page ${n} now uses ${name}`);
      });
    });
  };

  const onClearPage = (pg) => {
    const pid = projectId;
    const cid = chapterId;
    const n = pageNumber(pg);
    return run(pid, cid, async () => {
      await clearPageCleaned(pid, cid, pg.id);
      toast(`Page ${n} is back on its raw`);
    });
  };

  const pageNumber = (pg) => pages.indexOf(pg) + 1;

  // The asset protocol serves the library directly, so a 200-page chapter costs
  // no memory here — the same route ProjectCard's cover already takes.
  const srcFor = (pg) =>
    convertFileSrc(`${pg.cleaned && !pg.missing ? sources.cleanedDir : sources.rawsDir}/${pg.cleaned && !pg.missing ? pg.cleaned : pg.file}`);
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal sources-sheet">
      <div class="modal-head">
        <h3>Sources · {chapter ? chapter.title || `Chapter ${chapter.number}` : 'Chapter'}</h3>
        <button class="x" onclick={() => (open = false)} disabled={busy} aria-label="Close">✕</button>
      </div>

      <div class="sources-meta">
        {plural(pages.length, 'page')} · {cleanedCount} with a cleaned image
        {#if missingCount}
          <span class="warn"> · {plural(missingCount, 'cleaned file')} missing from disk</span>
        {/if}
      </div>

      <div class="sources-bulk">
        <button class="soft-btn" onclick={pickBulk} disabled={busy || !pages.length}>
          Add or replace cleaned pages…
        </button>
        <button
          class="soft-btn"
          class:warn={confirmingRemoveAll}
          onclick={onRemoveAll}
          disabled={busy || !cleanedCount}
        >
          {confirmingRemoveAll ? 'Click again to remove' : 'Remove all cleaned pages'}
        </button>
        <button class="soft-btn" onclick={onAddTranslations} disabled={busy || !pages.length}>
          Add translations…
        </button>
      </div>

      {#if confirmingRemoveAll}
        <div class="pair-note warn" role="alert">
          Deletes the cleaned image on {plural(cleanedCount, 'page')} and puts every page back on its
          raw. The raws are untouched. No undo.
        </div>
      {/if}

      {#each bulkNotes as note}
        <div class="pair-note" class:warn={note.warn}>{note.text}</div>
      {/each}
      {#if pendingBulk}
        <div class="sources-bulk">
          <button class="accent-btn narrow" onclick={applyBulk} disabled={busy}>Apply</button>
          <button class="soft-btn" onclick={() => (pendingBulk = null)} disabled={busy}>Cancel</button>
        </div>
      {/if}

      {#if error}<div class="home-error" role="alert">{error}</div>{/if}

      <div class="sources-list">
        {#each pages as pg (pg.id)}
          <div class="sources-row">
            <div class="sources-idx">{pageNumber(pg)}</div>
            <div class="sources-thumb">
              {#if sources}
                <img
                  src={srcFor(pg)}
                  alt=""
                  loading="lazy"
                  onerror={(e) => (e.currentTarget.style.visibility = 'hidden')}
                />
              {/if}
            </div>
            <div class="sources-names">
              <code class="path">{pg.file}</code>
              {#if pg.missing}
                <code class="path warn">{pg.cleaned} — missing, using the raw</code>
              {:else if pg.cleaned}
                <code class="path">{pg.cleaned}</code>
              {:else}
                <span class="sources-none">no cleaned image</span>
              {/if}
            </div>
            <button class="soft-btn slim" onclick={() => onSetPage(pg)} disabled={busy}>Set cleaned…</button>
            <button
              class="soft-btn slim"
              onclick={() => onClearPage(pg)}
              disabled={busy || !pg.cleaned}
            >
              Remove
            </button>
          </div>
        {:else}
          <div class="home-empty">{error ? '' : 'This chapter has no pages.'}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}
