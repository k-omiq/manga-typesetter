//! Forcing a write to the actual device.
//!
//! `fsx.writeTextFileAtomic` writes a temp file beside its target and renames it
//! over the top. The rename is what makes the write ATOMIC - chapter.json holds
//! either the old contents or the new, never a mix - and that is the property the
//! app already relied on. It is not what makes it DURABLE: both the temp file's
//! data and the rename sit in the page cache, and the two are not ordered with
//! respect to each other. A power cut or a kernel panic in that window can leave
//! the rename applied to a temp file whose bytes never landed, which is a
//! chapter.json of the right length full of zeroes - and chapter.json is the only
//! copy of a chapter's typesetting.
//!
//! The filesystem plugin has no API for this, so the frontend calls here: once on
//! the temp file before the rename, once on the containing directory after it
//! (the directory entry is what the rename actually changed). Both are
//! best-effort on the JS side - a build or a platform without this command writes
//! exactly as it did before.

use std::fs::{File, OpenOptions};
use std::path::Path;

/// `fsync(2)` the file or directory at `path`.
///
/// It never creates, writes to, or truncates anything, so the worst a bad path
/// can do is fail.
///
/// The handle has to be opened differently per platform. `sync_all` is
/// `fsync(2)` on Unix, where a read-only descriptor is enough and is the only
/// way to get one for a directory at all. On Windows it is `FlushFileBuffers`,
/// which the API documents as requiring `GENERIC_WRITE` - a read-only handle
/// there fails with access denied, on every file, silently, because the JS
/// caller swallows the error. Windows also cannot open a directory as a file
/// without `FILE_FLAG_BACKUP_SEMANTICS`, so directories are skipped there and
/// the filesystem's own metadata journalling is what orders the rename.
fn sync(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let f = if cfg!(windows) {
        if meta.is_dir() {
            return Ok(());
        }
        OpenOptions::new().read(true).write(true).open(path)
    } else {
        File::open(path)
    }
    .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

/// Runs on the blocking pool: `sync_all` waits on the device and would otherwise
/// stall the async runtime for as long as the disk takes.
#[tauri::command]
pub async fn fsync_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    // The command's own body, not a copy of it: the duplicate that used to live
    // here is what let a read-only handle - fine on Unix, access-denied on
    // Windows - pass the suite on a Mac for as long as it did.
    use super::sync;
    use std::path::Path;

    #[test]
    fn syncs_a_file_and_its_directory() {
        let dir = std::env::temp_dir().join(format!("mt-fsync-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("chapter.json");
        std::fs::write(&file, b"{}").unwrap();
        sync(&file).expect("a file must sync");
        sync(&dir).expect("a directory must sync");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A path that is not there is an error the caller swallows, never a panic.
    #[test]
    fn reports_a_missing_path_rather_than_panicking() {
        assert!(sync(Path::new("/no/such/path/mt-fsync")).is_err());
    }
}
