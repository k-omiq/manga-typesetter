<script>
  // The scrolling page frame shared by the library and project screens.
  let { onSettings, children } = $props();
</script>

<div class="home-scroll">
  <div class="home-frame">
    <header class="home-head">
      <div class="wordmark">MANGA TYPESETTER</div>
      <div class="spacer"></div>
      <button class="soft-btn" onclick={onSettings}>Settings</button>
    </header>
    {@render children()}
  </div>
</div>
