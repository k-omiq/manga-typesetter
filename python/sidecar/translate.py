"""LLM translation (jp->en) reusing MangaTranslator's full BYOK provider set.

MangaTranslator's `core` package is NOT partially-importable: its
`core/__init__.py` eagerly imports the FLUX / skia / oxipng stack, which we don't
install. But its translation logic and the 10 provider endpoint callers
(Anthropic, OpenAI, Google, DeepSeek, xAI, Z.ai, Moonshot, Xiaomi MiMo,
OpenRouter, OpenAI-Compatible) are otherwise self-contained.

We make `core` importable WITHOUT running its heavy `__init__` by inserting a
stub `core` (and `core.image`/`core.services`) package into `sys.modules` with
the *real* `__path__`, so light submodules (`core.config`, `core.device`,
`core.caching`, `core.llm_defaults`) still load from disk, while the two heavy
leaf modules `translation.py` pulls (`image_utils`, `ocr_detection`) are
dummy-stubbed. We do TEXT->TEXT: the JP is already OCR'd by /analyze, so we drive
MangaTranslator's two-step *translation step* alone and never touch its
image/OCR machinery.

MangaTranslator is Apache-2.0 (compatible with this GPL-3 sidecar).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MT_DIR = _REPO_ROOT / "external" / "MangaTranslator"

# provider id -> TranslationConfig api-key field + a suggested (editable) model.
PROVIDERS = [
    {"id": "Anthropic", "key": "anthropic_api_key", "default_model": "claude-sonnet-4-5"},
    {"id": "OpenAI", "key": "openai_api_key", "default_model": "gpt-4o"},
    {"id": "Google", "key": "google_api_key", "default_model": "gemini-2.5-flash"},
    {"id": "DeepSeek", "key": "deepseek_api_key", "default_model": "deepseek-chat"},
    {"id": "xAI", "key": "xai_api_key", "default_model": "grok-4"},
    {"id": "OpenRouter", "key": "openrouter_api_key", "default_model": "anthropic/claude-sonnet-4.5"},
    {"id": "Z.ai", "key": "zai_api_key", "default_model": "glm-4.6"},
    {"id": "Moonshot AI", "key": "moonshot_api_key", "default_model": "kimi-k2-0905-preview"},
    {"id": "Xiaomi MiMo", "key": "mimo_api_key", "default_model": "mimo-7b-rl"},
    {"id": "OpenAI-Compatible", "key": "openai_compatible_api_key", "default_model": ""},
]
_KEY_FIELD = {p["id"]: p["key"] for p in PROVIDERS}

_mt = None  # cached (translation_module, TranslationConfig, sampling_defaults)


def _ensure_mt():
    """Install the import stubs once and return MangaTranslator's translation API."""
    global _mt
    if _mt is not None:
        return _mt

    if str(_MT_DIR) not in sys.path:
        sys.path.insert(0, str(_MT_DIR))

    # Stub `core` + subpackages as packages with the real __path__ so light
    # submodules load from disk but the heavy package __init__ never runs.
    for name, sub in (("core", "core"), ("core.image", "core/image"), ("core.services", "core/services")):
        if name not in sys.modules:
            m = types.ModuleType(name)
            m.__path__ = [str(_MT_DIR / sub)]
            sys.modules[name] = m

    # Dummy-stub the two heavy leaf modules translation.py imports but we never
    # call (text->text path bypasses all image/OCR work).
    if "core.image.image_utils" not in sys.modules:
        iu = types.ModuleType("core.image.image_utils")
        for fn in ("cv2_to_pil", "pil_to_cv2", "process_bubble_image_cached"):
            setattr(iu, fn, lambda *a, **k: None)
        sys.modules["core.image.image_utils"] = iu
    if "core.image.ocr_detection" not in sys.modules:
        od = types.ModuleType("core.image.ocr_detection")
        for fn in ("extract_text_with_manga_ocr", "extract_text_with_paddle_ocr_vl"):
            setattr(od, fn, lambda *a, **k: None)
        sys.modules["core.image.ocr_detection"] = od

    from core.config import TranslationConfig
    from core.llm_defaults import get_provider_sampling_defaults
    from core.services import translation

    _mt = (translation, TranslationConfig, get_provider_sampling_defaults)
    return _mt


def providers() -> list:
    """Provider catalogue for the UI (id + suggested default model)."""
    return [{"id": p["id"], "default_model": p["default_model"]} for p in PROVIDERS]


def _build_translation_prompt(texts: list, types_: list, output_language: str, special: str) -> str:
    """Mirror MangaTranslator's two-step *translation step* user prompt."""
    dialogue = [i + 1 for i, t in enumerate(types_) if t == "dialogue"]
    osb = [i + 1 for i, t in enumerate(types_) if t != "dialogue"]
    hints = []
    if dialogue:
        hints.append(f"Items [{', '.join(map(str, dialogue))}] contain spoken dialogue.")
    if osb:
        hints.append(
            f"Items [{', '.join(map(str, osb))}] contain sound effects, mimetic "
            "effects, narration, or internal monologues."
        )
    context_hints = ("\nNote: " + " ".join(hints) + " Translate them accordingly.") if hints else ""
    input_section = "\n## INPUT DATA\n" + "".join(f"{i + 1}: {t}\n" for i, t in enumerate(texts))
    special_section = (
        f"\n\n## SPECIAL INSTRUCTIONS\n{special.strip()}\n" if special and special.strip() else ""
    )
    return f"""
## CONTEXT
You have been provided with a list of {len(texts)} transcribed text segments from a manga page.
{context_hints}
{input_section}

## TASK
Apply your translation and styling rules to the text in the `## INPUT DATA` section.
The target language is {output_language}. Use the appropriate translation approach for each text type.{special_section}
"""


def translate_lines(
    lines: list,
    *,
    provider: str,
    model: str,
    api_key: str = "",
    base_url: str = "",
    output_language: str = "English",
    input_language: str = "Japanese",
    reading_direction: str = "rtl",
    special_instructions: str = "",
    reasoning_effort: Optional[str] = None,
    debug: bool = False,
) -> list:
    """Translate the JP text of each line. lines=[{n,type,jp}]; returns [{n,en}].

    Reuses MangaTranslator's real system prompt, per-provider generation config,
    endpoint dispatch and response parser. Empty-JP lines pass through as "".
    """
    if provider not in _KEY_FIELD:
        raise ValueError(f"unknown provider: {provider!r}")

    translation, TranslationConfig, sampling_defaults = _ensure_mt()

    items = [(l.get("n"), (l.get("jp") or "").strip(), l.get("type", "dialogue")) for l in lines]
    src = [(n, jp, ty) for (n, jp, ty) in items if jp]
    if not src:
        return [{"n": n, "en": ""} for (n, _, _) in items]

    texts = [jp for (_, jp, _) in src]
    types_ = [ty for (_, _, ty) in src]
    total = len(texts)

    cfg = TranslationConfig()
    cfg.provider = provider
    cfg.model_name = model
    cfg.translation_mode = "two-step"
    cfg.output_language = output_language
    cfg.input_language = input_language
    cfg.reading_direction = reading_direction
    cfg.send_full_page_context = False
    cfg.special_instructions = special_instructions or None
    if reasoning_effort:
        cfg.reasoning_effort = reasoning_effort
    setattr(cfg, _KEY_FIELD[provider], api_key or "")
    if provider == "OpenAI-Compatible" and base_url:
        cfg.openai_compatible_url = base_url

    sd = sampling_defaults(provider)
    cfg.temperature = float(sd["temperature"])
    cfg.top_p = float(sd["top_p"])
    cfg.top_k = int(sd["top_k"])

    system_prompt = translation._build_system_prompt_translation(
        output_language,
        mode="two-step",
        reading_direction=reading_direction,
        full_page_context=False,
    )
    prompt = _build_translation_prompt(texts, types_, output_language, special_instructions)

    response_text = translation._call_llm_endpoint(
        cfg, [], prompt, debug, system_prompt=system_prompt
    )
    parsed = translation._parse_llm_response_unified(
        response_text, total, provider + "-Translate", debug
    )

    by_n = {src[i][0]: parsed[i] for i in range(total)}
    return [{"n": n, "en": by_n.get(n, "")} for (n, _, _) in items]
