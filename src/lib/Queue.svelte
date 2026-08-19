<script>
  import {
    app,
    page,
    isPlaced,
    activateLine,
    lineText,
    markUnsaved,
    toggleTagOnLine,
    toast,
    isFreeLine,
    addTextBoxInView,
    autoFitBox,
    isTranslateMode,
  } from './store.svelte.js';
  import {
    knownTags,
    lineTags,
    hasTag,
    createTag,
    saveTagDefaults,
    deleteTag,
    tagFormFields,
    tagFormDefaults,
    findTag,
    normalizeTagName,
    MAX_TAG_LEN,
  } from './tags.svelte.js';
  import {
    createFieldUndo,
    resyncField,
    recordFieldEdit,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { modKey } from './format.js';

  const p = $derived(page());

  // Undo/redo for translation textarea.
  const fieldUndo = createFieldUndo();
  let fieldOwner = null;

  $effect(() => {
    const activeLine = p.lines.find((l) => l.n === p.activeLineN);
    const key = activeLine ? `${p.id}:${activeLine.n}` : null;
    const v = activeLine?.en ?? '';
    if (key === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = key;
    resyncField(fieldUndo, v);
  });

  function onTextareaInput(e, line) {
    const v = e.currentTarget.value;
    line.en = v;
    recordFieldEdit(fieldUndo, v, { atomic: isAtomicInput(e.inputType) });
    fitLineBoxes(line.n);
    markUnsaved();
  }

  function onTextareaKey(e, line) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);
    el.value = next;
    el.setSelectionRange(caret, caret);
    line.en = next;
    fitLineBoxes(line.n);
    markUnsaved();
  }

  // Translate mode disables canvas box placement and status indicators.
  const translate = $derived(isTranslateMode());


  // Refit boxes when translation text changes.
  function fitLineBoxes(n) {
    for (const b of p.boxes) if (b.lineN === n) autoFitBox(b, p);
  }

  const known = $derived(knownTags(app.pages));
  const recent = $derived(known.slice(0, 2));


  let menuFor = $state(null);

  let form = $state(null);

  // Reset active tag form on page navigation.
  $effect(() => {
    p.id;
    menuFor = null;
    form = null;
  });

  // Construct active and recent tag chips for a line.
  function chips(line) {
    const applied = lineTags(line);
    const rest = recent.map((t) => t.name).filter((n) => !applied.includes(n));
    return [...applied.map((name) => ({ name, on: true })), ...rest.map((name) => ({ name, on: false }))];
  }

  // Toggle tag on line and restyle attached boxes.
  function toggle(line, name) {
    const { restyled } = toggleTagOnLine(line.n, name, p);
    if (restyled) toast(`Restyled ${restyled} box${restyled > 1 ? 'es' : ''} on this line · ${modKey()}Z`);
  }

  function openCreate(n) {
    menuFor = null;
    form = { n, name: '', edit: false, tools: false, existed: false, confirmDelete: false, ...tagFormFields(null) };
  }


  function openEdit(n, name) {
    menuFor = null;
    form = { n, name, edit: true, tools: true, existed: false, confirmDelete: false, ...tagFormFields(findTag(name)) };
  }

  function submitForm(line) {
    const f = form;
    if (!f) return;
    if (f.edit) {
      // Save tag default styling.
      saveTagDefaults(f.name, tagFormDefaults(f));
      form = null;
      return;
    }
    const name = normalizeTagName(f.name);
    if (!name) return;
    // If tag already exists, transition form to edit mode.
    if (findTag(name)) {
      if (!hasTag(line, name)) toggle(line, name);
      form = { ...f, name, edit: true, tools: true, existed: true, confirmDelete: false };
      return;
    }
    createTag(name, tagFormDefaults(f));

    if (!hasTag(line, name)) toggle(line, name);
    form = null;
  }

  // Add text box in visible viewport.
  function addText() {
    const id = addTextBoxInView();
    if (!id) return;
    const b = page().boxes.find((x) => x.id === id);

    if (b) page().activeLineN = b.lineN;
  }

  function doDelete() {
    const name = form?.name;
    if (!name) return;
    form = null;
    if (deleteTag(name)) toast(`Forgot the defaults for “${name}” — lines keep the tag`);
  }
</script>

<div class="qlist">
  {#if p.lines.length === 0}
    <div class="qhint">
      No lines yet.<br />{translate
        ? 'Run Detect to read this page, or import a JSON of numbered text.'
        : 'Import a JSON of numbered text to populate the queue, or add a text box below.'}
    </div>
  {/if}
  {#each p.lines as line (line.n)}
    {@const placed = isPlaced(p, line.n)}
    {@const tagged = lineTags(line)}
    {@const editing = line.n === p.activeLineN}

    {@const free = isFreeLine(line)}
    {@const badge = free ? 'T' : line.n}
    {@const badgeTitle = free ? 'Typed on the page — not from the translation' : `Line ${line.n}`}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="qrow"
      class:editing
      class:active={editing}
      class:placed
      class:sfx={tagged.includes('sfx')}
      class:narration={tagged.includes('narration')}
      role={editing ? undefined : 'button'}
      tabindex={editing ? -1 : 0}
      onclick={editing ? undefined : () => activateLine(line.n)}
      onkeydown={editing ? undefined : (e) => e.key === 'Enter' && activateLine(line.n)}
    >
      {#if editing}

        <button class="badge" class:free title="Select this line's box" onclick={() => activateLine(line.n)}>{badge}</button>
        <span class="qcol">
          <span class="qtags">
            {#each chips(line) as c (c.name)}
              <button class="qtag" class:on={c.on} title={c.on ? `Remove ${c.name}` : `Apply ${c.name}`} onclick={() => toggle(line, c.name)}>{c.name}</button>
            {/each}
            <button class="qtag-ic" title="Create tag" onclick={() => (form?.n === line.n && !form.edit ? (form = null) : openCreate(line.n))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h8" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z" /></svg>
            </button>
            <button class="qtag-ic" title="All tags" onclick={() => (menuFor = menuFor === line.n ? null : line.n)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </span>

          {#if menuFor === line.n}

            <span class="qmenu">
              {#if known.length === 0}
                <span class="qmenu-empty">No tags yet — use the pen to make one.</span>
              {/if}
              {#each known as t (t.name)}
                <span class="qmenu-row">
                  <button class="qmenu-pick" class:on={hasTag(line, t.name)} onclick={() => toggle(line, t.name)}>
                    <svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12l5 5L20 6" /></svg>
                    <span class="nm">{t.name}</span>
                  </button>
                  <button class="qtag-ic" title="Tag settings" onclick={() => openEdit(line.n, t.name)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></svg>
                  </button>
                </span>
              {/each}
            </span>
          {/if}

          {#if form?.n === line.n}
            <span class="qtagform">
              <span class="qtf-top">
                {#if form.edit}
                  <span class="qtf-name">{form.name}</span>
                {:else}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="qtf-input"
                    autofocus
                    placeholder="Tag name…"
                    maxlength={MAX_TAG_LEN}
                    value={form.name}
                    oninput={(e) => (form.name = e.currentTarget.value)}
                    onkeydown={(e) => e.key === 'Enter' && submitForm(line)}
                  />
                {/if}
                <button class="qtag-ic" class:on={form.tools} title="Default font and outline" onclick={() => (form.tools = !form.tools)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="16" cy="7" r="2.2" /><path d="M4 7h9.8M18.2 7H20" /><circle cx="9" cy="16" r="2.2" /><path d="M4 16h2.8M11.2 16H20" /></svg>
                </button>
                <button class="qtf-go" onclick={() => submitForm(line)}>{form.edit ? 'Save' : 'Add'}</button>
              </span>
              {#if form.existed}

                <span class="qtf-note">
                  “{form.name}” already existed and is now on this line. Its saved defaults are untouched — press Save to replace them with what you set here.
                </span>
              {/if}
              {#if form.tools}

                <span class="qtf-row">
                  <label class="qtf-lbl" for="qtf-font-{line.n}">Font</label>
                  <select id="qtf-font-{line.n}" value={form.font} onchange={(e) => (form.font = e.currentTarget.value)}>
                    <option value="">—</option>
                    <optgroup label="Built-in">
                      {#each app.fonts.builtin as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
                    </optgroup>
                    {#if app.fonts.user.length}
                      <optgroup label="User fonts">
                        {#each app.fonts.user as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
                      </optgroup>
                    {/if}
                  </select>
                </span>

                <span class="qtf-row">
                  <label class="qtf-lbl" for="qtf-out-{line.n}">Outline</label>
                  <input class="btick" id="qtf-out-{line.n}" type="checkbox" checked={form.outlineOn} onchange={(e) => (form.outlineOn = e.currentTarget.checked)} />
                  {#if form.outlineOn}
                    <input type="color" value={form.outline} oninput={(e) => (form.outline = e.currentTarget.value)} />
                    <input type="number" min="0" max="20" step="0.5" value={form.outlineWidth} oninput={(e) => (form.outlineWidth = Math.max(0, Math.min(20, +e.currentTarget.value || 0)))} />
                  {/if}
                </span>
              {/if}
              {#if form.edit}

                <span class="qtf-del">
                  {#if form.confirmDelete}
                    <span class="qtf-note">
                      Forget “{form.name}”? It leaves your tag list and stops setting defaults for boxes placed from now on. Lines already tagged “{form.name}” keep the tag, and their boxes keep the style they were placed with — here and in every other chapter. While a line in this chapter still carries it, it stays in this list with no defaults.
                    </span>
                    <span class="qtf-delrow">
                      <button class="qtf-danger" onclick={doDelete}>Forget it</button>
                      <button class="qtf-quiet" onclick={() => (form.confirmDelete = false)}>Keep</button>
                    </span>
                  {:else}
                    <button class="qtf-quiet" onclick={() => (form.confirmDelete = true)}>Delete tag…</button>
                  {/if}
                </span>
              {/if}
            </span>
          {/if}

          {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
          <textarea
            rows="2"
            placeholder="English…"
            value={line.en ?? ''}
            oninput={(e) => onTextareaInput(e, line)}
            onkeydown={(e) => onTextareaKey(e, line)}
          ></textarea>
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {:else}
        <span class="badge" class:free title={badgeTitle}>{badge}</span>
        <span class="qcol">
          {#if tagged.length}
            <span class="qtypes">
              {#each tagged as t (t)}<span class="qtype {t}">{t}</span>{/each}
            </span>
          {/if}
          <span class="preview">{lineText(line)}</span>
          {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {/if}
    </div>
  {/each}


  {#if !translate}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addText}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add text
      </button>
    </div>
  {/if}
</div>
