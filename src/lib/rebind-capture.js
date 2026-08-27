// ===== Rebind capture =====
// The settings screen asks the user to press the keys for a shortcut, then
// listens on the window - capture phase, every keystroke - until one arrives.
// The listener's lifecycle lives here rather than inline in the component so
// the two rules that matter are facts a test can check instead of hope:
//
//   - it is armed only while the modal is open AND a row is listening;
//   - closing the modal, finishing, or cancelling takes it down again.
//
// A capture left armed after its owner went away would swallow every
// keystroke in the app and silently rebind shortcuts as the user typed.
import { captureAction } from './shortcuts.svelte.js';

export function createRebindCapture(win, { onKey, onCancel } = {}) {
  let row = null; // shortcut id waiting for keys, or null
  let shown = false; // the modal that owns the capture is on screen
  let armed = false;

  function sync() {
    const want = !!shown && !!row && !!win;
    if (want === armed) return;
    if (want) win.addEventListener('keydown', handleKey, true);
    else win.removeEventListener('keydown', handleKey, true);
    armed = want;
  }

  function handleKey(e) {
    const a = captureAction(e);
    if (a.act === 'pass' || a.act === 'wait') return;
    e.preventDefault?.();
    e.stopPropagation?.();
    if (a.act === 'cancel') {
      row = null;
      sync();
      onCancel?.();
      return;
    }
    onKey?.(a.combo, () => {
      row = null;
      sync();
    });
  }

  return {
    get current() {
      return row;
    },
    // Clicking the row that already listens cancels it rather than restarting.
    begin(id) {
      row = row === id ? null : id;
      sync();
      return row;
    },
    end() {
      row = null;
      sync();
    },
    // Closing the modal takes any in-flight capture with it.
    setOpen(v) {
      shown = !!v;
      if (!shown && row) {
        row = null;
        onCancel?.();
      }
      sync();
    },
  };
}
