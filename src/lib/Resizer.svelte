<script>
  import { app } from './store.svelte.js';

  let { side } = $props();

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function onPointerDown(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? app.leftWidth : app.rightWidth;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const delta = ev.clientX - startX;
      const w = clamp(side === 'left' ? startW + delta : startW - delta, 200, 460);
      if (side === 'left') app.leftWidth = w;
      else app.rightWidth = w;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="resizer" onpointerdown={onPointerDown}></div>
