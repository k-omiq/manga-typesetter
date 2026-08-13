<script>
  import { page, isPlaced, activateLine, lineText, markUnsaved } from './store.svelte.js';

  const p = $derived(page());
</script>

<div class="qlist">
  {#if p.lines.length === 0}
    <div class="qhint">No translated lines.<br />Import a JSON of numbered text to populate the queue, or use the Text tool to add boxes manually.</div>
  {/if}
  {#each p.lines as line (line.n)}
    {@const placed = isPlaced(p, line.n)}
    <div
      class="qrow"
      class:placed
      class:active={line.n === p.activeLineN}
      class:sfx={line.type === 'sfx'}
      class:narration={line.type === 'narration'}
      role="button"
      tabindex="0"
      onclick={() => activateLine(line.n)}
      onkeydown={(e) => e.key === 'Enter' && activateLine(line.n)}
    >
      <span class="badge">{line.n}</span>
      <span class="qcol">
        {#if line.type !== 'dialogue'}<span class="qtype {line.type}">{line.type}</span>{/if}
        <span class="preview">{lineText(line)}</span>
        {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
      </span>
      <span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>
    </div>
    {#if line.n === p.activeLineN}
      <!-- The active row expands into an inline translator: JP for reference, a
           textarea for EN. Editing here is deliberately outside the undo history —
           it writes straight to the line, which lineText already resolves through
           for any placed box, so the canvas updates as the user types. -->
      <div class="qedit">
        {#if line.jp}<div class="qedit-jp">{line.jp}</div>{/if}
        <textarea
          rows="2"
          placeholder="English…"
          value={line.en ?? ''}
          onclick={(e) => e.stopPropagation()}
          oninput={(e) => { line.en = e.currentTarget.value; markUnsaved(); }}
        ></textarea>
      </div>
    {/if}
  {/each}
</div>
