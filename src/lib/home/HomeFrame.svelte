<script>
  import { onMount } from 'svelte';
  import { checkForUpdate } from '../updater.js';
  import UpdateDialog from './UpdateDialog.svelte';

  // The scrolling page frame shared by the library and project screens.
  let { onSettings, children } = $props();

  let update = $state(null);
  let updateDialogOpen = $state(false);

  onMount(async () => {
    try {
      update = await checkForUpdate();
    } catch {
      // Silently ignore network and updater errors on startup
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
      <button class="soft-btn" onclick={onSettings}>Settings</button>
    </header>
    {@render children()}
  </div>
</div>

<UpdateDialog bind:open={updateDialogOpen} {update} />

<style>
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
