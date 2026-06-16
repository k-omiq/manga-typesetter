<script>
  import { app, byId } from './store.svelte.js';

  const zoomLabel = $derived((app.isFit ? 'Fit · ' : '') + Math.round(app.zoom * 100) + '%');
  const fontLabel = $derived(app.selectedId ? byId(app.selectedId)?.style.font ?? '—' : '—');
</script>

<footer class="statusbar">
  <div class="item">Zoom <b>{zoomLabel}</b></div>
  <div class="item">X <b>{app.cursor.x}</b> · Y <b>{app.cursor.y}</b> px</div>
  <div class="item">Font <b>{fontLabel}</b></div>
  <div class="spacer"></div>
  <div class="item">Format <b>{app.fmt}</b></div>
  <div class="item">
    <span class="save-ind" class:unsaved={!app.saved} class:saved={app.saved}>
      <span class="d"></span><b>{app.saved ? 'All changes saved' : 'Unsaved changes'}</b>
    </span>
  </div>
</footer>
