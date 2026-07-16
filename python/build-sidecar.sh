#!/usr/bin/env bash
# Build the `mt-sidecar` PyInstaller binary and stage it for the Tauri bundle.
#
# Output: src-tauri/binaries/mt-sidecar/  (a --onedir folder: the `mt-sidecar`
# executable plus its `_internal/` libs). Tauri ships this folder via
# `bundle.resources`; the Rust side launches it from the app's resource dir
# (see src-tauri/src/sidecar.rs).
#
# Why --onedir and not --onefile: the one-file bootloader extracts to a temp
# dir and re-execs, which deadlocks on macOS/arm64 (processes wedge in an
# uninterruptible state and survive SIGKILL). --onedir is reliable.
#
# This build is ML-CAPABLE: it collects the detection/OCR stack (torch, opencv,
# manga-ocr, transformers, ultralytics, scipy, huggingface_hub) and bundles the
# two vendored source trees the sidecar loads at runtime:
#   - external/mokuro          -> _internal/mokuro          (comic_text_detector)
#   - external/MangaTranslator -> _internal/MangaTranslator (translation providers)
# detect.py / translate.py / flux.py resolve these from sys._MEIPASS when frozen.
#
# NOT bundled (opt-in / heavy): the FLUX diffusers/sdnq stack + model weights.
# Instead the app provisions those on demand into an EXTERNAL uv-managed venv and
# runs FLUX in a separate `mt-flux` process (see docs/FLUX_PACKAGING.md). For that
# we stage two lightweight things into the bundle:
#   - flux_sidecar/  -> _internal/flux_sidecar  (the mt-flux process, as *source*,
#     run by the external venv's real interpreter — not the frozen one)
#   - the `uv` binary -> _internal/uv/uv        (provisions the venv with no system
#     Python; flux._uv_bin() finds it via sys._MEIPASS)
set -euo pipefail

cd "$(dirname "$0")"                      # python/
ROOT="$(cd .. && pwd)"
VENV="${VENV:-.venv}"
PY="$VENV/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "error: $PY not found — create the venv and install deps first:" >&2
  echo "  python3 -m venv $VENV && $VENV/bin/pip install -r requirements.txt pyinstaller" >&2
  exit 1
fi

MOKURO="$ROOT/external/mokuro"
MT="$ROOT/external/MangaTranslator"
for d in "$MOKURO" "$MT"; do
  [[ -d "$d" ]] || { echo "error: vendored tree missing: $d" >&2; exit 1; }
done

OUT_DIR="$ROOT/src-tauri/binaries"
rm -rf "$OUT_DIR/mt-sidecar"
mkdir -p "$OUT_DIR"

# Stage clean copies of the vendored trees (no .git / __pycache__ / *.pyc) so the
# bundle doesn't carry VCS history or stale bytecode.
STAGE="build-sidecar/vendor"
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' "$MOKURO/" "$STAGE/mokuro/"
rsync -a --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' "$MT/" "$STAGE/MangaTranslator/"
# The mt-flux process ships as source (run by the external venv's interpreter).
rsync -a --exclude '__pycache__' --exclude '*.pyc' "$ROOT/python/flux_sidecar/" "$STAGE/flux_sidecar/"
MOKURO="$ROOT/python/$STAGE/mokuro"
MT="$ROOT/python/$STAGE/MangaTranslator"
FLUX_SRC="$ROOT/python/$STAGE/flux_sidecar"

# Resolve a `uv` binary to bundle (provisions the external FLUX venv on demand,
# with no system Python). Prefer an explicit $UV, then the build venv, then PATH.
UV_BIN="${UV:-}"
[[ -z "$UV_BIN" && -x "$VENV/bin/uv" ]] && UV_BIN="$VENV/bin/uv"
[[ -z "$UV_BIN" ]] && UV_BIN="$(command -v uv || true)"
if [[ -z "$UV_BIN" || ! -x "$UV_BIN" ]]; then
  echo "error: no \`uv\` binary found to bundle (needed for opt-in FLUX provisioning)." >&2
  echo "  install uv (https://docs.astral.sh/uv/) or set UV=/path/to/uv, then re-run." >&2
  exit 1
fi
# Absolutise — PyInstaller resolves --add-binary sources against the spec dir, not
# the cwd, so a relative path (e.g. .venv/bin/uv) would not be found.
UV_BIN="$(cd "$(dirname "$UV_BIN")" && pwd)/$(basename "$UV_BIN")"
echo ">> bundling uv from: $UV_BIN"

echo ">> building mt-sidecar (onedir, ML-capable)"
"$PY" -m PyInstaller \
  --noconfirm --clean --onedir \
  --name mt-sidecar \
  --distpath "$OUT_DIR" \
  --workpath build-sidecar \
  --specpath build-sidecar \
  --hidden-import sidecar.main \
  --hidden-import uvicorn.loops.asyncio \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.protocols.websockets.websockets_impl \
  --hidden-import uvicorn.lifespan.on \
  --exclude-module uvloop \
  --exclude-module httptools \
  --collect-all torch \
  --collect-all torchvision \
  --collect-all cv2 \
  --collect-all numpy \
  --collect-all scipy \
  --collect-all PIL \
  --collect-all manga_ocr \
  --collect-all transformers \
  --collect-all tokenizers \
  --collect-all safetensors \
  --collect-all huggingface_hub \
  --collect-all ultralytics \
  --collect-all requests \
  --collect-all torchsummary \
  --collect-all shapely \
  --collect-all pyclipper \
  --collect-all tqdm \
  --collect-all jaconv \
  --collect-all loguru \
  --collect-all fugashi \
  --collect-all unidic_lite \
  --hidden-import pkg_resources \
  --add-data "$MOKURO:mokuro" \
  --add-data "$MT:MangaTranslator" \
  --add-data "$FLUX_SRC:flux_sidecar" \
  --add-binary "$UV_BIN:uv" \
  run_sidecar.py

echo ">> staged $OUT_DIR/mt-sidecar/ (binary: mt-sidecar)"
