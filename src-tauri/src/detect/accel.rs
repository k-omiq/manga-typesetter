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

use std::path::Path;

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

/// The rungs left after applying an `MT_DEVICE` override, in order.
///
/// `None` is the normal ladder; `Some("cpu")` (or any unknown name) empties
/// it; a known name keeps only that rung.
fn ladder(pin: Option<&str>) -> Vec<&'static Candidate> {
    match pin.map(|p| p.trim().to_ascii_lowercase()) {
        None => LADDER.iter().collect(),
        Some(p) if p.is_empty() => LADDER.iter().collect(),
        Some(p) => LADDER.iter().filter(|c| c.name == p).collect(),
    }
}

fn pinned() -> Option<String> {
    std::env::var("MT_DEVICE").ok()
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
    for c in ladder(pin.as_deref()) {
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
/// caught here just as it would be in [`open`].
pub fn probe() -> &'static str {
    let pin = pinned();
    ladder(pin.as_deref())
        .into_iter()
        .find(|c| match builder_with(Some(c)) {
            Ok(_) => true,
            Err(e) => {
                log::info!("{} not usable on this machine: {e}", c.name);
                false
            }
        })
        .map_or(CPU, |c| c.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_keeps_only_that_rung() {
        let all: Vec<_> = ladder(None).iter().map(|c| c.name).collect();
        assert_eq!(ladder(Some("")).len(), all.len());
        assert!(ladder(Some("cpu")).is_empty());
        assert!(ladder(Some("nonsense")).is_empty());
        for name in &all {
            let only: Vec<_> = ladder(Some(&name.to_uppercase()))
                .iter()
                .map(|c| c.name)
                .collect();
            assert_eq!(only, vec![*name]);
        }
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
        }
    }
}
