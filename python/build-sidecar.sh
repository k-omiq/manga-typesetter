#!/usr/bin/env bash
# Build the `mt-sidecar` PyInstaller binary and stage it for the Tauri bundle.
#
# Output: src-tauri/binaries/mt-sidecar/  (a --onedir folder: the `mt-sidecar`
# executable plus its `_internal/` libs). Tauri ships this folder via
# `bundle.resources`; the Rust side launches it from the app's resource dir
# (see src-tauri/src/sidecar.rs).
#
# Why --onedir and not --onefile: the one-file bootloader extracts to a temp
# dir and re-execs, which deadlocks on macOS/arm64 + CPython 3.9 (processes
# wedge in an uninterruptible state and survive SIGKILL). --onedir is reliable.
#
# Phase 0: bundles only the service skeleton (fastapi/uvicorn). The ML stack
# (torch/ultralytics/manga-ocr + vendored external/ deps) is imported lazily by
# sidecar/detect.py; add those to requirements and the --collect-* flags here
# once they're in place to ship a detection-capable binary.
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

OUT_DIR="$ROOT/src-tauri/binaries"
rm -rf "$OUT_DIR/mt-sidecar"
mkdir -p "$OUT_DIR"

echo ">> building mt-sidecar (onedir)"
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
  run_sidecar.py

echo ">> staged $OUT_DIR/mt-sidecar/ (binary: mt-sidecar)"
