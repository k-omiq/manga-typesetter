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

  const p = $derived(page());

  // In a translate chapter the queue IS the work, and nothing in it is about
  // placement: there are no boxes on the canvas to be placed or unplaced, so the
  // status dot would report "unplaced" on every row for ever, and the two
  // affordances that create a box — the hint's advice and the Add text button —
  // are offers this mode cannot keep. Rows, tags, the Japanese and the textarea
  // are untouched; that is the whole workflow.
  const translate = $derived(isTranslateMode());

  // Derived once for the whole list, not once per row. `knownTags` walks every
  // line of every page and de-dupes with `Array.includes`; `chips()` runs on the
  // active row and the dropdown ran it twice more on every render of its own.
  // Fine at twenty pages, and quietly quadratic at two hundred — and there is no
  // reason for it to be per-row work at all, since none of it depends on the
  // row.
  // A box placed from a line renders that line's text, so editing the
  // translation here changes what the box has to fit — the same edit
  // `setBoxText` makes from the canvas, arrived at from the other end. It is
  // fitted here rather than left to `TextBox`'s effect for the reason every
  // other write does it in the store: the effect is a safety net for whatever
  // happens to be rendered, and "the box's rectangle describes its text" is
  // supposed to hold whether or not anything is on screen to notice.
  //
  // Every box on the line, because `activateLine` will re-arm a line that is
  // already placed and a second click then gives it a second box.
  function fitLineBoxes(n) {
    for (const b of p.boxes) if (b.lineN === n) autoFitBox(b, p);
  }

  const known = $derived(knownTags(app.pages));
  const recent = $derived(known.slice(0, 2));

  // Which line's history dropdown is open, and which line's tag form is open —
  // both held as the line number rather than a boolean, so activating another row
  // closes them without a watcher: the row they belong to simply stops rendering.
  let menuFor = $state(null);
  // { n, name, edit, tools, existed, confirmDelete,
  //   outlineOn, font, outline, outlineWidth } — the last four from
  // `tagFormFields`, which owns the seeding rule. `existed` is the create form
  // having turned into an edit form because the name was taken; `confirmDelete`
  // is the second press of the delete.
  let form = $state(null);

  // Both are keyed by line number, and a line number only means anything
  // alongside the page it is on. Page 1 line 3 and page 2 line 3 are different
  // lines; nothing in `menuFor` or `form` says which of the two it belongs to,
  // so a form left open on one page reopened itself on the other the moment the
  // page turned — same number, same row position, a different sentence — and
  // pressing Add there applied the tag, and the defaults typed for the first
  // line, to the second. Silent, and on a page the user had not looked at yet.
  //
  // Closed on the page change rather than re-keyed onto `{ pageId, n }`, because
  // there is no reading of "carry this form to the next page" that is worth
  // having: the form is about a row that is no longer on screen. In a longstrip
  // chapter the index follows the scroll, so this closes an open form when the
  // reader scrolls onto another page — which is the same statement, since the
  // queue has already swapped its rows for that page's.
  $effect(() => {
    p.id;
    menuFor = null;
    form = null;
  });

  // Slot 1 and slot 2 of the picker are the two most recently used tags, and the
  // tags already on this line have to be visible somewhere or the user cannot see
  // — or undo — what they applied. Rather than a fifth control, the applied ones
  // take the front of the row as lit chips and the recent slots fill in behind
  // them with whatever is not already there. On an untagged line, which is every
  // line until the user touches one, this is exactly the spec's layout: most
  // recent, second most recent, pen, dropdown.
  function chips(line) {
    const applied = lineTags(line);
    const rest = recent.map((t) => t.name).filter((n) => !applied.includes(n));
    return [...applied.map((name) => ({ name, on: true })), ...rest.map((name) => ({ name, on: false }))];
  }

  // Applying, and removing, a tag. The tag write itself is still outside the
  // undo history — a line's tags are queue-side markup, not a canvas edit, and
  // the chip is its own inverse — but an apply now also restyles the boxes
  // already on that line, and *that* is one history entry. `toggleTagOnLine` is
  // where both halves live, so the queue never has to keep the two rules in step
  // with placement's copy of them.
  //
  // Said out loud when it happens, because it is the one effect of a tag the
  // user cannot see coming: a chip lighting up is not obviously a reason for a
  // box across the page to change font. `restyled` is 0 for an un-apply, for a
  // tag that defines nothing, and for a line with no box yet — the silent cases
  // are silent.
  function toggle(line, name) {
    const { restyled } = toggleTagOnLine(line.n, name, p);
    if (restyled) toast(`Restyled ${restyled} box${restyled > 1 ? 'es' : ''} on this line · ⌘Z`);
  }

  function openCreate(n) {
    menuFor = null;
    form = { n, name: '', edit: false, tools: false, existed: false, confirmDelete: false, ...tagFormFields(null) };
  }

  // The settings icon beside a history entry. The form is filled from the entry
  // as it stands now; saving writes the registry and nothing else, so every box
  // already carrying this tag keeps the style it was placed with.
  function openEdit(n, name) {
    menuFor = null;
    form = { n, name, edit: true, tools: true, existed: false, confirmDelete: false, ...tagFormFields(findTag(name)) };
  }

  function submitForm(line) {
    const f = form;
    if (!f) return;
    if (f.edit) {
      // A tag the dropdown offered because the open chapter uses it, but that
      // the registry has never seen, has nothing to update — `updateTag` alone
      // would return null and the user's settings would vanish without a word.
      // `saveTagDefaults` admits it instead, at the end of the list rather than
      // the front: configuring a tag is not using it, and promoting it here
      // would reorder the picker's first two slots under the cursor of someone
      // who only came to change a font.
      saveTagDefaults(f.name, tagFormDefaults(f));
      form = null;
      return;
    }
    const name = normalizeTagName(f.name);
    if (!name) return; // an empty name is not a tag; leave the form open
    // The name is already taken. `createTag` deliberately will not re-default an
    // existing entry — an `sfx` carried by every chapter on disk must not be
    // silently re-styled by someone typing `sfx` meaning to make a fresh tag —
    // so the defaults typed into this form had nowhere to go and were dropped
    // without a word. Now the form says so and becomes that tag's settings form,
    // carrying the typed values across, so committing them is one more press and
    // no re-typing. The apply still happens: it is the half of "Add" that was
    // never ambiguous.
    if (findTag(name)) {
      if (!hasTag(line, name)) toggle(line, name);
      form = { ...f, name, edit: true, tools: true, existed: true, confirmDelete: false };
      return;
    }
    createTag(name, tagFormDefaults(f));
    // Creating a tag from a row is the user saying they want it on that row.
    // Guarded rather than toggled: a name that already exists and is already
    // applied would otherwise come straight back off.
    if (!hasTag(line, name)) toggle(line, name);
    form = null;
  }

  // Deleting is registry-only and the confirm text has to carry that, because
  // "delete" is a word users read as "and take it off my document". See
  // `deleteTag` for why a rename is not offered in its place.
  // The Add button. `addTextBoxInView` puts the box at the centre of whatever
  // part of the page is actually on screen — this panel floats over a canvas
  // that may be zoomed into any corner — and leaves it in inline edit, so the
  // caret is already in it when the user looks up. `activateLine` then arms the
  // new row so the queue scrolls its editor open on the same line, which is
  // where the tag chips are.
  //
  // Nothing to do on a null: that is "no chapter open", and the panel is not
  // rendered then.
  function addText() {
    const id = addTextBoxInView();
    if (!id) return;
    const b = page().boxes.find((x) => x.id === id);
    // The row is armed by writing `activeLineN` directly rather than through
    // `activateLine`: that helper re-selects the line's box, and the box is
    // already selected *and in an open inline edit* — `addEmptyBox` left it
    // that way. Going back through selection would settle the gesture it is in
    // the middle of.
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
    <!-- A free-typed line's number is negative and is an internal marker, not
         the translator's numbering — see `isFreeLine`. Rendering it would put a
         `-1` in the badge where every other row carries a line number the user
         can find in their translation file. The glyph says what the row is
         instead: text the user typed onto the page. -->
    {@const free = isFreeLine(line)}
    {@const badge = free ? 'T' : line.n}
    {@const badgeTitle = free ? 'Typed on the page — not from the translation' : `Line ${line.n}`}
    <!-- The active row *is* the editor: the same container, the same badge and
         the same placed dot as the compact rows below it, with the preview
         swapped for the tag picker and a textarea. It used to expand a second
         block underneath showing the same line again, which meant the row and
         the editor disagreed about which of them was the line.

         Editing here is deliberately outside the undo history — it writes
         straight to the line, which `lineText` already resolves through for any
         placed box, so the canvas updates as the user types.

         One element for both states, rather than an `{#if}` around two of them,
         and that is a keyboard fix rather than a tidy-up. Swapping the element
         destroyed the one the user had just pressed Enter on: focus fell to
         `<body>`, nothing in the editor that replaced it was focused, and
         reaching the textarea meant tabbing from the top of the document. Keep
         the node and focus stays on it, one Tab from the controls inside.

         Hence `tabindex={editing ? -1 : 0}` and not `undefined`: removing the
         attribute from a focused element makes it unfocusable and the browser
         blurs it, which is the same bug by another route. -1 keeps the focus it
         already holds while taking the row back out of the tab order, where it
         no longer belongs — the row is not a button any more, the things inside
         it are.

         The role is a ternary, so the compiler cannot see that the only element
         ever carrying `tabindex=0` is the same one carrying `role="button"`, and
         warns about a tabbable non-interactive element. Splitting the element to
         satisfy it is precisely what caused the focus bug above. -->
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
        <!-- The editing row carries no click handler of its own — it is full of
             fields and buttons, and a row-wide handler would fire behind every
             one of them. But clicking the row used to re-select this line's box
             on the canvas, and that is worth keeping, so the badge takes it. -->
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
            <!-- In the flow rather than floating over it. The queue lives in a
                 short, scrollable floating panel, and a popover positioned out of
                 that panel's flow is clipped by its own scroll container the
                 moment the list is longer than the panel. -->
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
                <!-- Pressing Add on a name that was already taken used to apply
                     the tag and drop the typed defaults on the floor. It now
                     says so, and this form is that tag's settings form with the
                     typed values still in it. -->
                <span class="qtf-note">
                  “{form.name}” already existed and is now on this line. Its saved defaults are untouched — press Save to replace them with what you set here.
                </span>
              {/if}
              {#if form.tools}
                <!-- Unset is a first-class value here, not an oversight: a tag
                     whose font is "—" and whose outline is unticked leaves the
                     style exactly as it would have been without the tag. -->
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
                <!-- One switch for both halves of the outline, and it lights for
                     either: `sanitizeTags` vets colour and width independently,
                     so a stored entry really can hold a width with no colour —
                     that is exactly what a bad colour sanitises down to. Seeded
                     from `outline` alone, such an entry opened with the switch
                     off and Save wrote the width away. Now the missing half
                     shows its fallback, where the user can see it before they
                     commit it. See `tagFormFields`.

                     `.btick` for the box itself, so it takes the accent tint the
                     bulk panel's ticks use rather than rendering system-blue
                     beside them. -->
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
                <!-- The only recourse for a typo'd tag. Renaming is not offered
                     — the name is the only join to the lines carrying it in
                     chapters this app has not read — so without this a mistyped
                     tag sat in the picker for good, short of hand-editing
                     localStorage. Two presses, and the confirm spells out how
                     little it actually does, because "delete" is a word users
                     read as "and take it off my document". -->
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
            oninput={(e) => { line.en = e.currentTarget.value; fitLineBoxes(line.n); markUnsaved(); }}
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

  <!-- Pinned to the foot of the panel, not scrolled off the end of the list.
       `.fpanel-body` is the scroll container and this is the last child of the
       list inside it, so `position:sticky; bottom:0` keeps it on screen at every
       scroll position while it still occupies its own row at the bottom of the
       flow — the list can never end underneath it. Scrolled with the list, a
       forty-line page would hide the control behind a scroll the user has no
       reason to think holds anything, which is the state the Text tool was
       already in: discoverable only if you already knew.

       Disabled with no chapter open, where `addEmptyBox` refuses anyway rather
       than writing into the frozen stand-in page. Absent, not disabled, in a
       translate chapter: `addEmptyBox` refuses there too, so the button would
       be a control that never does anything. -->
  {#if !translate}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addText}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add text
      </button>
    </div>
  {/if}
</div>
