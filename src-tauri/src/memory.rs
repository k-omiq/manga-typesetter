//! What this app actually costs in RAM, counting everything it is responsible for.
//!
//! The number in Activity Monitor next to "manga-typesetter" is not the answer,
//! and neither is anything the web page can measure about itself. The app is
//! several processes:
//!
//!   - this one, the Rust host and the AppKit window;
//!   - `com.apple.WebKit.WebContent`, which is where the page, the JavaScript
//!     heap and every decoded page image live — in other words where nearly all
//!     of the memory this app is criticised for actually sits;
//!   - `com.apple.WebKit.GPU` and `com.apple.WebKit.Networking`, its siblings;
//!   - any ML child process the app still spawns (`mt-flux` for inpainting,
//!     which holds model weights). Detection and OCR are no longer among them:
//!     they run in this process, on the ONNX engine in `detect::`.
//!
//! Child processes are ordinary descendants and are found by
//! walking parent pids. The WebKit processes are not: they are XPC services
//! started by launchd, so their parent is pid 1 and their argv is identical for
//! every WebKit host on the machine. Walking parents finds nothing, and matching
//! on the name would count Safari's tabs and every other app's web view as ours.
//!
//! What does identify them is the *responsible process* — the macOS notion of
//! "who is this running on behalf of", which is exactly the question being
//! asked. `responsibility_get_pid_responsible_for_pid` answers it for any pid
//! without privileges. It is not in a public header, which is the one wart
//! here; it is a stable, long-standing symbol in libsystem and it is what every
//! process monitor on the platform uses for this. The fallback if it ever
//! disappears is the parent walk alone, which is what `responsible_pid` below
//! degrades to, so a missing symbol costs the WebKit rows and not the feature.
//!
//! The per-process number is `ri_phys_footprint` from `proc_pid_rusage`, not
//! RSS. RSS counts shared pages — the ~500 MB of system frameworks every process
//! maps — once per process, so summing RSS across five processes produces a
//! total several times larger than the machine is actually giving this app.
//! Phys footprint is the accounting the kernel itself uses for memory limits and
//! is the column Activity Monitor labels "Memory", so the rows here add up to
//! the number the user can check against.

use serde::Serialize;

#[derive(Serialize)]
pub struct ProcRow {
    pub pid: i32,
    pub name: String,
    /// Which part of the app this is, for a UI that should not have to know
    /// what `com.apple.WebKit.WebContent` means.
    pub role: String,
    /// Phys footprint in bytes. See the note above on why not RSS.
    pub bytes: u64,
    /// How this process was attributed to us: "self", "child", "responsible"
    /// (the exact macOS answer) or "session" (the dev-build fallback — see
    /// `imp::report`, and note that the UI says so when any row carries it).
    pub via: String,
}

#[derive(Serialize)]
pub struct MemoryReport {
    pub supported: bool,
    pub total: u64,
    pub processes: Vec<ProcRow>,
    /// Set when a process was found but its footprint could not be read, so a
    /// total that is quietly short says so instead of looking authoritative.
    pub incomplete: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{MemoryReport, ProcRow};
    use std::collections::HashMap;

    // Not in a public header; see the module note. Declared rather than bound
    // through a crate so the single unsafe surface is visible in one place.
    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
    }

    /// `PROC_ALL_PIDS` from `<sys/proc_info.h>`. The `libc` crate binds
    /// `proc_listpids` but not this selector, so it is spelled out rather than
    /// pulling in another crate for one integer.
    const PROC_ALL_PIDS: u32 = 1;

    /// Every pid on the machine. Called twice: once to size the buffer, once to
    /// fill it, which is the documented shape of `proc_listpids`.
    fn all_pids() -> Vec<libc::pid_t> {
        unsafe {
            let bytes = libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0);
            if bytes <= 0 {
                return Vec::new();
            }
            // Room for processes started between the two calls; the fill call
            // reports how many it actually wrote.
            let cap = (bytes as usize / std::mem::size_of::<u32>()) + 64;
            let mut pids: Vec<u32> = vec![0; cap];
            let written = libc::proc_listpids(
                PROC_ALL_PIDS,
                0,
                pids.as_mut_ptr() as *mut libc::c_void,
                (cap * std::mem::size_of::<u32>()) as i32,
            );
            if written <= 0 {
                return Vec::new();
            }
            let n = written as usize / std::mem::size_of::<u32>();
            pids.truncate(n);
            // proc_listpids pads with zeros; a pid of 0 is the kernel and never
            // ours either way.
            pids.into_iter().filter(|p| *p != 0).map(|p| p as libc::pid_t).collect()
        }
    }

    /// Parent pid and start time, in one syscall because both come from the
    /// same struct and the start time is what disambiguates a dev launch —
    /// see `report`.
    fn bsd_of(pid: libc::pid_t) -> Option<(libc::pid_t, u64)> {
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
            let got = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );
            if got == size {
                Some((info.pbi_ppid as libc::pid_t, info.pbi_start_tvsec))
            } else {
                // Exited between the listing and now, or not ours to look at.
                None
            }
        }
    }

    /// One of the three XPC services WebKit runs a web view out of. Matched by
    /// name because that is all these processes have: identical argv, parent
    /// pid 1, and no bundle of their own.
    fn is_webkit_service(name: &str) -> bool {
        name.contains("WebKit.WebContent")
            || name.contains("WebKit.GPU")
            || name.contains("WebKit.Networking")
    }

    fn name_of(pid: libc::pid_t) -> String {
        unsafe {
            let mut buf = [0i8; 256];
            let n = libc::proc_name(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32);
            if n <= 0 {
                return String::new();
            }
            let bytes: Vec<u8> = buf[..n as usize].iter().map(|c| *c as u8).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    /// Phys footprint in bytes, or None if the process is gone or unreadable.
    fn footprint_of(pid: libc::pid_t) -> Option<u64> {
        unsafe {
            let mut ri: libc::rusage_info_v2 = std::mem::zeroed();
            let ok = libc::proc_pid_rusage(
                pid,
                libc::RUSAGE_INFO_V2,
                &mut ri as *mut _ as *mut libc::rusage_info_t,
            );
            if ok == 0 {
                Some(ri.ri_phys_footprint)
            } else {
                None
            }
        }
    }

    fn responsible_pid(pid: libc::pid_t) -> Option<libc::pid_t> {
        let r = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
        if r > 0 && r != pid {
            Some(r)
        } else {
            None
        }
    }

    /// A human name for a process this app is responsible for. Matched on the
    /// executable name, which for the WebKit services is the XPC service name
    /// and for an ML child is what its build produces.
    fn role_for(name: &str, is_self: bool) -> &'static str {
        if is_self {
            return "app";
        }
        match name {
            // Where the page, the JS heap and every decoded page image live.
            n if n.contains("WebKit.WebContent") => "webview",
            n if n.contains("WebKit.GPU") => "webview-gpu",
            n if n.contains("WebKit.Networking") => "webview-net",
            n if n.contains("mt-flux") || n.contains("flux") => "flux",
            // No detection sidecar any more, but a Python ML child (the FLUX
            // server, launched from a venv rather than the frozen binary) still
            // arrives under this name.
            n if n.contains("python") || n.contains("Python") => "sidecar",
            _ => "other",
        }
    }

    /// `may_claim_session_webkit` is the caller stating that it actually owns a
    /// web view. The launch-session fallback below is a heuristic over a whole
    /// terminal session, and a process with no web view of its own must never
    /// use it — it would attribute the web view of whatever else was launched
    /// from the same shell. The Tauri command passes true because the app *is*
    /// a web view; nothing else should.
    pub fn report(may_claim_session_webkit: bool) -> MemoryReport {
        let me = std::process::id() as libc::pid_t;
        let pids = all_pids();

        // One pass for the parent and start-time maps, so the ancestor walk
        // below is lookups rather than a syscall per step per pid.
        let mut parent: HashMap<libc::pid_t, libc::pid_t> = HashMap::new();
        let mut started: HashMap<libc::pid_t, u64> = HashMap::new();
        for p in &pids {
            if let Some((pp, t)) = bsd_of(*p) {
                parent.insert(*p, pp);
                started.insert(*p, t);
            }
        }
        let my_start = started.get(&me).copied().unwrap_or(0);

        // Who this app is running on behalf of. Double-clicked from the Finder
        // that is the app itself, and the web view's XPC services name it
        // directly — the exact case, and the one that ships.
        //
        // Launched from a terminal, as `tauri dev` is, responsibility is
        // inherited: the app AND its web view services all name the terminal,
        // not the app. Attributing on "responsible == me" alone therefore finds
        // the web view in a release build and silently loses it in every
        // development one — which is the build a developer is looking at this
        // panel from, and the panel would have quietly under-reported by the
        // ~90 MB that matters most.
        //
        // So the dev case is attributed by launch session instead: a WebKit
        // service that shares this app's responsible process and started no
        // earlier than the app did. It is narrower than it looks — the
        // responsible process is one terminal session — but it is a heuristic,
        // not an identity, so those rows are labelled `session` rather than
        // `responsible` and the UI can say which is which. A second WebKit app
        // launched from the same shell after this one would be counted; nothing
        // public distinguishes them, and over-reporting visibly beats
        // under-reporting silently.
        let my_responsible = responsible_pid(me);

        // Is `pid` this process or a descendant of it? Bounded rather than
        // `loop`: a corrupt or racing parent map must not hang the command, and
        // no real tree is 64 deep.
        let descends_from_me = |mut pid: libc::pid_t| -> bool {
            for _ in 0..64 {
                if pid == me {
                    return true;
                }
                match parent.get(&pid) {
                    Some(pp) if *pp > 1 => pid = *pp,
                    _ => return false,
                }
            }
            false
        };

        let mut rows: Vec<ProcRow> = Vec::new();
        let mut incomplete = false;

        for pid in pids {
            let name = name_of(pid);
            let resp = if pid == me { None } else { responsible_pid(pid) };
            let via = if pid == me {
                "self"
            } else if descends_from_me(pid) {
                "child"
            } else if resp.map(descends_from_me).unwrap_or(false) {
                // The WebKit XPC services in a released app, and anything else
                // launchd started on this app's behalf. See the note above.
                "responsible"
            } else if may_claim_session_webkit
                && is_webkit_service(&name)
                && my_responsible.is_some()
                && resp == my_responsible
                && started.get(&pid).copied().unwrap_or(0) >= my_start
            {
                "session"
            } else {
                continue;
            };

            match footprint_of(pid) {
                Some(bytes) => rows.push(ProcRow {
                    pid,
                    role: role_for(&name, pid == me).to_string(),
                    name,
                    bytes,
                    via: via.to_string(),
                }),
                // Counted as missing rather than as zero: a row silently worth
                // nothing turns a short total into a confident one.
                None => incomplete = true,
            }
        }

        // Biggest first — the point of the list is to see what is holding the
        // memory, and that is almost always the web view.
        rows.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        let total = rows.iter().map(|r| r.bytes).sum();
        MemoryReport { supported: true, total, processes: rows, incomplete }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::MemoryReport;
    /// The attribution this report depends on — responsible-process for the web
    /// view's own process — is a macOS notion. Rather than report the host
    /// process alone and call it the app's memory, which is the misleading
    /// number this command exists to replace, the other platforms say so.
    pub fn report(_may_claim_session_webkit: bool) -> MemoryReport {
        MemoryReport { supported: false, total: 0, processes: Vec::new(), incomplete: true }
    }
}

/// Every process this app is responsible for, with its phys footprint, and the
/// total. See the module note for what is counted and why.
#[tauri::command]
pub fn process_memory() -> MemoryReport {
    // True: this process is the web view's host. See `imp::report`.
    imp::report(true)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::process_memory;

    // Every syscall in this module against the live process. There is no web
    // view or ML child in a test binary, so what this can prove is that the
    // enumeration, the parent walk and the footprint read all work and agree —
    // which is the part that would break silently on an OS update. The
    // responsible-process attribution has no test here for the same reason: it
    // needs a host that owns an XPC service, and the test binary owns none.
    #[test]
    fn reports_at_least_this_process_with_a_real_footprint() {
        let r = process_memory();
        assert!(r.supported);
        let me = std::process::id() as i32;
        let mine = r
            .processes
            .iter()
            .find(|p| p.pid == me)
            .expect("the running test process must be in its own report");
        assert_eq!(mine.via, "self");
        assert_eq!(mine.role, "app");
        // A megabyte is far below anything a Rust test binary occupies and far
        // above what a failed read would produce, so this catches a zeroed
        // struct without pinning a number that varies by machine.
        assert!(mine.bytes > 1_000_000, "footprint looks unread: {}", mine.bytes);
        assert_eq!(r.total, r.processes.iter().map(|p| p.bytes).sum::<u64>());
    }

    // The filter is the whole feature: a report that quietly included every
    // process on the machine would still look plausible in the UI.
    //
    // `report(false)` rather than `process_memory()`, and the difference is the
    // point being tested. This test binary owns no web view, so it must claim
    // none — but it is typically launched from the same terminal as a running
    // `tauri dev`, which puts that app's WebKit services in the same
    // responsibility group and inside the same start-time window. The flag is
    // what keeps the launch-session heuristic off for a caller that has no web
    // view to justify it; with it on, this assertion fails, which is exactly
    // the over-attribution the flag exists to prevent.
    #[test]
    fn does_not_claim_unrelated_processes() {
        let r = super::imp::report(false);
        // launchd is nobody's child and nobody's responsibility.
        assert!(!r.processes.iter().any(|p| p.pid == 1));
        assert!(r.processes.iter().all(|p| !p.role.starts_with("webview")));
    }
}
