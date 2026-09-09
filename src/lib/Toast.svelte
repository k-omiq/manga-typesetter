<script>
  import { app } from './store.svelte.js';
  const show = $derived(app.toast.msg !== '');
</script>

<div class="toast" class:show>{app.toast.msg}</div>
