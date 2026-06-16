# Manga Typesetter — Python sidecar

A local FastAPI service (bound to `127.0.0.1`) that the Tauri app spawns and talks
to over HTTP. It hosts the ML pipeline: text detection + OCR (mokuro /
comic-text-detector + manga-ocr), smart cleaning / inpainting (OpenCV + optional
FLUX), and optional BYOK LLM translation (MangaTranslator providers).

## License

This sidecar links **mokuro (GPL-3.0)** and is therefore distributed under
**GPL-3.0**. It runs as a *separate process* and communicates with the Tauri app
only over HTTP, so the app itself is not a derivative work of the GPL code.
`MangaTranslator` code is Apache-2.0 (compatible).

Vendored sources live under `external/` at the repo root:
- `external/mokuro` (+ its `comic_text_detector` submodule)
- `external/MangaTranslator`

## Run (dev)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m sidecar            # serves http://127.0.0.1:8765
```

`GET /health` → `{ "status": "ok", ... }`.

## Packaging

Shipped as a PyInstaller one-file binary (`mt-sidecar[.exe]`) registered as a
Tauri sidecar (`externalBin`). The build pins Python 3.11/3.12 (torch / manga-ocr
wheels are not yet available for 3.14).

## Phase status

Phase 0: `/health` only. Detection/OCR/clean/translate endpoints land in later
phases.
