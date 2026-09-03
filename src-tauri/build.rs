use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // Staging runs first: tauri_build resolves the bundle resources named by
    // tauri.<platform>.conf.json, and on Linux and Windows those point into
    // `gpu-libs/`. On a clean checkout that directory does not exist yet, so
    // resolving before staging fails the build outright.
    stage_gpu_libs();
    tauri_build::build();
}

/// ONNX Runtime's GPU execution providers are shared libraries the bundle has
/// to carry. ort-sys drops them into the cargo profile directory, which moves
/// with `--target`, so this copies the ones the app registers into
/// `gpu-libs/` where `tauri.<platform>.conf.json` can name them.
///
/// `bin/` holds libraries ONNX Runtime dlopens from the executable's own
/// directory (it derives the path from the executable, no search path); they
/// must land beside the binary. `lib/` holds libraries the executable links
/// against, found through the rpath set below. Both directories always exist,
/// empty or not, because the bundle configs name them as directories: an
/// empty directory bundles nothing, a glob with no match is an error.
fn stage_gpu_libs() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out; three up is the
    // profile directory, the same walk ort-sys's copy-dylibs takes.
    let profile_dir = out_dir.ancestors().nth(3).expect("cargo profile dir");
    let stage = Path::new(env!("CARGO_MANIFEST_DIR")).join("gpu-libs");
    let _ = fs::remove_dir_all(&stage);
    for sub in ["bin", "lib"] {
        fs::create_dir_all(stage.join(sub)).expect("create gpu-libs");
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let wanted: &[(&str, &str)] = match target_os.as_str() {
        "windows" => &[
            ("DirectML.dll", "bin"),
            ("onnxruntime_providers_shared.dll", "bin"),
            ("onnxruntime_providers_cuda.dll", "bin"),
        ],
        "linux" => &[
            ("libonnxruntime_providers_shared.so", "bin"),
            ("libonnxruntime_providers_cuda.so", "bin"),
            ("libwebgpu_dawn.so", "lib"),
        ],
        _ => &[],
    };
    for (name, sub) in wanted {
        let src = profile_dir.join(name);
        if !src.is_file() {
            continue;
        }
        // fs::copy follows the symlink ort-sys leaves, so the bundle gets a real file.
        fs::copy(&src, stage.join(sub).join(name))
            .unwrap_or_else(|e| panic!("stage {}: {e}", src.display()));
        println!("cargo:rerun-if-changed={}", src.display());
    }

    if target_os == "linux" {
        // Dev builds find the dawn library beside the binary; installed builds
        // find it under the resource dir tauri.linux.conf.json ships it to.
        println!(
            "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Manga Typesetter/gpu-libs/lib"
        );
        if env::var_os("CARGO_FEATURE_GPU_WEBGPU").is_none()
            && env::var_os("CARGO_FEATURE_GPU_CUDA").is_none()
        {
            println!(
                "cargo:warning=no GPU feature enabled: this Linux build runs detection on CPU \
                 (pass --features gpu-webgpu or gpu-cuda)"
            );
        }
    }
}
