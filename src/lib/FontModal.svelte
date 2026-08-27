<script>
  import { app } from './store.svelte.js';
  import { addFontFile, addFontFiles, removeUserFont, removeFontFace, FACE_SLOTS, SLOT_LABEL, isBold, isItalic } from './fonts.js';

  let { open = $bindable() } = $props();
  let fileInput;
  let slotInput;
  let dragOver = $state(false);
  // Chosen file overrides filename heuristics.
  let slotTarget = null;

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }
  function onPick(e) {
    addFontFiles(e.target.files);
    e.target.value = '';
  }
  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files?.length) addFontFiles(e.dataTransfer.files);
  }
  function pickForSlot(family, slot) {
    slotTarget = { family, slot };
    slotInput.click();
  }
  async function onSlotPick(e) {
    const file = e.target.files?.[0];
    const target = slotTarget;
    slotTarget = null;
    e.target.value = '';
    if (file && target) await addFontFile(file, target);
  }

  const faceStyle = (css, slot) =>
    `font-family:${css};font-weight:${isBold(slot) ? 700 : 400};font-style:${isItalic(slot) ? 'italic' : 'normal'}`;
  const realCount = (f) => FACE_SLOTS.filter((s) => f.faces?.[s]).length;
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
      <input bind:this={slotInput} type="file" accept=".ttf,.otf,.woff,.woff2" style="display:none" onchange={onSlotPick} />
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
          <div><b>Add Font</b> - drop or browse</div>
          <div class="sub">Drop a whole family at once - Regular, Bold, Italic and BoldItalic files group themselves</div>
        </div>
      </div>

      <div>
        <div class="font-group-label">User fonts · {app.fonts.user.length}</div>
        <div class="font-list">
          {#if app.fonts.user.length}
            {#each app.fonts.user as f (f.name)}
              <div class="font-family">
                <div class="ff-head">
                  <div class="fname">{f.name}</div>
                  <div class="ff-count">{realCount(f)} of 4 real faces</div>
                  <button class="del" title="Remove the whole family" onclick={() => removeUserFont(f.name)}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                <div class="ff-faces">
                  {#each FACE_SLOTS as slot (slot)}
                    <div class="ff-face" class:faux={!f.faces?.[slot]}>
                      <div class="ff-slot">{SLOT_LABEL[slot]}</div>
                      <div class="sample" style={faceStyle(f.css, slot)}>Kaboom 123</div>
                      {#if f.faces?.[slot]}
                        <div class="ff-file" title={f.faces[slot].file || ''}>{f.faces[slot].file || 'loaded'}</div>
                        <button class="del sm" title="Remove this face" onclick={() => removeFontFace(f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                      {:else}
                        <div class="ff-file faux-tag">faux - synthesised</div>
                        <button class="add sm" title="Use a real file for this face" onclick={() => pickForSlot(f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          {:else}
            <div class="qhint">No user fonts yet. Drop a .ttf/.otf/.woff2 above - it persists across reloads.</div>
          {/if}
        </div>

        <div class="font-group-label">Built-in fonts · {app.fonts.builtin.length}</div>
        <div class="font-list">
          {#each app.fonts.builtin as f (f.name)}
            <div class="font-family">
              <div class="ff-head">
                <div class="fname">{f.name}</div>
                <div class="ff-count">{realCount(f)} of 4 real faces</div>
                <span class="builtin-tag">built-in</span>
              </div>
              <div class="ff-faces">
                {#each FACE_SLOTS as slot (slot)}
                  <div class="ff-face" class:faux={!f.faces?.[slot]}>
                    <div class="ff-slot">{SLOT_LABEL[slot]}</div>
                    <div class="sample" style={faceStyle(f.css, slot)}>Kaboom 123</div>
                    <div class="ff-file" class:faux-tag={!f.faces?.[slot]}>{f.faces?.[slot] ? 'web font' : 'faux - synthesised'}</div>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>

<style>

  .font-family {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: hidden;
  }
  .ff-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .ff-head .fname {
    font-size: 13px;
    font-weight: 600;
  }
  .ff-count {
    font-size: 11px;
    color: var(--t3);
    margin-right: auto;
  }
  .ff-faces {
    display: flex;
    flex-direction: column;
  }
  .ff-face {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
  }
  .ff-face + .ff-face {
    border-top: 1px solid var(--line);
  }
  .ff-face.faux {
    background: var(--panel2);
  }
  .ff-slot {
    flex: 0 0 78px;
    font-size: 11px;
    color: var(--t2);
  }
  .ff-face .sample {
    flex: 1 1 auto;
    font-size: 20px;
    color: var(--text);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ff-face.faux .sample {
    color: var(--t2);
  }
  .ff-file {
    flex: 0 0 150px;
    font-size: 11px;
    color: var(--t3);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: right;
  }
  .faux-tag {
    color: var(--warn);
  }
  .add {
    flex: 0 0 auto;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sm {
    width: 24px;
    height: 24px;
  }
  .ff-head .del {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .ff-head .del:hover {
    border-color: var(--warn);
    color: var(--warn);
  }
  .ff-face .del {
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .ff-face .del:hover {
    border-color: var(--warn);
    color: var(--warn);
  }
</style>
