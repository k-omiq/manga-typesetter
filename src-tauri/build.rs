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
    let webgpu = env::var_os("CARGO_FEATURE_GPU_WEBGPU").is_some();
    let cuda = env::var_os("CARGO_FEATURE_GPU_CUDA").is_some();
    // Only the libraries THIS configuration's providers actually need. A
    // CPU-only Linux build wants none; a Windows build always wants all three,
    // because `ort`'s Windows target turns on CUDA and DirectML unconditionally
    // (see Cargo.toml) and the ladder in src/detect/accel.rs registers both.
    let wanted: &[(&str, &str)] = match target_os.as_str() {
        "windows" => &[
            ("DirectML.dll", "bin"),
            ("onnxruntime_providers_shared.dll", "bin"),
            ("onnxruntime_providers_cuda.dll", "bin"),
        ],
        "linux" if cuda => &[
            ("libonnxruntime_providers_shared.so", "bin"),
            ("libonnxruntime_providers_cuda.so", "bin"),
        ],
        "linux" if webgpu => &[("libwebgpu_dawn.so", "lib")],
        _ => &[],
    };
    // Only a bundle can ship a library, and only `--release` produces one, so
    // that is where an unstageable library is fatal rather than a warning. A
    // `cargo check` or a dev build has nothing to ship and no reason to stop -
    // and it routinely sees this legitimately, because a restored build cache
    // leaves ort-sys's symlinks in the profile directory pointing at an OUT_DIR
    // the cache pruned.
    let fatal = env::var("PROFILE").as_deref() == Ok("release");
    for (name, sub) in wanted {
        let src = profile_dir.join(name);
        // Loud, because every way this goes missing is silent downstream.
        // `DirectML.dll` is a load-time import of the executable on Windows
        // (ort-sys emits `rustc-link-lib=DirectML`), so a bundle without it
        // beside the binary either refuses to start or quietly binds to
        // whatever older copy Windows has in System32. The provider libraries
        // are dlopened, so losing one only downgrades the ladder a rung - just
        // as invisibly.
        if let Err(e) = fs::copy(&src, stage.join(sub).join(name)) {
            // `is_file` and `fs::copy` both follow the symlink ort-sys leaves,
            // which is also what makes the bundle get a real file rather than a
            // link - so say plainly which of the two failure shapes this is.
            let shape = match src.symlink_metadata() {
                Err(_) => "it is not there at all".to_string(),
                Ok(m) if m.is_symlink() => format!(
                    "it is a symlink to {}, which does not resolve",
                    fs::read_link(&src).map_or_else(
                        |e| format!("<unreadable: {e}>"),
                        |t| t.display().to_string()
                    )
                ),
                Ok(_) => format!("it is there but could not be read ({e})"),
            };
            let msg = format!(
                "cannot stage {name} from {}: {shape}. The {target_os} bundle needs it beside \
                 the executable. ort-sys puts the execution providers there, so a restored \
                 build cache that pruned its OUT_DIR is the usual cause: \
                 `cargo clean -p ort-sys`, or clear the CI cargo cache.",
                profile_dir.display()
            );
            assert!(!fatal, "{msg}");
            println!("cargo:warning={msg}");
            continue;
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }

    if target_os == "linux" {
        // Dev builds find the dawn library beside the binary; installed builds
        // find it under the resource dir tauri.linux.conf.json ships it to.
        println!(
            "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/Manga Typesetter/gpu-libs/lib"
        );
        if !webgpu && !cuda {
            println!(
                "cargo:warning=CPU-only Linux build: detection runs on CPU. This is the \
                 release's default lane; pass --features gpu-webgpu or gpu-cuda for the GPU lane"
            );
        }
    }
}
