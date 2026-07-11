<script>
  // Translate-mode controls: pick a BYOK provider/model, paste a key, translate
  // the page's detected JP lines into `en`. Reuses MangaTranslator's provider set.
  import { onMount } from 'svelte';
  import { app, page, setTranslateProvider, saveTranslatePrefs } from './store.svelte.js';
  import { loadTranslateProviders, translateCurrentPage } from './sidecar.js';

  const p = $derived(page());
  const t = $derived(app.translate);
  const translatable = $derived(p.lines.filter((l) => l.jp).length);
  const doneCount = $derived(p.lines.filter((l) => l.jp && l.en).length);

  // Fallback list so the picker works even before the sidecar answers.
  const FALLBACK = [
    'Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'xAI',
    'OpenRouter', 'Z.ai', 'Moonshot AI', 'Xiaomi MiMo', 'OpenAI-Compatible',
  ];
  const providerIds = $derived(
    t.providers.length ? t.providers.map((x) => x.id) : FALLBACK,
  );

  onMount(() => {
    loadTranslateProviders();
  });

  const keyFor = $derived(t.apiKeys?.[t.provider] ?? '');
  // OpenAI-Compatible may be keyless (local servers); everything else needs a key.
  const keyRequired = $derived(t.provider !== 'OpenAI-Compatible');
  const keyMissing = $derived(keyRequired && !(t.apiKeys?.[t.provider] ?? '').trim());
  function setKey(v) {
    t.apiKeys = { ...t.apiKeys, [t.provider]: v };
    saveTranslatePrefs();
  }
</script>

<div class="section translate">
  <div class="section-head">
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
    Translation
    <span class="count">{doneCount} / {translatable} translated</span>
  </div>
  <div class="section-body">
    <label class="fld">
      <span>Provider</span>
      <select value={t.provider} onchange={(e) => setTranslateProvider(e.target.value)}>
        {#each providerIds as id}<option value={id}>{id}</option>{/each}
      </select>
    </label>

    <label class="fld">
      <span>Model</span>
      <input type="text" bind:value={t.model} oninput={saveTranslatePrefs} placeholder="model id" />
    </label>

    <label class="fld">
      <span>{t.provider === 'OpenAI-Compatible' ? 'API key (optional)' : 'API key'}</span>
      <input type="password" value={keyFor} oninput={(e) => setKey(e.target.value)} placeholder="sk-…" autocomplete="off" />
    </label>

    {#if t.provider === 'OpenAI-Compatible'}
      <label class="fld">
        <span>Base URL</span>
        <input type="text" bind:value={t.baseUrl} oninput={saveTranslatePrefs} placeholder="http://localhost:8080/v1" />
      </label>
    {/if}

    <label class="fld">
      <span>Output language</span>
      <input type="text" bind:value={t.outputLanguage} oninput={saveTranslatePrefs} placeholder="English" />
    </label>

    <label class="fld">
      <span>Input language</span>
      <input type="text" bind:value={t.inputLanguage} oninput={saveTranslatePrefs} placeholder="Japanese" />
    </label>

    <label class="fld">
      <span>Reading dir.</span>
      <select bind:value={t.readingDirection} onchange={saveTranslatePrefs}>
        <option value="rtl">Right→Left (manga)</option>
        <option value="ltr">Left→Right (webtoon)</option>
      </select>
    </label>

    <label class="fld">
      <span>Reasoning</span>
      <select bind:value={t.reasoningEffort} onchange={saveTranslatePrefs}>
        <option value="">None</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </label>
    <div class="hint sub">Reasoning effort applies only to reasoning-capable models (e.g. Anthropic, OpenAI o-series).</div>

    <label class="fld col">
      <span>Special instructions <em>(optional glossary)</em></span>
      <textarea rows="2" bind:value={t.special} oninput={saveTranslatePrefs} placeholder="e.g. keep 主人公 as 'Aoi'"></textarea>
    </label>

    <button class="btn primary" disabled={t.translating || !translatable || !t.model || keyMissing} onclick={() => translateCurrentPage()}>
      {t.translating ? 'Translating…' : `Translate ${translatable} line${translatable === 1 ? '' : 's'}`}
    </button>
    {#if !translatable}
      <div class="hint">No detected JP text — run <b>Detect</b> first.</div>
    {:else if keyMissing}
      <div class="hint">Enter your {t.provider} API key to translate.</div>
    {:else if !t.model}
      <div class="hint">Set a model id to translate.</div>
    {/if}
  </div>
</div>

<style>
  .section-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .fld {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text, #e6e8ee);
  }
  .fld.col {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .fld > span {
    flex: none;
    width: 84px;
    color: var(--muted, #8b91a1);
  }
  .fld.col > span {
    width: auto;
  }
  .fld em {
    color: var(--muted, #8b91a1);
    font-style: normal;
    opacity: 0.8;
  }
  select,
  input,
  textarea {
    flex: 1;
    min-width: 0;
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    border: 1px solid var(--line, #2b2f3a);
    border-radius: 7px;
    font: inherit;
    font-size: 12px;
    padding: 5px 7px;
  }
  textarea {
    resize: vertical;
  }
  .btn {
    padding: 8px 10px;
    border-radius: 7px;
    border: 1px solid var(--line, #2b2f3a);
    background: var(--surface2, #20242e);
    color: var(--text, #e6e8ee);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 2px;
  }
  .btn.primary {
    background: var(--accent, #4b7bec);
    border-color: var(--accent, #4b7bec);
    color: #fff;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    font-size: 11px;
    color: var(--muted, #8b91a1);
  }
  .hint.sub {
    margin-top: -4px;
    opacity: 0.85;
  }
</style>
