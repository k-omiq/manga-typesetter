<script>
  import { app } from './store.svelte.js';
  import { addFontFile, removeUserFont } from './fonts.js';

  let { open = $bindable() } = $props();
  let fileInput;
  let dragOver = $state(false);

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }
  async function handleFiles(files) {
    for (const f of files) await addFontFile(f);
  }
  function onPick(e) {
    handleFiles(e.target.files);
    e.target.value = '';
  }
  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
      <h3>Font Library</h3>
      <button class="x" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">
      <input bind:this={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2" multiple style="display:none" onchange={onPick} />
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div
        class="font-dropzone"
        class:drag={dragOver}
        onclick={() => fileInput.click()}
        ondragover={(e) => { e.preventDefault(); dragOver = true; }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
        <div style="text-align:left">
          <div><b>Add Font</b> — drop or browse</div>
          <div class="sub">Accepts .ttf · .otf · .woff · .woff2</div>
        </div>
      </div>

      <div>
        <div class="font-group-label">Built-in fonts · {app.fonts.builtin.length}</div>
        <div class="font-list">
          {#each app.fonts.builtin as f (f.name)}
            <div class="font-card">
              <div class="meta"><div class="fname">{f.name}</div><div class="ffile">system</div></div>
              <div class="sample" style="font-family:{f.css}">The quick brown fox 123</div>
              <span class="builtin-tag">built-in</span>
            </div>
          {/each}
        </div>

        <div class="font-group-label">User fonts · {app.fonts.user.length}</div>
        <div class="font-list">
          {#if app.fonts.user.length}
            {#each app.fonts.user as f (f.name)}
              <div class="font-card">
                <div class="meta"><div class="fname">{f.name}</div><div class="ffile">{f.file || ''}</div></div>
                <div class="sample" style="font-family:{f.css}">The quick brown fox 123</div>
                <button class="del" title="Remove font" onclick={() => removeUserFont(f.name)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
            {/each}
          {:else}
            <div class="qhint">No user fonts yet. Drop a .ttf/.otf/.woff2 above — it persists across reloads.</div>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
