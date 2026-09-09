// Frontend bridge to the `process_memory` Tauri command. See
// src-tauri/src/memory.rs for what is counted and why it is not RSS.
//
// There is no web API that answers this. `performance.memory` is Chromium-only
// and WKWebView does not implement it, and even where it exists it reports the
// JS heap - not the decoded images, which is the part that matters here. The
// only honest number comes from outside the web view, which is why this is a
// command and not a measurement the page takes of itself.

let invokeFn = null;
async function getInvoke() {
  if (invokeFn) return invokeFn;
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  const mod = await import('@tauri-apps/api/core');
  invokeFn = mod.invoke;
  return invokeFn;
}

// What each `role` from the Rust side is called on screen. The web view row is
// spelled out because it is the one that surprises people: it is a separate
// process, Activity Monitor lists it under its own name, and it is where the
// page images live.
export const ROLE_LABELS = {
  app: 'App window + Rust host',
  webview: 'Web view - page, scripts, images',
  'webview-gpu': 'Web view GPU helper',
  'webview-net': 'Web view network helper',
  sidecar: 'Python ML child process',
  flux: 'FLUX inpainting',
  other: 'Other child process',
};

// A `MemoryReport`, or null outside Tauri (a browser dev server has no host
// process to ask). `supported: false` is the platform saying it cannot do the
// responsible-process attribution the number depends on - a different thing
// from "no answer", and the UI says so differently.
export async function processMemory() {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke('process_memory');
  } catch {
    return null;
  }
}
