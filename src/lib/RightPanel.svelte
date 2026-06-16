<script>
  import { app, page, isPlaced } from './store.svelte.js';
  import Queue from './Queue.svelte';
  import Inspector from './Inspector.svelte';
  import CleanPanel from './CleanPanel.svelte';

  const placedCount = $derived(page().lines.filter((l) => isPlaced(page(), l.n)).length);
  const totalCount = $derived(page().lines.length);
</script>

<section class="col col-right" style="width:{app.rightWidth}px">
  {#if app.mode === 'clean'}
    <CleanPanel />
  {:else}
  <div class="rpanel">
    <!-- Text Queue -->
    <div class="section queue" class:collapsed={app.collapsed.queue}>
      <div
        class="section-head"
        role="button"
        tabindex="0"
        onclick={() => (app.collapsed.queue = !app.collapsed.queue)}
        onkeydown={(e) => e.key === 'Enter' && (app.collapsed.queue = !app.collapsed.queue)}
      >
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
        Text Queue
        <span class="count">{placedCount} / {totalCount} placed</span>
      </div>
      <div class="section-body">
        <Queue />
      </div>
    </div>

    <!-- Inspector -->
    <div class="section inspector" class:collapsed={app.collapsed.inspector}>
      <div
        class="section-head"
        role="button"
        tabindex="0"
        onclick={() => (app.collapsed.inspector = !app.collapsed.inspector)}
        onkeydown={(e) => e.key === 'Enter' && (app.collapsed.inspector = !app.collapsed.inspector)}
      >
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
        Inspector
      </div>
      <div class="section-body">
        <Inspector />
      </div>
    </div>
  </div>
  {/if}
</section>
