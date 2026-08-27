<script>
  import { onMount } from 'svelte';
  import { checkForUpdate } from '../updater.js';
  import UpdateDialog from './UpdateDialog.svelte';

  // Shared layout frame for home screens.
  let { onSettings, children } = $props();

  let update = $state(null);
  let updateDialogOpen = $state(false);

  onMount(async () => {
    try {
      update = await checkForUpdate();
    } catch {
      // Ignore updater errors on startup.
    }
  });
</script>

<div class="home-scroll">
  <div class="home-frame">
    <header class="home-head">
      <div class="wordmark">MANGA TYPESETTER</div>
      <div class="spacer"></div>
      {#if update}
        <button
          class="soft-btn update-badge"
          onclick={() => (updateDialogOpen = true)}
          title={update.version ? `Update to v${update.version}` : 'Update available'}
        >
          <span class="update-dot"></span>
          Update available
        </button>
      {/if}
      <button class="soft-btn settings-btn" onclick={onSettings} aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
    </header>
    {@render children()}
  </div>
</div>

<UpdateDialog bind:open={updateDialogOpen} {update} />

<style>
  /* The gear stands alone: an icon reads at a glance in a header that already
     says where you are, and it matches the modal it opens. */
  .settings-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    padding: 0;
    color: var(--t2);
  }
  .settings-btn:hover {
    color: var(--text);
  }
  .update-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-color: var(--line2);
    color: var(--text);
  }
  .update-badge .update-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text);
  }
  .update-badge:disabled {
    cursor: default;
    opacity: 0.75;
  }
</style>
