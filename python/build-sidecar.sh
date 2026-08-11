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
# vendored source tree the sidecar loads at runtime:
#   - external/mokuro -> _internal/mokuro  (comic_text_detector)
# detect.py resolves it from sys._MEIPASS when frozen.
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
[[ -d "$MOKURO" ]] || { echo "error: vendored tree missing: $MOKURO" >&2; exit 1; }

OUT_DIR="$ROOT/src-tauri/binaries"
rm -rf "$OUT_DIR/mt-sidecar"
mkdir -p "$OUT_DIR"

# Stage a clean copy of the vendored tree (no .git / __pycache__ / *.pyc) so the
# bundle doesn't carry VCS history or stale bytecode.
STAGE="build-sidecar/vendor"
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' "$MOKURO/" "$STAGE/mokuro/"
MOKURO="$ROOT/python/$STAGE/mokuro"

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
  run_sidecar.py

echo ">> staged $OUT_DIR/mt-sidecar/ (binary: mt-sidecar)"
