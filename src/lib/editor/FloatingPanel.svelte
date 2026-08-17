<script>
  // One floating editor window: a titled, draggable, resizable, hideable frame
  // around whatever the caller renders. It owns pointer work only — every rule
  // about where a panel may end up lives in panels.svelte.js, which is tested
  // without a browser.
  import { panels, movePanel, resizePanel, setHidden, raisePanel, clampAll } from './panels.svelte.js';
  import { prefersReducedMotion } from 'svelte/motion';

  let { id, title, count = null, children } = $props();

  const g = $derived(panels[id]);

  // The panels float over every piece of editor chrome (the bulk-style panel is
  // 40) and under the modal layer (100+). The stored z is 1..n and only orders
  // the panels among themselves.
  const LAYER = 50;

  // How long the collapse/expand plays, matched to the `.42s` baked into the
  // `fp-expand`/`fp-collapse` keyframes in styles.css — the two numbers have
  // to agree and there is nowhere shared to read one from, so a change to
  // either is a prompt to change the other. Noticeably slower than the old
  // instant swap on purpose: the brief wants the panel's contents visibly
  // gathering into the icon and spreading back out of it, and anything close
  // to the previous 0.18s entrance reads as a glitch, not a gather.
  const GATHER_MS = 420;

  // Every gesture in flight, so an unmount can end them all. It is the same
  // leak as a cancelled pointer wearing different clothes: the listeners live
  // on `document`, nothing guarantees a further pointer event once the
  // component is gone, and they would go on writing geometry. A set rather
  // than a single controller because two pointers can be down at once — the
  // grip and the header both pressed before either releases — and a lone slot
  // would let the second gesture overwrite the first one's net.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  // The stub and the panel are two different elements, and the instant
  // `g.hidden` flips Svelte would unmount whichever is showing and mount the
  // other on the same tick — nothing left in the DOM long enough to play an
  // exit. So the two are rendered from two independent conditions rather than
  // as the branches of one `{#if}`: the element being left stays mounted for
  // one animation wearing `fp-exit`, which swaps its entrance keyframe for the
  // collapse that mirrors it (see styles.css), while the element being entered
  // mounts immediately and grows out of the same corner. They overlap.
  //
  // Running them in series instead — which is what the earlier single flag
  // trailing `g.hidden` produced — cost 2 × GATHER_MS for a hide→show round
  // trip, and for the first half of it the icon the user is reaching for did
  // not exist yet. Overlapped, the round trip is one GATHER_MS and the stub is
  // in the DOM, at full size, from the frame the Hide button is pressed. (Full
  // size because the growth is on `.stub-ink` inside the button, not on the
  // button: a `scale(.08)` hit target is 2.7px of button, which is not a
  // control.) The deliberate, visible gather the brief asks for is untouched —
  // it is the same 420ms curve, just no longer queued behind itself.
  //
  // `prefersReducedMotion` collapses the wait to nothing, matching the CSS
  // media query in styles.css that stops the animation itself, so a
  // reduced-motion user gets neither the motion nor a lingering element.
  let exitingPanel = $state(false);
  let exitingStub = $state(false);
  const showPanel = $derived(!g.hidden || exitingPanel);
  const showStub = $derived(g.hidden || exitingStub);
  // Plain, not `$state`: it is this effect's own memory of what it last acted
  // on, never rendered, and making it reactive would only invalidate the
  // effect that writes it.
  let lastHidden = g.hidden;
  $effect(() => {
    const hidden = g.hidden;
    if (hidden === lastHidden) return;
    lastHidden = hidden;
    // Exactly one of the two is leaving; the other has just arrived and must
    // not be wearing a stale exit class from a flip that was reversed.
    exitingPanel = hidden;
    exitingStub = !hidden;
    const ms = prefersReducedMotion.current ? 0 : GATHER_MS;
    const t = setTimeout(() => {
      exitingPanel = false;
      exitingStub = false;
    }, ms);
    // Cleared automatically before the next run of this effect — a second
    // hide/show before the timer fires — and on unmount. The same guarantee
    // `live` gives the pointer gestures below, for a timer instead of a
    // listener.
    return () => clearTimeout(t);
  });

  function drag(e, kind) {
    if (e.button !== 0) return;
    // The header is the drag handle, so the hide button lives inside it. Without
    // this the button's own pointerdown would arm a drag and the click would
    // land as a one-pixel move instead of a hide.
    if (e.target.closest?.('.fpanel-hide')) return;
    e.preventDefault();
    raisePanel(id);
    const pid = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    e.currentTarget.setPointerCapture?.(pid);
    const move = (ev) => {
      // A second pointer — another touch, or a pen alongside the mouse — would
      // otherwise arm its own drag and the two closures would fight over the
      // same panel.
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === 'move') movePanel(id, o.x + dx, o.y + dy);
      else resizePanel(id, o.w + dx, o.h + dy);
    };
    // One controller for all three listeners, because a gesture does not always
    // end in a pointerup: a cancelled pointer (an OS gesture takes over, the
    // captured element leaves the DOM) fires pointercancel instead, and a move
    // handler that survives that would track the cursor with no button held and
    // save on every frame, with nothing left to stop it.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      // Clamped on drop, not per frame: clamping under a held pointer fights the
      // cursor, the panel lagging behind the hand that is dragging it. Waiting
      // for the release keeps the gesture honest and still guarantees the
      // invariant — no drag can leave a panel, or its collapsed stub, outside
      // the window where the user cannot reach it again.
      clampAll(window.innerWidth, window.innerHeight);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // The stub's own drag. A press stays ambiguous until it travels — under 4px
  // it is still the click that restores the panel, and only past that does it
  // become a drag that must not also restore on release. RailTools' rail edge
  // does exactly this split for the same reason. Geometrically a stub is just
  // a panel with `hidden: true`: clampPanel reads that flag and keeps the
  // stub's own 34px footprint on screen rather than the panel's KEEP_X strip,
  // so this reuses movePanel/clampAll rather than inventing a parallel notion
  // of stub position — and a stub dropped in the top-right corner stays in the
  // corner.
  let stubDragging = false; // set by a real drag's release, read once by the click that follows it
  function dragStub(e) {
    if (e.button !== 0) return;
    stubDragging = false; // a fresh press always starts undecided, even right after another drag
    e.preventDefault();
    raisePanel(id);
    const pid = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y };
    let dragging = false;
    e.currentTarget.setPointerCapture?.(pid);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) < 4) return;
      dragging = true;
      movePanel(id, o.x + dx, o.y + dy);
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      if (!dragging) return;
      clampAll(window.innerWidth, window.innerHeight);
      // Armed only for a gesture that will actually produce the click this
      // flag exists to swallow. A pointercancel — an OS gesture claiming the
      // pointer, a lost capture — fires no click, so a flag set here would
      // still be set on the next activation and eat it: Enter or Space on the
      // still-focused button would do nothing, and only the second press would
      // work. Mouse users never saw it because `dragStub` clears the flag on
      // every fresh press; a keyboard user has no press to clear it with.
      if (ev.type === 'pointerup') stubDragging = true;
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  function restoreStub() {
    // The click that follows a drag's pointerup — the button's own, not one
    // this file dispatches — is exactly the thing that must not also restore
    // the panel. `stubDragging` is set once, by that drag's `end`, and this
    // is its only reader.
    if (stubDragging) {
      stubDragging = false;
      return;
    }
    setHidden(id, false);
    raisePanel(id);
  }
</script>

{#if showPanel}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="fpanel"
    class:fp-exit={exitingPanel}
    style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px; z-index:{LAYER + g.z}"
    onpointerdown={() => raisePanel(id)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="fpanel-head" onpointerdown={(e) => drag(e, 'move')}>
      <span class="fpanel-title">{title}</span>
      {#if count}<span class="fpanel-count">{count}</span>{/if}
      <button
        class="fpanel-hide"
        onclick={() => setHidden(id, true)}
        aria-label="Hide {title}"
        title="Hide {title}"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </header>
    <div class="fpanel-body">{@render children()}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fpanel-grip" onpointerdown={(e) => drag(e, 'resize')}></div>
  </section>
{/if}

<!-- Second in source order, so during the overlap the arriving stub is the one
     on top: both carry the same z-index, and the outgoing element is inert
     anyway (`.fp-exit` takes pointer events off it — see styles.css). -->
{#if showStub}
  <!-- The minimised state is an icon, not a text pill — `title` still carries
       the name, as the tooltip and the accessible name, so the control stays
       identifiable without a visible label. The glyph is keyed off `id` rather
       than a new prop: the only two panels that exist are the two ids
       panels.svelte.js already knows, so this needs nothing a caller isn't
       already passing. A third panel that never updates this map still gets a
       stub — the options glyph, as the fallback below — it would just be the
       wrong picture until someone adds its own. -->
  <button
    class="panel-stub"
    class:fp-exit={exitingStub}
    style="left:{g.x}px; top:{g.y}px; z-index:{LAYER + g.z}"
    onpointerdown={dragStub}
    onclick={restoreStub}
    aria-label={'Show ' + title}
    title="Show {title}"
  >
    <!-- The button is the hit target and never moves or scales; this span is
         everything you can see, and it is what plays the gather. Putting the
         animation on the button instead shrank the target with the picture,
         which made the icon untappable for most of the animation it is the
         only way to interrupt. -->
    <span class="stub-ink">
      {#if id === 'queue'}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" />
          <circle cx="4" cy="6" r="1.3" /><circle cx="4" cy="12" r="1.3" /><circle cx="4" cy="18" r="1.3" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M4 7h6" /><path d="M14 7h6" /><circle cx="11" cy="7" r="2.2" />
          <path d="M4 17h10" /><path d="M18 17h2" /><circle cx="16" cy="17" r="2.2" />
        </svg>
      {/if}
    </span>
  </button>
{/if}
