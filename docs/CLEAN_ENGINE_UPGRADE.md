# Clean-engine upgrade — texture-faithful inpainting + Gen-Remove-class AI redraw

Status: **proposal / not yet implemented**. Research date 2026-07-28.
Supersedes nothing; extends the Phase 2 clean engine and the FLUX work in
[FLUX_PACKAGING.md](FLUX_PACKAGING.md).

---

## 1. The problem

FLUX cannot faithfully reproduce **textured, patterned regions** — screentone
lattices, crosshatching, gradient tones, patterned clothing. Photoshop's
Content-Aware Fill can. Separately, our "AI redraw" does not behave like
Photoshop's Generative Remove: it hallucinates and drifts instead of
reconstructing.

### Root cause: one engine doing two jobs

FLUX is a *generative* model — it synthesises plausible new content from a
semantic prior. Screentone is a *periodic signal*. A 4-step distilled diffusion
model blurs or re-phases periodic lattices; it has no mechanism to preserve
phase. This is category mismatch, not a tuning bug.

It is made worse by our MLX path specifically. FLUX.2 Klein has no fill variant,
so `MfluxInpainter` uses `flux2-edit` with a `"remove text"` prompt, which
**regenerates the whole crop** — measured 54% of outside-mask pixels drift >25 —
and we composite back under the mask. The under-mask content is therefore
generated in a drifted context, which costs both fidelity and boundary
continuity.

### The structural gap

`_classify_region` ([clean.py:220](../python/sidecar/clean.py)) is binary:

```python
method = "fill" if (uniform and not force_ai) else "flux"
```

Everything that is not flat falls straight to the generative engine. There is no
rung in between. Photoshop ships **two** engines and routes between them —
Content-Aware Fill preserves *real* texture at full resolution, Generative Remove
does semantic reconstruction. That missing middle is the whole bug.

---

## 2. Target architecture: a user-switchable engine ladder

Replace the binary choice with an ordered **ladder** of engines. Every rung is
independently installable, independently selectable, and the routing between
rungs is user-editable in Settings. "Auto" picks a rung; the user can move any
region up or down it.

| # | Engine (`method`) | What it is | Cost | Best at |
|---|---|---|---|---|
| 0 | `fill` | Median surround colour | ~0 | Flat paper, flat bubbles |
| 1 | `telea` / `ns` | OpenCV classical diffusion | ~0 | Tiny holes, fallback |
| 2 | `patchmatch` | Exemplar patch synthesis — copies **real** pixels | ~0.1–1s CPU | Dense screentone, hatching, repeating pattern |
| 3 | `lama` | Manga-finetuned LaMa (FFC, global receptive field) | <1s | Screentone + soft structure, gradients |
| 4 | `lama_pm` | SuperCAF hybrid: LaMa guide → guided PatchMatch upsample → curation | ~1–3s | Full-res texture fidelity — the true CAF equivalent |
| 5 | `flux` | Generative redraw (current) | 12s (MLX) – 170s (SDNQ) | Complex art, faces, occluded structure |
| 6 | `eraser` | Removal-tuned diffusion | seconds | Gen-Remove parity: erase, don't imagine |

Rungs 0/1/5 exist today. Rungs 2/3/4/6 are the upgrade.

Design rule: **every new rung is additive.** `_VALID_METHODS` grows, existing
saved projects keep working (layers store `method` as a string), and the
diffusers/SDNQ path stays untouched for Windows/CUDA — the same discipline that
made the MLX backend safe.

---

## 3. The engines

### 3.1 Rung 3 — manga-finetuned LaMa `[highest value / lowest risk]`

**[dreMaz/AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting)**
· `lama_large_512px.ckpt` · big-LaMa finetuned on 300k manga/anime images · MIT.

This is the de-facto standard for our exact task: it is the default inpainter in
[BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) and
comic-translate. The model card states it is substantially better on manga than
the older `lama_mpe`.

Why it fixes the texture problem specifically:

- LaMa is built on **fast Fourier convolutions**, giving an image-wide receptive
  field in the *early* layers. The paper's headline claim is robust reproduction
  of **repeating textures** — which is literally what screentone is.
- **Resolution-robust**: trained at 256px, generalises to high-res input. It can
  run at native page resolution rather than our crop-upscale-composite dance.
- ~50M params, ~200MB, sub-second on Apple Silicon (sub-second at 45MP via Core
  ML).

Operationally it is nearly free for us: **torch is already in the ML sidecar env**
(`requirements-ml.txt`). LaMa runs **in-process** next to detect/OCR — no uv env,
no child process, no proxy, no 10–25GB spike. None of the `flux.py` /
`flux_proxy.py` / mlx-env containment machinery applies.

Expected effect: most texture complaints resolve here, at ~1% of FLUX's cost.

### 3.2 Rung 2 — PatchMatch

Exemplar-based synthesis copies **real pixels** instead of hallucinating, which
is why PatchMatch still beats AI inpainting on texture fidelity at high
resolution. This is the closest thing to classic Content-Aware Fill.

- **[PyPatchMatch](https://github.com/vacancy/PyPatchMatch)** — MIT, maintained
  by the InvokeAI project, on PyPI. Requires C++ compilation against OpenCV.
- **[dmMaze/PyPatchMatchInpaint](https://github.com/dmMaze/PyPatchMatchInpaint)** —
  the BallonsTranslator fork. Appears Windows-oriented (`dllmain.cpp`); license
  and macOS/Apple-Silicon support **unconfirmed**.

The entire risk here is build integration — a compiled C extension inside our
PyInstaller `--onedir` bundle (see [FLUX_PACKAGING.md](FLUX_PACKAGING.md) for the
existing bundle constraints). Schedule it after LaMa lands.

### 3.3 Rung 4 — the Adobe blueprint (SuperCAF)

**["Inpainting at Modern Camera Resolution by Guided PatchMatch with
Auto-Curation"](https://arxiv.org/abs/2208.03552)** (ECCV 2022, UPenn + **Adobe
Research**, code: [owenzlz/SuperCAF](https://github.com/owenzlz/SuperCAF)) is
effectively Adobe publishing how modern Content-Aware Fill works:

1. LaMa fills the hole coarsely at low res — semantics and structure.
2. That fill becomes a **guide** for a multiply-guided PatchMatch that upsamples
   to full resolution using real pixels.
3. Generate 8 candidates; an **auto-curation** module picks the best via column
   summation on an 8×8 antisymmetric pairwise-preference matrix.

Reported up to **7.4×** quantitative improvement over LaMa alone, with user
studies overwhelmingly preferring it over 8 baselines. This composes rungs 2 and
3 — it is not a separate model download, so once both exist rung 4 is mostly
orchestration.

### 3.4 Rung 6 — removal-tuned diffusion (replaces `flux` for AI Remove)

Gen Remove's defining property is *predictable reconstruction rather than
hallucination*. Models trained to **erase** rather than to **imagine**:

- **[OmniEraser](https://github.com/PRIS-CV/Omnieraser)** — mask-only input (no
  prompt), weights + a ControlNet variant released for better background
  consistency.
- **[Attentive Eraser](https://arxiv.org/html/2412.12974v8)** — *tuning-free*;
  re-engineers self-attention (Attention Activation and Suppression) to
  prioritise background over foreground during reverse diffusion. Works on
  existing SD weights, so potentially no new download.
- **[ObjectClear](https://arxiv.org/html/2505.22636v1)** — also removes object
  *effects* (shadows/reflections). Less relevant for flat manga text, but the
  object-effect attention idea maps to text drop-shadows.

Also worth noting: **[Seamless Manga Inpainting with Semantics
Awareness](https://github.com/msxie92/MangaInpainting)** (SIGGRAPH 2021)
disentangles structural line from screentone in two phases (semantic inpainting
→ appearance synthesis). Architecturally the most *correct* approach for manga,
but it is 2021 research code with no maintained packaging — treat as a reference
implementation / stretch rung, not a shipping dependency.

---

## 4. Gen-Remove parity: five deltas

Independent of which model runs, our AI redraw needs these behavioural changes.
All five become **settings**, not hardcoded constants.

| # | Delta | Today | Target |
|---|---|---|---|
| 1 | **Mask-conditioned fill, not prompted edit** | `flux2-edit` + `"remove text"` prompt, 54% outside-mask drift | Mask-only removal model (rung 6), no prompt |
| 2 | **Adaptive dilation** | Fixed ~6px (`_FLUX_DILATE_KERNEL=(5,5)`, `iters=3`, [clean.py:90](../python/sidecar/clean.py)) | Dilation ∝ measured stroke width (distance transform of the glyph mask) |
| 3 | **Full-res compositing** | Hard clip at mask edge (`strict_mask_clipping`) | Poisson / seamless-clone blend + high-frequency detail transfer from surround |
| 4 | **Variations** | One shot | N candidates + auto-curation (§3.3), user picks |
| 5 | **Generous context** | `pad = max(6, 6% of box)` ([clean.py:144](../python/sidecar/clean.py)) — tight | Configurable, default much wider; removal models infer from surround |

Delta 2 was already flagged as a follow-up when we fixed the white-streak
ghosting — the fixed dilation was the *quick* fix, adaptive is the right one.

---

## 5. Routing: how "Auto" picks a rung

Extend `_classify_region` from a 2-way to a **4-class** surround classifier. The
existing `trim_std` / `tone_frac` / `near_extreme` logic already produces class
`flat`; the new work is separating `periodic` from `structured`.

| Class | Signal | Default rung |
|---|---|---|
| `flat` | `near_extreme && tone_frac ≤ max`, or `trim_std ≤ threshold` (existing) | 0 `fill` |
| `periodic` | **Sharp off-DC peak in the FFT** of the surround ring | 3 `lama` (→ 4 `lama_pm` when installed) |
| `textured` | High `trim_std`, broad spectrum, low edge density | 3 `lama` |
| `structured` | High edge density / line continuity crossing the mask | 5 `flux` / 6 `eraser` |

The **periodicity test** is the key new discriminator and needs no new
dependency — a 2D FFT of the ring/surround shows a sharp off-DC peak for
screentone and a broad, flat spectrum for illustrated art. A few lines of numpy:

```python
# sketch — surround patch → periodicity score in [0,1]
f = np.abs(np.fft.fftshift(np.fft.fft2(surround_gray - surround_gray.mean())))
f[cy-r0:cy+r0, cx-r0:cx+r0] = 0          # null the DC neighbourhood
score = f.max() / (f.mean() + 1e-6)      # sharp peak → high ratio
```

Return the class on the classify dict alongside the existing diagnostics
(`uniform`, `ring_std`, `tone_frac`) so the UI can show *why* a rung was chosen.

---

## 6. Settings surface — switching rungs up and down

This is the core UX requirement: **nothing is locked in.** Three levels of
control, coarse to fine.

### 6.1 Global preset (CleanPanel → Method dropdown)

Extend `METHODS` / `cleanMethod` ([CleanPanel.svelte:61](../src/lib/CleanPanel.svelte)):

| Preset | Behaviour |
|---|---|
| `Fast` | flat→`fill`, everything else→`telea`. No models. |
| `Balanced` *(new default)* | Routing table §5, ceiling at rung 3 `lama`. No FLUX. |
| `Best` | Full routing table, `lama_pm` for texture, `eraser`/`flux` for structure. |
| `AI redraw — every region` | Existing force-AI behaviour, now targeting the chosen AI engine. |
| `Custom…` | Opens the routing table editor (§6.2). |

Balanced-as-default is the headline change: **the common case stops touching
FLUX entirely**, which removes the 20GB spike and the multi-second wait from
ordinary pages.

### 6.2 Routing table editor (SettingsModal → new "Clean engines" card)

A 4-row table, one row per surround class, each with a dropdown of *installed*
rungs — same install-gating pattern as the current FLUX model picker
(`catalogue()` / `flux_valid_backend` in
[flux_models.py](../python/sidecar/flux_models.py), which only surfaces
provisionable backends). Uninstalled engines render disabled with an
**Install** action, exactly like the existing FLUX status row.

Same card carries the Gen-Remove knobs from §4:

- Mask dilation: `Auto (stroke-width)` | fixed px slider
- Context padding: % slider
- Variations: 1 / 3 / 8 (+ auto-curation toggle)
- Composite: `Hard clip` | `Feather` | `Seamless (Poisson)` | `Detail transfer`
- Full-res upsample: `Off` | `Guided PatchMatch`

### 6.3 Per-region / per-layer override

Two existing controls extend naturally:

- The per-layer `<select>` at
  [CleanPanel.svelte:278](../src/lib/CleanPanel.svelte) already lists `METHODS`
  — it just gains the new entries.
- The per-region re-clean button `↻`
  ([CleanPanel.svelte:239](../src/lib/CleanPanel.svelte)) becomes a **pair**:
  `↑` *escalate* (re-run one rung up) and `↓` *de-escalate*. This is the fastest
  possible fix loop: a region that came out soft gets bumped to `lama_pm` or
  `eraser` with one click; a region that got over-invented drops to `patchmatch`.

### 6.4 Brush tools

`BRUSH_LABEL` ([store.svelte.js:459](../src/lib/store.svelte.js)) gains entries
so the manual tools mirror the ladder:

| Tool | Engine |
|---|---|
| `Heal` | rung 2/3 — real-pixel/texture fill (was: `telea`) |
| `AI Remove` | rung 6 `eraser` (was: always `flux`) |

`app.brush.flux` generalises from a boolean to an engine id.

---

## 7. Implementation phases

Ordered by value-per-unit-risk. Each phase ships independently.

### Phase A — LaMa in-process `[do this first]`

- New `python/sidecar/lama.py`: load `lama_large_512px.ckpt`, expose the same
  `inpaint_mask(image_pil, mask, strict_mask_clipping)` contract that
  `MfluxInpainter` honours, so `_apply_region` dispatch stays uniform.
- `clean.py`: `_VALID_METHODS |= {"lama"}`; `_apply_region` branch; weights
  cached under `MODEL_DIR` so the existing Settings cache-size/clear covers it.
- `main.py`: `/clean` and `/clean/brush` accept `lama` in `method`.
- UI: `METHODS` gains `lama`; `Balanced` preset added and made default.
- **Exit criterion:** A/B against current FLUX output on a screentone-heavy page,
  same harness as `docs/flux-ab/page1_sdnq_vs_mflux.png`.

### Phase B — routing + Gen-Remove knobs

- FFT periodicity score → 4-class `_classify_region`, class on the response.
- Adaptive dilation from stroke width (replaces `_dilate_for_flux`'s fixed
  kernel; keep the fixed path as a settings option).
- Wider default context padding.
- Composite modes (feather / Poisson / detail transfer).
- Routing-table editor card in SettingsModal; `↑`/`↓` escalation buttons.

### Phase C — removal-tuned AI engine

- Evaluate Attentive Eraser first — tuning-free on existing SD weights means
  potentially no new download and no new env.
- If a new model is needed, reuse the `flux_proxy` child-process pattern
  wholesale; it already solves memory containment and crash isolation.
- `AI Remove` brush and the `structured` routing class point here.
- FLUX stays available as an explicit rung — this is additive.

### Phase D — PatchMatch + SuperCAF

- PyPatchMatch build integration (the real work: compiled extension in the
  `--onedir` PyInstaller bundle, macOS arm64 + Windows).
- Rung 2 `patchmatch`, then rung 4 `lama_pm` (guide → guided upsample →
  8-candidate curation).
- Gate behind an "advanced" install so a failed build never blocks the app.

---

## 8. Expected resource profile

Current, for reference: idle/OpenCV ~2–6GB · SDNQ-AI ~20–25GB · MLX-AI ~10–14GB.

| Rung | Added RAM | Per-region latency | Process |
|---|---|---|---|
| `fill` / `telea` | 0 | ~0 | in-process |
| `patchmatch` | <100MB | ~0.1–1s | in-process |
| `lama` | ~0.5GB | <1s | **in-process** |
| `lama_pm` | ~0.5GB | ~1–3s | in-process |
| `flux` (MLX) | ~10GB | ~12s | child |
| `flux` (SDNQ) | ~20GB | ~170s/MP | child |

The point of Balanced-by-default: the ordinary page never leaves the top three
rows.

---

## 9. Open questions / risks

1. **Unverified:** `lama_large_512px.ckpt` file size, and the MIT license beyond
   the model card's own claim. Confirm both before it ships in the bundle.
2. **Unverified:** `PyPatchMatchInpaint` license and macOS/Apple-Silicon support.
   PyPatchMatch (MIT, PyPI) is the safer base but still needs an OpenCV-linked
   C++ build.
3. **Core ML caveat:** LaMa converts to Core ML only at a **fixed** inference
   size. If we want Core ML acceleration we need resolution bucketing; plain
   torch/MPS avoids this and is likely fast enough.
4. **Curation is subjective.** SuperCAF's pairwise-preference module is trained;
   we may need a cheaper heuristic (e.g. spectral distance to the surround) or
   simply present N variations and let the user choose.
5. **Windows/CUDA parity.** LaMa is portable, so Phase A is safe everywhere.
   Phase D's compiled extension is the only genuine cross-platform risk.
6. **Settings-schema migration.** `app.brush.flux: boolean` → engine id, and
   `cleanMethod` gains values. Both need a read-side migration so existing
   projects/settings don't break.

---

## 10. Sources

- [Resolution-robust Large Mask Inpainting with Fourier Convolutions (LaMa)](https://arxiv.org/abs/2109.07161) · [project](https://advimman.github.io/lama-project/) · [code](https://github.com/advimman/lama)
- [dreMaz/AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting)
- [Inpainting at Modern Camera Resolution by Guided PatchMatch with Auto-Curation](https://arxiv.org/abs/2208.03552) · [SuperCAF](https://github.com/owenzlz/SuperCAF)
- [Seamless Manga Inpainting with Semantics Awareness](https://github.com/msxie92/MangaInpainting)
- [OmniEraser](https://github.com/PRIS-CV/Omnieraser) · [Attentive Eraser](https://arxiv.org/html/2412.12974v8) · [ObjectClear](https://arxiv.org/html/2505.22636v1)
- [PyPatchMatch](https://github.com/vacancy/PyPatchMatch) · [PyPatchMatchInpaint](https://github.com/dmMaze/PyPatchMatchInpaint)
- [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator/blob/master/CHANGELOG_EN.md) · [BallonsTranslator-Pro](https://github.com/thomaswantstobeaskeleton/BallonsTranslator-Pro)
- [PatchMatch vs AI Inpainting at high resolution](https://medium.com/@testth02/patchmatch-vs-ai-inpainting-why-patchmatch-still-excels-at-high-resolution-940184f2b697)
- [What's New in Photoshop 2026](https://www.photoshopnews.com/2026/04/04/whats-new-photoshop-2026-ai-assistant-generative-updates) · [Adobe: Content-Aware Fill](https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/remove-objects-with-content-aware-fill.html)
- [LaMa on Apple Silicon / Core ML](https://github.com/Sanster/IOPaint/discussions/314)
