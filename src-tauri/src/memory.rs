//! Process memory attribution across the host, WebKit XPC services, and child ML processes.
//!
//! Reports `ri_phys_footprint` from `proc_pid_rusage` (Activity Monitor's "Memory" metric,
//! avoiding RSS shared-page double counting) and attributes WebKit via responsible PID.

use serde::Serialize;

#[derive(Serialize)]
pub struct ProcRow {
    pub pid: i32,
    pub name: String,
    /// Role name for the UI (e.g. "webview", "flux", "app").
    pub role: String,
    /// Physical footprint in bytes (`ri_phys_footprint`).
    pub bytes: u64,
    /// Attribution method: "self", "child", "responsible", or dev fallback "session".
    pub via: String,
}

#[derive(Serialize)]
pub struct MemoryReport {
    pub supported: bool,
    pub total: u64,
    pub processes: Vec<ProcRow>,
    /// Set when a process was found but its footprint could not be read.
    pub incomplete: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{MemoryReport, ProcRow};
    use std::collections::HashMap;

    // Not in a public header; see the module note. Declared rather than bound
    // libsystem private symbol to query responsible PID.
    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
    }

    /// `PROC_ALL_PIDS` from `<sys/proc_info.h>`.
    const PROC_ALL_PIDS: u32 = 1;

    /// Returns all active PIDs on the machine via `proc_listpids`.
    fn all_pids() -> Vec<libc::pid_t> {
        unsafe {
            let bytes = libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0);
            if bytes <= 0 {
                return Vec::new();
            }
            // Extra capacity for processes started between sizing and fill calls.
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
            // Filter out kernel PID 0 and padding zeros.
            pids.into_iter().filter(|p| *p != 0).map(|p| p as libc::pid_t).collect()
        }
    }

    /// Parent PID and start time from `proc_bsdinfo`.
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

    /// Matches WebKit XPC service names (`WebContent`, `GPU`, `Networking`).
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

    /// Maps process name to a role string ("app", "webview", "flux", "sidecar", "other").
    fn role_for(name: &str, is_self: bool) -> &'static str {
        if is_self {
            return "app";
        }
        match name {
            n if n.contains("WebKit.WebContent") => "webview",
            n if n.contains("WebKit.GPU") => "webview-gpu",
            n if n.contains("WebKit.Networking") => "webview-net",
            n if n.contains("mt-flux") || n.contains("flux") => "flux",
            // Python ML child (e.g. FLUX server from venv).
            n if n.contains("python") || n.contains("Python") => "sidecar",
            _ => "other",
        }
    }

    /// Builds the memory report.
    ///
    /// When `may_claim_session_webkit` is true, falls back to claiming same-session
    /// WebKit processes when running under `tauri dev` where responsible PID is inherited.
    pub fn report(may_claim_session_webkit: bool) -> MemoryReport {
        let me = std::process::id() as libc::pid_t;
        let pids = all_pids();

        // Pre-fetch parent and start-time maps to avoid syscalls during tree walk.
        let mut parent: HashMap<libc::pid_t, libc::pid_t> = HashMap::new();
        let mut started: HashMap<libc::pid_t, u64> = HashMap::new();
        for p in &pids {
            if let Some((pp, t)) = bsd_of(*p) {
                parent.insert(*p, pp);
                started.insert(*p, t);
            }
        }
        let my_start = started.get(&me).copied().unwrap_or(0);

        // In release builds, WebKit XPC services name this app as responsible process.
        // Under `tauri dev`, responsibility points to the terminal; session fallback
        // matches WebKit services started in the same session after this process.
        let my_responsible = responsible_pid(me);

        // Bounded ancestor walk (max 64 levels) to check if pid descends from me.
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
                // Mark incomplete rather than assuming 0 bytes.
                None => incomplete = true,
            }
        }

        // Sort largest footprint first.
        rows.sort_by_key(|r| std::cmp::Reverse(r.bytes));
        let total = rows.iter().map(|r| r.bytes).sum();
        MemoryReport { supported: true, total, processes: rows, incomplete }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::MemoryReport;
    /// Memory attribution via responsible PID is macOS-only; unsupported on other platforms.
    pub fn report(_may_claim_session_webkit: bool) -> MemoryReport {
        MemoryReport { supported: false, total: 0, processes: Vec::new(), incomplete: false }
    }
}

/// Reports physical footprint for this app, WebKit processes, and child workers.
#[tauri::command]
pub fn process_memory() -> MemoryReport {
    imp::report(true)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::process_memory;

    // Tests PID enumeration, parent walk, and footprint read against the live process.
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
        // Catches zeroed struct without pinning machine-specific footprint.
        assert!(mine.bytes > 1_000_000, "footprint looks unread: {}", mine.bytes);
        assert_eq!(r.total, r.processes.iter().map(|p| p.bytes).sum::<u64>());
    }

    // Tests that non-host callers (may_claim_session_webkit=false) do not claim unrelated processes.
    #[test]
    fn does_not_claim_unrelated_processes() {
        let r = super::imp::report(false);
        // launchd is nobody's child and nobody's responsibility.
        assert!(!r.processes.iter().any(|p| p.pid == 1));
        assert!(r.processes.iter().all(|p| !p.role.starts_with("webview")));
    }
}
