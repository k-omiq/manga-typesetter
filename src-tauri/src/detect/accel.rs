//! Chooses the execution provider (EP) every ONNX session runs on.
//!
//! One ladder per platform, tried top to bottom; the first provider that
//! actually registers wins, and the caller learns which one that was:
//!
//! - macOS: CoreML, then CPU.
//! - Windows: CUDA, then DirectML (any GPU), then CPU.
//! - Linux: CUDA, then WebGPU (any Vulkan GPU), then CPU. Each sits behind a
//!   cargo feature (`gpu-cuda`, `gpu-webgpu`) because pyke ships one prebuilt
//!   ONNX Runtime per provider, so a build carries exactly one of them.
//!
//! `ort` alone would swallow a failed registration and run the model on CPU
//! without saying so. Every registration here is `error_on_failure`, so a
//! missing CUDA runtime or a GPU-less VM is logged and stepped over, and the
//! reported device is the one the weights really loaded on.
//!
//! `MT_DEVICE=cpu|cuda|directml|webgpu|coreml` pins the ladder to one rung
//! (or none) for debugging a driver.
//!
//! Registering a provider is where its driver comes up (Dawn opens the Vulkan
//! ICD, CUDA loads cuDNN, CoreML compiles), and a broken driver can abort the
//! process right there rather than return an error. The first probe therefore
//! runs in child copies of this executable ([`probe_isolated`]) - one child per
//! rung, so a child that dies condemns only the rung it was asked about and the
//! real model load never touches that driver again. One crashed rung must not
//! cost the machine the rest of the ladder: a Windows box with a half-installed
//! CUDA still has DirectML, which works on any GPU.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use ort::ep::ExecutionProviderDispatch;
use ort::session::builder::SessionBuilder;
use ort::session::Session;

/// One rung of the ladder.
struct Candidate {
    /// Short device name shown to the user and matched against `MT_DEVICE`.
    name: &'static str,
    /// True when the provider copes with input shapes that change per run.
    /// CoreML and DirectML recompile on every new shape, which turns the OCR
    /// decoder's growing token sequence into a stall, so those keep the
    /// decoder on CPU.
    dynamic_shapes: bool,
    make: fn() -> ExecutionProviderDispatch,
}

#[cfg(any(feature = "gpu-cuda", target_os = "windows"))]
fn cuda() -> ExecutionProviderDispatch {
    ort::ep::CUDA::default().build()
}

#[cfg(target_os = "windows")]
fn directml() -> ExecutionProviderDispatch {
    ort::ep::DirectML::default().build()
}

#[cfg(feature = "gpu-webgpu")]
fn webgpu() -> ExecutionProviderDispatch {
    ort::ep::WebGPU::default().build()
}

#[cfg(target_os = "macos")]
fn coreml() -> ExecutionProviderDispatch {
    ort::ep::CoreML::default().build()
}

/// The providers this build was compiled with, fastest first.
const LADDER: &[Candidate] = &[
    #[cfg(any(feature = "gpu-cuda", target_os = "windows"))]
    Candidate {
        name: "cuda",
        dynamic_shapes: true,
        make: cuda,
    },
    #[cfg(target_os = "windows")]
    Candidate {
        name: "directml",
        dynamic_shapes: false,
        make: directml,
    },
    #[cfg(feature = "gpu-webgpu")]
    Candidate {
        name: "webgpu",
        dynamic_shapes: true,
        make: webgpu,
    },
    #[cfg(target_os = "macos")]
    Candidate {
        name: "coreml",
        dynamic_shapes: false,
        make: coreml,
    },
];

/// Device name reported when no provider registered.
pub const CPU: &str = "cpu";

/// Rungs whose driver has already taken a probe child down, as a bitmask of
/// indices into [`LADDER`]. Set for the rest of the run, so neither the probe
/// nor [`open`] touches that driver again - and only that one: the rungs below
/// it are still tried.
static DEAD_RUNGS: AtomicU32 = AtomicU32::new(0);

fn mark_dead(index: usize) {
    DEAD_RUNGS.fetch_or(1 << index, Ordering::Relaxed);
}

/// The rungs left after applying an `MT_DEVICE` override and dropping the ones
/// whose driver crashed, each with its index into [`LADDER`].
///
/// `None` is the normal ladder; `Some("cpu")` (or any unknown name) empties
/// it; a known name keeps only that rung.
fn ladder(pin: Option<&str>) -> Vec<(usize, &'static Candidate)> {
    ladder_from(DEAD_RUNGS.load(Ordering::Relaxed), pin)
}

/// [`ladder`] against an explicit dead-rung mask, so the filtering is testable
/// without writing to the process-wide one.
fn ladder_from(dead: u32, pin: Option<&str>) -> Vec<(usize, &'static Candidate)> {
    let pin = pin
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty());
    LADDER
        .iter()
        .enumerate()
        .filter(|(i, _)| dead & (1 << i) == 0)
        .filter(|(_, c)| match &pin {
            None => true,
            Some(p) => p == c.name,
        })
        .collect()
}

fn pinned() -> Option<String> {
    std::env::var("MT_DEVICE").ok()
}

/// Command-line flag that turns this executable into a bare device probe. It
/// takes the name of one rung as its argument: the child registers that
/// provider alone, prints its name if it took and nothing if it did not, and
/// exits. `main` checks for it before Tauri runs.
pub const PROBE_FLAG: &str = "--probe-device";

/// How long the whole probe gets, shared across the rungs it tries, before it
/// gives up and settles for what it has. CUDA's first init on a cold machine
/// can take a good ten seconds, and `detect_health` waits on this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// The best rung this machine can actually reach, each one tried in a child
/// process so an aborting driver cannot kill the app. Children inherit the
/// environment, so `MT_DEVICE` applies to them too.
///
/// A child that dies, times out, or cannot be started condemns its own rung
/// for the rest of the run ([`DEAD_RUNGS`]) and the next one is tried; a child
/// that answers with a rung name has proved that provider loads here.
pub fn probe_isolated() -> &'static str {
    let pin = pinned();
    let rungs = ladder(pin.as_deref());
    if rungs.is_empty() {
        return CPU;
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            log::warn!("cannot locate own executable for the device probe ({e}); probing in-process");
            return probe();
        }
    };
    // One budget for the whole ladder, not one per rung: `detect_health` waits
    // on this call, and a machine with two broken drivers must not hold the
    // settings dialog for twice the timeout.
    let deadline = Instant::now() + PROBE_TIMEOUT;
    for (i, c) in rungs {
        match run_probe_child(&exe, c.name, deadline) {
            Ok(answer) if answer == c.name => return c.name,
            Ok(_) => log::info!("{} is not usable on this machine", c.name),
            Err(e) => {
                log::warn!(
                    "the {} device probe {e}; that provider is skipped for the rest of this run",
                    c.name
                );
                mark_dead(i);
            }
        }
    }
    CPU
}

fn run_probe_child(exe: &Path, rung: &str, deadline: Instant) -> Result<String, String> {
    let mut child = Command::new(exe)
        .arg(PROBE_FLAG)
        .arg(rung)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start ({e})"))?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "ran past the {}s the whole ladder gets",
                    PROBE_TIMEOUT.as_secs()
                ));
            }
            Err(e) => return Err(format!("could not be waited on ({e})")),
        }
    };
    // One short line; the pipe holds it until we read.
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    if !status.success() {
        return Err(format!("child died with {status}"));
    }
    Ok(out.trim().to_string())
}

fn builder_with(candidate: Option<&Candidate>) -> ort::Result<SessionBuilder> {
    let builder = Session::builder()?;
    match candidate {
        None => Ok(builder),
        Some(c) => builder
            .with_execution_providers([(c.make)().error_on_failure()])
            .map_err(|e| ort::Error::new(e.to_string())),
    }
}

/// Loads a model on the best provider that accepts it.
///
/// `dynamic_shapes` says the model's input shape changes from run to run (the
/// OCR decoder); providers that recompile per shape are skipped for it.
/// Returns the session and the device name it landed on.
pub fn open(model: &Path, dynamic_shapes: bool) -> ort::Result<(Session, &'static str)> {
    let pin = pinned();
    for (_, c) in ladder(pin.as_deref()) {
        if dynamic_shapes && !c.dynamic_shapes {
            continue;
        }
        match builder_with(Some(c)).and_then(|mut b| b.commit_from_file(model)) {
            Ok(session) => {
                log::info!("{} loaded on {}", model.display(), c.name);
                return Ok((session, c.name));
            }
            Err(e) => log::warn!(
                "{} could not use {}, trying the next provider: {e}",
                model.display(),
                c.name
            ),
        }
    }
    let session = builder_with(None)?.commit_from_file(model)?;
    log::info!("{} loaded on {CPU}", model.display());
    Ok((session, CPU))
}

/// Name of the provider a model would load on right now, without loading one.
///
/// Registers each rung on a throwaway session builder; that is where a
/// provider dlopens its runtime (CUDA, cuDNN, Dawn), so a missing driver is
/// caught here just as it would be in [`open`]. A driver that aborts instead
/// of erroring takes the process with it, which is why [`probe_isolated`] is
/// what the app calls and this is only the in-process fallback.
pub fn probe() -> &'static str {
    let pin = pinned();
    ladder(pin.as_deref())
        .into_iter()
        .find(|(_, c)| registers(c))
        .map_or(CPU, |(_, c)| c.name)
}

/// The child side of the probe: register the one rung `name` asks for and
/// report whether it took, as its own name or the empty string.
///
/// An unknown name - a rung this build was not compiled with, or plain
/// nonsense - is empty too, so a parent can never be told a provider exists
/// because it asked the wrong question.
pub fn probe_rung(name: &str) -> &'static str {
    LADDER
        .iter()
        .find(|c| c.name == name)
        .filter(|c| registers(c))
        .map_or("", |c| c.name)
}

/// Whether this provider accepts a throwaway session builder here.
fn registers(c: &Candidate) -> bool {
    match builder_with(Some(c)) {
        Ok(_) => true,
        Err(e) => {
            log::info!("{} not usable on this machine: {e}", c.name);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_keeps_only_that_rung() {
        let all: Vec<_> = ladder(None).iter().map(|(_, c)| c.name).collect();
        assert_eq!(ladder(Some("")).len(), all.len());
        assert!(ladder(Some("cpu")).is_empty());
        assert!(ladder(Some("nonsense")).is_empty());
        for name in &all {
            let only: Vec<_> = ladder(Some(&name.to_uppercase()))
                .iter()
                .map(|(_, c)| c.name)
                .collect();
            assert_eq!(only, vec![*name]);
        }
    }

    /// The point of the per-rung mask: a crashed driver costs its own rung and
    /// nothing else, so a Windows machine whose CUDA aborts still reaches
    /// DirectML rather than dropping to CPU.
    #[test]
    fn a_crashed_rung_is_skipped_and_the_ones_below_it_survive() {
        for (i, c) in LADDER.iter().enumerate() {
            let left: Vec<_> = ladder_from(1 << i, None)
                .iter()
                .map(|(_, c)| c.name)
                .collect();
            assert!(!left.contains(&c.name), "{} should be skipped", c.name);
            assert_eq!(left.len(), LADDER.len() - 1);
        }
        let all_dead = (1u32 << LADDER.len()) - 1;
        assert!(ladder_from(all_dead, None).is_empty());
    }

    /// A dead rung stays dead however `MT_DEVICE` is set - asking for a driver
    /// that already crashed this run must not bring it back.
    #[test]
    fn a_crashed_rung_outranks_mt_device() {
        for (i, c) in LADDER.iter().enumerate() {
            assert!(ladder_from(1 << i, Some(c.name)).is_empty());
        }
    }

    /// The mask is a `u32` indexed by ladder position.
    #[test]
    fn every_rung_has_a_bit() {
        assert!(LADDER.len() < u32::BITS as usize);
    }

    /// A child that cannot be started at all is an error, not an answer; that
    /// is the path that marks a rung dead. Deliberately not a real binary:
    /// there is no portable stand-in for one that dies, and the exit-status
    /// branch is plumbing the ladder tests already cover the consequences of.
    #[test]
    fn a_probe_child_that_cannot_start_is_an_error() {
        let soon = Instant::now() + Duration::from_secs(5);
        assert!(run_probe_child(Path::new("/nonexistent/app"), "cuda", soon).is_err());
    }

    /// `probe_rung` answers for one rung only, and never invents one.
    #[test]
    fn an_unknown_rung_probes_to_nothing() {
        assert_eq!(probe_rung("nonsense"), "");
        assert_eq!(probe_rung(CPU), "");
        assert_eq!(probe_rung(""), "");
    }

    #[test]
    fn the_ladder_names_are_distinct_and_never_cpu() {
        let mut names: Vec<_> = LADDER.iter().map(|c| c.name).collect();
        assert!(!names.contains(&CPU));
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), LADDER.len());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn this_build_probes_coreml() {
        // Verifies the CoreML EP registers on a Mac, and that the probe
        // reports it rather than the compiled-in availability.
        if std::env::var_os("MT_DEVICE").is_none() {
            assert_eq!(probe(), "coreml");
            assert_eq!(probe_rung("coreml"), "coreml");
        }
    }

    /// Windows is the one target that compiles two GPU rungs, and their order
    /// is the whole point: CUDA is faster when it is really there, DirectML is
    /// the one that works on any GPU at all.
    #[test]
    #[cfg(target_os = "windows")]
    fn this_build_tries_cuda_then_directml() {
        let names: Vec<_> = LADDER.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["cuda", "directml"]);
    }
}
