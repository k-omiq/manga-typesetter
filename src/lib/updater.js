// Desktop updater facade for Tauri 2.
//
// In browser dev/preview there is no Tauri runtime, so checking for updates
// silently returns null. Under Tauri, it checks the endpoint configured in
// tauri.conf.json, validates signatures against the public key, and returns an
// Update handle if a newer version is available.

import { isTauri } from './importer.js';

/**
 * Check if a new version of the app is available.
 * Returns the Update object if an update is found, or null otherwise (including on network errors).
 *
 * @param {import('@tauri-apps/plugin-updater').CheckOptions} [options]
 * @returns {Promise<import('@tauri-apps/plugin-updater').Update | null>}
 */
export async function checkForUpdate(options) {
  if (!isTauri()) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check(options);
    return update ?? null;
  } catch (e) {
    console.warn('Update check failed:', e);
    return null;
  }
}

// Alias for convenience
export const check = checkForUpdate;

/**
 * Download and install an available update, reporting download progress, then relaunch the application.
 *
 * @param {import('@tauri-apps/plugin-updater').Update} update
 * @param {(progress: { event: 'Started' | 'Progress' | 'Finished', percent: number | null, downloaded: number, total: number | null }) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function installUpdate(update, onProgress) {
  if (!update) {
    throw new Error('No update object provided to installUpdate');
  }
  try {
    let contentLength = 0;
    let downloadedBytes = 0;

    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data?.contentLength ?? 0;
        downloadedBytes = 0;
        const percent = contentLength > 0 ? 0 : null;
        onProgress?.({
          event: 'Started',
          percent,
          downloaded: 0,
          total: contentLength || null,
        });
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data?.chunkLength ?? 0;
        const percent =
          contentLength > 0
            ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
            : null;
        onProgress?.({
          event: 'Progress',
          percent,
          downloaded: downloadedBytes,
          total: contentLength || null,
        });
      } else if (event.event === 'Finished') {
        onProgress?.({
          event: 'Finished',
          percent: 100,
          downloaded: downloadedBytes,
          total: contentLength || null,
        });
      }
    });

    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    throw new Error(`Failed to install update: ${e?.message ?? e}`);
  }
}
