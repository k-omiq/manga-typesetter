# Replacing the Python sidecar with ONNX Runtime in Rust

**Date:** 2026-08-16
**Status:** approved, slice 1 in progress

## The problem

The app installs at 1.7 GB. Eleven megabytes of that is the app; the rest is a
Python sidecar built with PyInstaller, shipped so that three neural networks can
run.

Those three models serve exactly one feature — **Detect**: find the Japanese
text blocks on a page, read them, and put them into the Text Queue in reading
order. There is no cleaning, no inpainting and no translation in this app any
more, and nothing else uses the sidecar.

Three investigations settled what is actually needed. Their findings are the
basis of everything below.

### What the frontend consumes

`POST /analyze` returns `img_width`, `img_height`, `lines` and `panels`. Of
that, the app reads only:

```json
{
  "img_width": 1200,
  "img_height": 1800,
  "lines": [
    { "n": 1, "type": "dialogue", "jp": "…", "box": [820, 140, 930, 410], "vertical": true }
  ]
}
```

Three things follow, and each removes work from the migration:

- **The segmentation mask never leaves Python.** `detect.py` computes and
  refines it; `main.py` does not return it. Every balloon fit the app performs
  is already done in JavaScript against canvas pixels (`balloon.js`,
  `page-pixels.js`). The mask-refinement stage — local Otsu, connected
  components, morphology — is the most intricate postprocessing in the detector
  and it does not need to be ported at all.
- **`panels` is pass-through metadata.** The rectangles reach PSD and JSON
  exports and are never rendered or used for placement. What matters is the
  *order* they produce, not the boxes.
- **`en` and `font_size` are dead on the wire.** `en` is always `""` and the
  store hardcodes it; `font_size` is only used inside Python, to classify a line
  as `sfx` or `dialogue`.

### What in the bundle is dead weight

Verified against the installed packages, not inferred:

| package | size | status |
| --- | --- | --- |
| polars + `_polars_runtime_32` | 179 MB | dead — `ultralytics` imports it inside a function, for CSV export |
| unidic_lite | 248 MB | loaded, never used at inference (see below) |
| uv | 49 MB | a package installer that hitchhiked in the venv |
| sklearn | 16 MB | nothing on the path imports it |
| matplotlib | 15 MB | dead — lazy, inside a plotting decorator |
| torchvision | 5.9 MB | dead — only its version string is read |
| MangaTranslator | 2.1 MB | one file was vendored into `sidecar/sorting.py`; the whole tree got bundled |

The 248 MB of Japanese dictionary deserves its own note, because it is the
largest single passenger and the reason is not obvious.
`transformers/models/bert_japanese/tokenization_bert_japanese.py:134` builds a
MeCab tokenizer during `__init__`, guarded by `if do_word_tokenize:`. That
tokenizer segments Japanese *text* into words — which is an encoding operation.
OCR runs the other way: an image goes in and token ids come out, and decoding
them is `ids_to_tokens` followed by a string join. MeCab is never invoked at
inference. In Rust it disappears entirely: the decoder vocabulary for
`kha-white/manga-ocr-base` is character-level, 6,144 entries in a plain
`vocab.txt`, and turning ids into text is an indexed lookup.

None of this pruning is worth doing on its own. Every one of these packages
exists to support a Python runtime that this design deletes.

## The design

Run the three models from Rust with ONNX Runtime, through the `ort` crate.
Delete `python/`, the PyInstaller build, and `src-tauri/src/sidecar.rs` when the
last model is ported.

All three models already have published ONNX exports, so no conversion work is
needed:

| model | source | approximate size |
| --- | --- | --- |
| comic_text_detector | manga-image-translator release `beta-0.3` | 95 MB |
| manga109 panel YOLO | `deepghs/manga109_yolo`, `model.onnx` in the same repo | 101 MB |
| manga-ocr | `onnx-community/manga-ocr-base-ONNX`, INT8 encoder + decoder | ~117 MB |

Weights continue to download lazily into `~/.mangatypesetter/models` on first
Detect, exactly as they do now. They are not bundled and this design does not
change that.

### Why the panel model stays

It costs a whole second network to sort perhaps eight rectangles, which invites
the question of whether it could be dropped. It cannot, without a real
regression. `sorting.py` falls back to a global spatial sort when no panels are
given, which bands the whole page horizontally; on an ordinary two-panel tier
that reads right-top, left-top, right-bottom, left-bottom. Because the Text
Queue auto-advances as the letterer places lines, a wrong order is felt on every
multi-panel page. Under ONNX the model costs a 101 MB download and no
dependencies at all, so the objection to it disappears with the Python runtime.

### What replaces OpenCV

Nothing that needs a C++ toolchain. `image` for decode and colour conversion,
`fast_image_resize` for the letterbox and the 224×224 crop, `imageproc` for
morphology and thresholding where the detector still needs it. NMS and IoU are
about thirty lines each.

### Expected result

| | now | after |
| --- | --- | --- |
| installed app | 1.7 GB | ~50 MB |
| model downloads | ~920 MB | ~310 MB, or ~180 MB with INT8 OCR |

## Slices

Ordered so that the riskiest unknowns are proven first and each slice ships
something verifiable.

**Slice 1 — panel YOLO.** The easiest model and the one that proves the whole
stack: `ort` linking, ONNX Runtime binaries, CoreML on Apple Silicon, model
download and caching, and the Rust image pipeline. Single input, single forward
pass, ordinary NMS. Success is Rust producing the same panel rectangles as the
Python sidecar for the same page, within a small tolerance.

**Slice 2 — manga-ocr.** Two graphs, encoder and decoder, with an
autoregressive loop in Rust: run the encoder once, then feed tokens back into
the decoder until `[SEP]` or 300 tokens. The tokenizer is a `vocab.txt` lookup
plus the small post-processing `manga_ocr.ocr.post_process` performs (collapse
dot runs, half-width to full-width). `manga-ocr-rs` exists as a reference.

**Slice 3 — comic_text_detector.** The hardest, and smaller than it looks now
that the mask is out of scope: letterbox to 1024, YOLO decode with NMS, DBNet
polygon extraction and unclipping, then the grouping heuristic that turns line
polygons into text blocks with a `vertical` flag and a `font_size`.

**Slice 4 — removal.** Delete the Python tree, the PyInstaller build script,
`sidecar.rs` and the sidecar lifecycle in `lib.rs`. Keep the Settings model
cache panel, repointed at the ONNX cache.

## Verification

Each ported model is checked against the Python sidecar on the same input, on
real pages, before the Python path is removed. The sidecar can run locally
throughout, which makes a golden-output comparison cheap: capture the Python
output as JSON, assert the Rust output matches within tolerance. No slice is
complete on "it looks right".

## Risks

- **Postprocessing fidelity in the detector.** DBNet polygon unclipping and the
  line-to-block grouping are heuristic and fiddly. Golden tests against captured
  Python output are the mitigation, and the mask work being out of scope removes
  the worst of it.
- **INT8 OCR accuracy.** The quantized encoder and decoder are a third of the
  size of the FP32 pair. Accuracy has to be compared on real pages before it is
  adopted; FP32 is the fallback and costs only download size.
- **CoreML coverage.** `ort` can offload to the Neural Engine, but not every
  operator is supported and it falls back to CPU per subgraph. This is a
  performance question, not a correctness one, and CPU is the baseline.
