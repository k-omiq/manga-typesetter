//! manga-ocr (`kha-white/manga-ocr-base`) in Rust.
//!
//! What it is for: reading the Japanese out of a detected text block. It is a
//! VisionEncoderDecoder — a ViT-base encoder over a 224x224 crop, and a
//! two-layer BERT decoder that emits one character per step from a 6144-entry
//! character vocabulary.
//!
//! In Python this cost `transformers` + `torch` + `jaconv`, most of the
//! sidecar's weight. The published ONNX export splits the model into two
//! graphs, `encoder_model.onnx` and `decoder_model.onnx`, and neither needs
//! anything from `transformers` at run time. What *does* have to come across is
//! everything `transformers` was doing *around* the two graphs, because none of
//! it lives in them:
//!
//!   * the exact PIL preprocessing (`convert("L")`, bilinear resize to 224),
//!   * beam search — four beams, no-repeat-trigrams, length penalty 2.0 —
//!     which is `generate()`'s default here and is *not* greedy decoding, and
//!   * `manga_ocr.ocr.post_process`, including the `jaconv.h2z` call.
//!
//! Every one of those changes the output string, so all three are ported here
//! rather than approximated. The golden test at the bottom is what holds the
//! port to that claim: 34 real crops, each compared against what the Python
//! sidecar returned for it on this machine.

use std::path::Path;

use image::DynamicImage;
use ort::session::Session;
use ort::value::Tensor;

/// The square input the ViT encoder was exported at (`preprocessor_config.json`,
/// `size = {height: 224, width: 224}`).
pub const INPUT_SIZE: usize = 224;

/// Special-token ids, from the head of `vocab.txt`:
/// `[PAD]=0 [UNK]=1 [CLS]=2 [SEP]=3 [MASK]=4`.
///
/// `generation_config.json` names them the other way round —
/// `decoder_start_token_id=2`, `eos_token_id=3`, `pad_token_id=0` — which is
/// the same three ids under different jobs.
const CLS_TOKEN: i64 = 2;
const EOS_TOKEN: i64 = 3;
/// Ids `0..=4` are `all_special_ids`; `tokenizer.decode(skip_special_tokens=True)`
/// drops exactly these. The `<unused0..>` entries that follow are *not* special.
const FIRST_ORDINARY_TOKEN: i64 = 5;

/// `generation_config.json`, verbatim. These are not tuning knobs — they are
/// what `model.generate()` used to produce the golden strings, so changing any
/// of them changes the output.
const NUM_BEAMS: usize = 4;
const MAX_LENGTH: usize = 300;
const LENGTH_PENALTY: f64 = 2.0;
const NO_REPEAT_NGRAM_SIZE: usize = 3;

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/// Pillow's `convert("L")`, exactly.
///
/// ITU-R 601-2 luma in fixed point, which is what `Convert.c` actually does:
/// `L24(rgb) = r*19595 + g*38470 + b*7471 + 0x8000`, then `>> 16`. The
/// half-ulp `0x8000` makes it round-to-nearest rather than truncate, and the
/// integer weights are `round(0.299 * 65536)` and friends — so computing this
/// in floating point from `0.299/0.587/0.114` disagrees with Pillow on a thin
/// band of inputs. On a near-monochrome manga crop that band is small, but it
/// is not empty, and one flipped pixel is enough to move a borderline beam.
pub fn pil_luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 19595 + g as u32 * 38470 + b as u32 * 7471 + 0x8000) >> 16) as u8
}

/// Pillow's fixed-point precision for 8-bit resampling (`Resample.c`:
/// `PRECISION_BITS = 32 - 8 - 2`).
const PRECISION_BITS: i32 = 32 - 8 - 2;

/// `clip8` from `Resample.c`: arithmetic-shift down out of fixed point, then
/// clamp. Pillow does the clamp with a lookup table covering -640..639; the
/// clamp is the whole content of that table.
fn clip8(v: i32) -> u8 {
    (v >> PRECISION_BITS).clamp(0, 255) as u8
}

/// Per-output-pixel filter taps for one axis, in Pillow's layout.
///
/// `bounds[i]` is `(xmin, xmax)` — the first source index and the *count* of
/// taps — and `kk[i * ksize .. ]` holds the fixed-point weights.
struct Coeffs {
    ksize: usize,
    bounds: Vec<(usize, usize)>,
    kk: Vec<i32>,
}

/// Port of Pillow's `precompute_coeffs` + `normalize_coeffs_8bpc` for the
/// bilinear filter (`support = 1.0`).
///
/// The two details that a naive bilinear gets wrong: when downscaling, the
/// filter *widens* with the scale factor (`filterscale`), which is what makes
/// PIL's downscale antialiased rather than a point sample; and the weights are
/// rounded to 22-bit fixed point *before* being applied, so the arithmetic is
/// integer from there on. A float bilinear differs from this by ±1 on many
/// pixels, which is exactly the kind of drift that flips an ambiguous glyph.
fn precompute_coeffs(in_size: usize, out_size: usize) -> Coeffs {
    let scale = in_size as f64 / out_size as f64;
    let filterscale = if scale < 1.0 { 1.0 } else { scale };
    let support = 1.0 * filterscale; // bilinear_filter's support is 1.0
    let ksize = (support.ceil() as usize) * 2 + 1;

    let mut bounds = Vec::with_capacity(out_size);
    let mut kk = vec![0i32; out_size * ksize];
    let mut k = vec![0f64; ksize];

    for xx in 0..out_size {
        let center = (xx as f64 + 0.5) * scale;
        let ss = 1.0 / filterscale;

        // Pillow rounds these by adding 0.5 and truncating toward zero. Both
        // values are non-negative here, so `as usize` is that truncation.
        let xmin = ((center - support + 0.5).max(0.0)) as usize;
        let xmax = {
            let raw = (center + support + 0.5) as usize;
            raw.min(in_size) - xmin
        };

        let mut ww = 0f64;
        for (x, slot) in k.iter_mut().enumerate().take(xmax) {
            // bilinear_filter(x): 1 - |x| for |x| < 1, else 0.
            let t = ((x + xmin) as f64 - center + 0.5) * ss;
            let w = if t.abs() < 1.0 { 1.0 - t.abs() } else { 0.0 };
            *slot = w;
            ww += w;
        }
        if ww != 0.0 {
            for slot in k.iter_mut().take(xmax) {
                *slot /= ww;
            }
        }
        for slot in k.iter_mut().skip(xmax) {
            *slot = 0.0;
        }

        for x in 0..ksize {
            // `normalize_coeffs_8bpc` rounds away from zero.
            let scaled = k[x] * (1i64 << PRECISION_BITS) as f64;
            kk[xx * ksize + x] = if scaled < 0.0 { (scaled - 0.5) as i32 } else { (scaled + 0.5) as i32 };
        }
        bounds.push((xmin, xmax));
    }

    Coeffs { ksize, bounds, kk }
}

/// Pillow's `Image.resize(..., resample=BILINEAR)` for a single 8-bit plane.
///
/// Two passes, horizontal then vertical, through an 8-bit intermediate — the
/// same order and the same intermediate precision Pillow uses. Doing it in one
/// separable float pass instead would be *more* accurate and would not match.
pub fn pil_bilinear_resize(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    let horiz = precompute_coeffs(w, ow);
    let vert = precompute_coeffs(h, oh);

    // Horizontal: w x h -> ow x h.
    let mut tmp = vec![0u8; ow * h];
    for y in 0..h {
        for xx in 0..ow {
            let (xmin, xmax) = horiz.bounds[xx];
            let k = &horiz.kk[xx * horiz.ksize..];
            let mut ss = 1i32 << (PRECISION_BITS - 1);
            for x in 0..xmax {
                ss += src[y * w + xmin + x] as i32 * k[x];
            }
            tmp[y * ow + xx] = clip8(ss);
        }
    }

    // Vertical: ow x h -> ow x oh.
    let mut out = vec![0u8; ow * oh];
    for yy in 0..oh {
        let (ymin, ymax) = vert.bounds[yy];
        let k = &vert.kk[yy * vert.ksize..];
        for xx in 0..ow {
            let mut ss = 1i32 << (PRECISION_BITS - 1);
            for y in 0..ymax {
                ss += tmp[(ymin + y) * ow + xx] as i32 * k[y];
            }
            out[yy * ow + xx] = clip8(ss);
        }
    }

    out
}

/// Turn a crop into the encoder's `pixel_values`: `[1, 3, 224, 224]`, NCHW.
///
/// The Python path is `img.convert("L").convert("RGB")` and then
/// `ViTImageProcessor`, which resizes the (now three identical channels) with
/// PIL bilinear, rescales by 1/255 and normalises with mean 0.5 / std 0.5. The
/// resize is done here on the single luma plane and the result replicated,
/// which is arithmetically identical to resizing three equal channels and much
/// less work.
pub fn preprocess(img: &DynamicImage) -> Vec<f32> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let mut plane = vec![0u8; w * h];
    for (i, px) in rgb.pixels().enumerate() {
        plane[i] = pil_luma(px.0[0], px.0[1], px.0[2]);
    }

    let small = pil_bilinear_resize(&plane, w, h, INPUT_SIZE, INPUT_SIZE);

    let n = INPUT_SIZE * INPUT_SIZE;
    let mut out = vec![0f32; 3 * n];
    for i in 0..n {
        // rescale by 1/255, then (x - 0.5) / 0.5.
        let v = (small[i] as f32 / 255.0 - 0.5) / 0.5;
        out[i] = v;
        out[n + i] = v;
        out[2 * n + i] = v;
    }
    out
}

// ---------------------------------------------------------------------------
// Detokenising and post-processing
// ---------------------------------------------------------------------------

/// `jaconv`'s half-width-katakana-with-dakuten pairs, in `_conv_dakuten`'s own
/// order. Applied as sequential whole-string replacements before the per-char
/// table, because these are two source characters collapsing into one.
const DAKUTEN_PAIRS: &[(&str, &str)] = &[
    ("ｶﾞ", "ガ"), ("ｷﾞ", "ギ"), ("ｸﾞ", "グ"), ("ｹﾞ", "ゲ"),
    ("ｺﾞ", "ゴ"), ("ｻﾞ", "ザ"), ("ｼﾞ", "ジ"), ("ｽﾞ", "ズ"),
    ("ｾﾞ", "ゼ"), ("ｿﾞ", "ゾ"), ("ﾀﾞ", "ダ"), ("ﾁﾞ", "ヂ"),
    ("ﾂﾞ", "ヅ"), ("ﾃﾞ", "デ"), ("ﾄﾞ", "ド"), ("ﾊﾞ", "バ"),
    ("ﾋﾞ", "ビ"), ("ﾌﾞ", "ブ"), ("ﾍﾞ", "ベ"), ("ﾎﾞ", "ボ"),
    ("ﾊﾟ", "パ"), ("ﾋﾟ", "ピ"), ("ﾌﾟ", "プ"), ("ﾍﾟ", "ペ"),
    ("ﾎﾟ", "ポ"), ("ｳﾞ", "ヴ"),
];

/// `jaconv`'s `HALF_KANA_SEION -> FULL_KANA_SEION` pairs, minus the ones that
/// map a character to itself (`ヮヰヱヵヶヽヾ` appear in both lists at the same
/// index, so they are no-ops).
///
/// The half-width voiced marks U+FF9E and U+FF9F are absent on purpose, not by
/// oversight: `jaconv`'s `HALF_KANA_SEION` does not list them either, so a mark
/// [`DAKUTEN_PAIRS`] could not fold into the kana before it comes out
/// unchanged. Adding `U+FF9E -> U+309B` here would look like parity and be a
/// divergence — see the test below.
const HALF_TO_FULL_KANA: &[(char, char)] = &[
    ('\u{FF67}', '\u{30A1}'), ('\u{FF71}', '\u{30A2}'), ('\u{FF68}', '\u{30A3}'),
    ('\u{FF72}', '\u{30A4}'), ('\u{FF69}', '\u{30A5}'), ('\u{FF73}', '\u{30A6}'),
    ('\u{FF6A}', '\u{30A7}'), ('\u{FF74}', '\u{30A8}'), ('\u{FF6B}', '\u{30A9}'),
    ('\u{FF75}', '\u{30AA}'), ('\u{FF76}', '\u{30AB}'), ('\u{FF77}', '\u{30AD}'),
    ('\u{FF78}', '\u{30AF}'), ('\u{FF79}', '\u{30B1}'), ('\u{FF7A}', '\u{30B3}'),
    ('\u{FF7B}', '\u{30B5}'), ('\u{FF7C}', '\u{30B7}'), ('\u{FF7D}', '\u{30B9}'),
    ('\u{FF7E}', '\u{30BB}'), ('\u{FF7F}', '\u{30BD}'), ('\u{FF80}', '\u{30BF}'),
    ('\u{FF81}', '\u{30C1}'), ('\u{FF6F}', '\u{30C3}'), ('\u{FF82}', '\u{30C4}'),
    ('\u{FF83}', '\u{30C6}'), ('\u{FF84}', '\u{30C8}'), ('\u{FF85}', '\u{30CA}'),
    ('\u{FF86}', '\u{30CB}'), ('\u{FF87}', '\u{30CC}'), ('\u{FF88}', '\u{30CD}'),
    ('\u{FF89}', '\u{30CE}'), ('\u{FF8A}', '\u{30CF}'), ('\u{FF8B}', '\u{30D2}'),
    ('\u{FF8C}', '\u{30D5}'), ('\u{FF8D}', '\u{30D8}'), ('\u{FF8E}', '\u{30DB}'),
    ('\u{FF8F}', '\u{30DE}'), ('\u{FF90}', '\u{30DF}'), ('\u{FF91}', '\u{30E0}'),
    ('\u{FF92}', '\u{30E1}'), ('\u{FF93}', '\u{30E2}'), ('\u{FF6C}', '\u{30E3}'),
    ('\u{FF94}', '\u{30E4}'), ('\u{FF6D}', '\u{30E5}'), ('\u{FF95}', '\u{30E6}'),
    ('\u{FF6E}', '\u{30E7}'), ('\u{FF96}', '\u{30E8}'), ('\u{FF97}', '\u{30E9}'),
    ('\u{FF98}', '\u{30EA}'), ('\u{FF99}', '\u{30EB}'), ('\u{FF9A}', '\u{30EC}'),
    ('\u{FF9B}', '\u{30ED}'), ('\u{FF9C}', '\u{30EF}'), ('\u{FF66}', '\u{30F2}'),
    ('\u{FF9D}', '\u{30F3}'), ('\u{FF70}', '\u{30FC}'), ('\u{FF65}', '\u{30FB}'),
    ('\u{FF62}', '\u{300C}'), ('\u{FF63}', '\u{300D}'), ('\u{FF61}', '\u{3002}'),
    ('\u{FF64}', '\u{3001}'),
];

/// `jaconv.h2z(text, ascii=True, digit=True)` — with `kana` left at its
/// default of `True`, which is how `manga_ocr` calls it.
///
/// The ASCII and digit halves of `H2Z_ALL` are the standard fullwidth block:
/// every code point in `0x21..=0x7E` shifts by `+0xFEE0`, and the space goes to
/// U+3000. That was checked against `jaconv.conv_table` entry by entry rather
/// than assumed — the two lists are written out longhand there and could in
/// principle have held a surprise.
///
/// This is the step that turns the `...` produced just above into `．．．`,
/// which is why the golden strings are full of fullwidth dots.
pub fn h2z(text: &str) -> String {
    let mut s = text.to_string();
    for (from, to) in DAKUTEN_PAIRS {
        if s.contains(from) {
            s = s.replace(from, to);
        }
    }
    s.chars()
        .map(|c| match c {
            ' ' => '\u{3000}',
            '\u{21}'..='\u{7E}' => char::from_u32(c as u32 + 0xFEE0).unwrap_or(c),
            _ => HALF_TO_FULL_KANA
                .iter()
                .find(|(h, _)| *h == c)
                .map(|(_, f)| *f)
                .unwrap_or(c),
        })
        .collect()
}

/// `manga_ocr.ocr.post_process`, line for line.
///
/// ```python
/// text = "".join(text.split())
/// text = text.replace("…", "...")
/// text = re.sub("[・.]{2,}", lambda x: (x.end() - x.start()) * ".", text)
/// text = jaconv.h2z(text, ascii=True, digit=True)
/// ```
///
/// The first line is load-bearing and easy to mistake for tidying: the
/// tokenizer's `decode` joins character tokens with spaces, so without it every
/// output would be `こ ん に ち は`.
pub fn post_process(text: &str) -> String {
    let stripped: String = text.split_whitespace().collect();
    let stripped = stripped.replace('…', "...");

    // `re.sub("[・.]{2,}", ...)`: each maximal run of two or more dots or
    // katakana middle dots becomes that many ASCII dots.
    let chars: Vec<char> = stripped.chars().collect();
    let mut collapsed = String::with_capacity(stripped.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '.' || chars[i] == '・' {
            let mut j = i;
            while j < chars.len() && (chars[j] == '.' || chars[j] == '・') {
                j += 1;
            }
            if j - i >= 2 {
                for _ in i..j {
                    collapsed.push('.');
                }
                i = j;
                continue;
            }
        }
        collapsed.push(chars[i]);
        i += 1;
    }

    h2z(&collapsed)
}

// ---------------------------------------------------------------------------
// Beam search
// ---------------------------------------------------------------------------

/// One finished sequence in `transformers`' `BeamHypotheses`.
struct Hypothesis {
    /// `sum_logprobs / generated_len.powf(length_penalty)`.
    score: f64,
    tokens: Vec<i64>,
}

/// `transformers.generation.BeamHypotheses`, ported.
///
/// It is a fixed-size pool of the best finished sequences, and it is the only
/// place the length penalty is applied — beam *scores* during the search are
/// raw sums of log-probabilities, unpenalised. Applying the penalty inside the
/// search instead (a common shortcut) changes which beams survive.
struct BeamHypotheses {
    beams: Vec<Hypothesis>,
    worst_score: f64,
}

impl BeamHypotheses {
    fn new() -> Self {
        BeamHypotheses { beams: Vec::new(), worst_score: 1e9 }
    }

    /// `BeamHypotheses.add`.
    ///
    /// `generated_len` is *not* `tokens.len()`. The caller passes what
    /// `transformers` passes, and the two call sites disagree by one on
    /// purpose: a sequence finished by emitting EOS counts the EOS it is about
    /// to gain, while a sequence still open at `max_length` counts only the
    /// tokens it actually holds. See `search` for both.
    fn add(&mut self, tokens: Vec<i64>, sum_logprobs: f64, generated_len: usize) {
        let score = sum_logprobs / (generated_len as f64).powf(LENGTH_PENALTY);
        if self.beams.len() < NUM_BEAMS || score > self.worst_score {
            self.beams.push(Hypothesis { score, tokens });
            if self.beams.len() > NUM_BEAMS {
                // Python: `sorted([(s, idx) ...])`, drop `[0]`, take `[1]` as
                // the new worst. Sorting by (score, index) makes the dropped
                // element the lowest-scoring one with the smallest index.
                let mut order: Vec<usize> = (0..self.beams.len()).collect();
                order.sort_by(|&a, &b| {
                    self.beams[a].score.total_cmp(&self.beams[b].score).then(a.cmp(&b))
                });
                self.beams.remove(order[0]);
                // `order[1]` indexes into the pre-removal vector; adjust.
                let second = if order[1] > order[0] { order[1] - 1 } else { order[1] };
                self.worst_score = self.beams[second].score;
            } else {
                self.worst_score = self.worst_score.min(score);
            }
        }
    }

    /// `is_done` under `early_stopping=True`: the moment the pool is full there
    /// is nothing a longer beam could add, so the search stops.
    fn is_done(&self) -> bool {
        self.beams.len() >= NUM_BEAMS
    }
}

/// `NoRepeatNGramLogitsProcessor` for one beam.
///
/// Returns the tokens that would complete a trigram this beam has already
/// produced. Note that `seq` includes the `[CLS]` start token, exactly as
/// `transformers` passes the full `input_ids` to the processor — so the very
/// first generated token participates in the ban bookkeeping.
fn banned_tokens(seq: &[i64], banned: &mut Vec<i64>) {
    banned.clear();
    let cur_len = seq.len();
    if cur_len + 1 < NO_REPEAT_NGRAM_SIZE {
        return;
    }
    let prefix = &seq[cur_len - (NO_REPEAT_NGRAM_SIZE - 1)..cur_len];
    for w in seq.windows(NO_REPEAT_NGRAM_SIZE) {
        if &w[..NO_REPEAT_NGRAM_SIZE - 1] == prefix {
            banned.push(w[NO_REPEAT_NGRAM_SIZE - 1]);
        }
    }
}

/// `log_softmax` over one row, in the numerically stable form torch uses.
fn log_softmax(row: &mut [f32]) {
    let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0f32;
    for v in row.iter() {
        sum += (*v - max).exp();
    }
    let log_sum = sum.ln() + max;
    for v in row.iter_mut() {
        *v -= log_sum;
    }
}

/// One beam's row of `next_token_scores`: raw decoder logits in, the score of
/// every continuation of that beam out.
///
/// The order of the three steps is the whole point of this being a function
/// rather than three lines in the loop, because it is not the order it looks
/// like it should be and it has been "corrected" once already.
///
/// `transformers` normalises **first** and bans **second**:
///
/// ```python
/// log_probs = nn.functional.log_softmax(logits, dim=-1)
/// log_probs = logits_processor(flat_running_sequences, log_probs)
/// # generation/utils.py:3304-3305, _beam_search, transformers 5.12.1
/// ```
///
/// The tempting reading is that a processor must see raw logits — and in
/// `_sample` it does (`next_token_scores = logits_processor(input_ids,
/// next_token_logits)`, `generation/utils.py:2813`), which is where that
/// intuition comes from. Beam search is the other way round, and the
/// difference is observable: banning after the softmax leaves the surviving
/// candidates summing to `1 - P` rather than 1, where `P` is the mass the
/// banned token carried, so the whole beam is deflated by `ln(1 - P)`
/// relative to beams that faced no ban. That looks like a bug and is instead
/// the behaviour being reproduced. Swapping the two makes this port disagree
/// with the sidecar that generated the golden strings, which is the only
/// definition of correct this file has.
fn next_token_scores(row: &mut [f32], banned: &[i64], beam_score: f32) {
    log_softmax(row);
    for t in banned {
        row[*t as usize] = f32::NEG_INFINITY;
    }
    for v in row.iter_mut() {
        *v += beam_score;
    }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// A loaded manga-ocr: two ONNX sessions and the character vocabulary.
pub struct OcrEngine {
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
}

/// Load an ONNX session, optionally offering it the CoreML execution provider.
///
/// `panels::load_session` always offers CoreML, because that graph has one
/// fixed input shape. Here only the encoder does. The decoder is re-run each
/// step with a sequence one token longer than the last, and CoreML compiles a
/// model per shape — it fails outright on this graph with
/// `Error executing model: ... (error code: -1)`. So the flag is not a tuning
/// knob; it is which of the two graphs CoreML can actually take.
fn load_session(model_path: &Path, coreml: bool) -> ort::Result<Session> {
    let builder = Session::builder()?;
    let mut builder = if coreml {
        builder.with_execution_providers([ort::ep::CoreML::default().build()])?
    } else {
        builder
    };
    builder.commit_from_file(model_path)
}

impl OcrEngine {
    /// Load `encoder_model.onnx`, `decoder_model.onnx` and `vocab.txt` from a
    /// directory (in practice `~/.mangatypesetter/models/manga-ocr`).
    pub fn load(dir: &Path) -> ort::Result<Self> {
        let encoder = load_session(&dir.join("encoder_model.onnx"), true)?;
        let decoder = load_session(&dir.join("decoder_model.onnx"), false)?;
        let vocab_path = dir.join("vocab.txt");
        let vocab_text = std::fs::read_to_string(&vocab_path)
            .map_err(|e| ort::Error::new(format!("{}: {e}", vocab_path.display())))?;
        let vocab: Vec<String> = vocab_text.lines().map(|l| l.to_string()).collect();
        Ok(OcrEngine { encoder, decoder, vocab })
    }

    /// Read one crop. This is the whole of `MangaOcr.__call__`.
    pub fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        let pixel_values = preprocess(img);
        let input = Tensor::from_array(([1usize, 3, INPUT_SIZE, INPUT_SIZE], pixel_values))?;
        let outputs = self.encoder.run(ort::inputs!["pixel_values" => input])?;
        let (shape, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        let seq = shape[1] as usize;
        let width = shape[2] as usize;

        // `generate()` expands the encoder output to one copy per beam. The
        // decoder graph takes a plain batch dimension, so the copies are made
        // once here rather than every step.
        let mut tiled = Vec::with_capacity(NUM_BEAMS * seq * width);
        for _ in 0..NUM_BEAMS {
            tiled.extend_from_slice(hidden);
        }
        drop(outputs);

        let tokens = self.search(&tiled, seq, width)?;
        Ok(post_process(&self.decode(&tokens)))
    }

    /// `tokenizer.decode(ids, skip_special_tokens=True)`.
    ///
    /// BERT's `convert_tokens_to_string` joins tokens with a space and then
    /// strips the ` ##` wordpiece marker. This vocabulary is character-level
    /// and holds no `##` entries — the `replace` is kept anyway so the function
    /// is the tokenizer's rule rather than a coincidence of this checkpoint.
    /// The spaces it inserts are removed by `post_process`.
    fn decode(&self, ids: &[i64]) -> String {
        let pieces: Vec<&str> = ids
            .iter()
            .filter(|id| **id >= FIRST_ORDINARY_TOKEN)
            .filter_map(|id| self.vocab.get(*id as usize).map(|s| s.as_str()))
            .collect();
        pieces.join(" ").replace(" ##", "").trim().to_string()
    }

    /// Four-beam search, matching `transformers`' `_beam_search`.
    ///
    /// The structure, step by step, so it can be diffed against the Python:
    ///
    /// 1. All four beams start as `[CLS]`; beam scores start `[0, -1e9, -1e9,
    ///    -1e9]` so that the first step can only expand beam 0.
    /// 2. Each step runs the decoder over all four full sequences (this export
    ///    has no KV cache, so the whole prefix is recomputed), takes the last
    ///    position's logits, and log-softmaxes them.
    /// 3. The no-repeat-trigram processor sets banned tokens to `-inf`.
    /// 4. Beam scores are added, the `4 * vocab` grid is flattened, and the top
    ///    `2 * num_beams = 8` candidates are taken.
    /// 5. Candidates are walked in rank order: an EOS candidate ranked below
    ///    `num_beams` is skipped entirely, an EOS candidate above it retires
    ///    its beam into the hypothesis pool, and anything else fills the next
    ///    of the four continuing beams. The walk stops once four beams are
    ///    filled.
    /// 6. With `early_stopping=True` the search ends as soon as the pool holds
    ///    four hypotheses; otherwise it ends at `max_length`, at which point
    ///    the four open beams are retired into the pool too.
    fn search(&mut self, encoder_hidden: &[f32], enc_seq: usize, width: usize) -> ort::Result<Vec<i64>> {
        let vocab_size = self.vocab.len();
        let mut beams: Vec<Vec<i64>> = vec![vec![CLS_TOKEN]; NUM_BEAMS];
        let mut beam_scores: Vec<f32> = vec![-1e9; NUM_BEAMS];
        beam_scores[0] = 0.0;
        let mut pool = BeamHypotheses::new();
        let mut banned = Vec::new();

        loop {
            let seq_len = beams[0].len();

            let mut ids = Vec::with_capacity(NUM_BEAMS * seq_len);
            for b in &beams {
                ids.extend_from_slice(b);
            }
            let ids = Tensor::from_array(([NUM_BEAMS, seq_len], ids))?;
            let enc = Tensor::from_array((
                [NUM_BEAMS, enc_seq, width],
                encoder_hidden.to_vec(),
            ))?;
            let outputs = self.decoder.run(ort::inputs![
                "input_ids" => ids,
                "encoder_hidden_states" => enc,
            ])?;
            let (shape, logits) = outputs["logits"].try_extract_tensor::<f32>()?;
            let out_seq = shape[1] as usize;

            // `next_token_scores`: log-softmax of the last position, banned
            // trigram completions knocked out, then the beam's running score.
            let mut grid = vec![0f32; NUM_BEAMS * vocab_size];
            for b in 0..NUM_BEAMS {
                let start = (b * out_seq + out_seq - 1) * vocab_size;
                let row = &mut grid[b * vocab_size..(b + 1) * vocab_size];
                row.copy_from_slice(&logits[start..start + vocab_size]);
                banned_tokens(&beams[b], &mut banned);
                next_token_scores(row, &banned, beam_scores[b]);
            }
            drop(outputs);

            // `torch.topk(..., 2 * num_beams, sorted=True)` over the flattened
            // grid. Ties break toward the lower flat index, which is the order
            // a stable descending sort of the grid produces.
            let mut order: Vec<u32> = (0..grid.len() as u32).collect();
            order.sort_by(|&a, &b| {
                grid[b as usize].total_cmp(&grid[a as usize]).then(a.cmp(&b))
            });

            let mut next_beams: Vec<Vec<i64>> = Vec::with_capacity(NUM_BEAMS);
            let mut next_scores: Vec<f32> = Vec::with_capacity(NUM_BEAMS);
            for (rank, &flat) in order.iter().take(2 * NUM_BEAMS).enumerate() {
                let src_beam = flat as usize / vocab_size;
                let token = (flat as usize % vocab_size) as i64;
                let score = grid[flat as usize];

                if token == EOS_TOKEN {
                    // An EOS outside the top `num_beams` is discarded: there
                    // are already `num_beams` better continuations, so the
                    // sequence it would finish cannot be worth keeping.
                    if rank >= NUM_BEAMS {
                        continue;
                    }
                    // `generated_len = cur_len - decoder_prompt_len` where
                    // `process` sets `cur_len = input_ids.shape[-1] + 1` and
                    // the prompt is the single `[CLS]`. So it is `seq_len`:
                    // the real tokens produced so far, plus the EOS about to
                    // be appended. The stored hypothesis itself does *not*
                    // carry the EOS.
                    pool.add(beams[src_beam].clone(), score as f64, seq_len);
                } else {
                    let mut next = beams[src_beam].clone();
                    next.push(token);
                    next_beams.push(next);
                    next_scores.push(score);
                }
                if next_beams.len() == NUM_BEAMS {
                    break;
                }
            }

            // There is exactly one EOS id, so at most four of the eight
            // candidates can be an EOS and four continuations always survive.
            // `transformers` raises here rather than carrying on short.
            debug_assert_eq!(next_beams.len(), NUM_BEAMS, "beam search ran out of continuations");
            beams = next_beams;
            beam_scores = next_scores;
            let done = pool.is_done();
            if done || seq_len + 1 >= MAX_LENGTH {
                if !done {
                    // `finalize`: retire the still-open beams. Here
                    // `generated_len = tokens.len() - decoder_prompt_len`, one
                    // less than in the EOS branch because no EOS is coming.
                    for (b, tokens) in beams.iter().enumerate() {
                        pool.add(tokens.clone(), beam_scores[b] as f64, tokens.len() - 1);
                    }
                }
                break;
            }
        }

        // `sorted(beams, key=score)` then `pop()` — the *last* of the highest
        // scoring, if several tie.
        let best = pool
            .beams
            .iter()
            .enumerate()
            .max_by(|(ai, a), (bi, b)| a.score.total_cmp(&b.score).then(ai.cmp(bi)))
            .map(|(_, h)| h.tokens.clone())
            .unwrap_or_default();
        Ok(best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn pil_luma_matches_pillows_fixed_point_rounding() {
        // Grey stays grey, and the endpoints are exact.
        assert_eq!(pil_luma(0, 0, 0), 0);
        assert_eq!(pil_luma(255, 255, 255), 255);
        assert_eq!(pil_luma(128, 128, 128), 128);
        // Pure channels: Pillow's own weights, not the float ones. 0.299*255
        // is 76.245 and truncating float arithmetic would also give 76 here,
        // but 0.587*255 = 149.685 rounds to 150 and truncates to 149 — this is
        // the case that catches a float port.
        assert_eq!(pil_luma(255, 0, 0), 76);
        assert_eq!(pil_luma(0, 255, 0), 150);
        assert_eq!(pil_luma(0, 0, 255), 29);
    }

    #[test]
    fn resize_of_a_flat_plane_is_that_flat_value() {
        // Weights sum to one in fixed point, so a constant image must survive
        // both passes unchanged. A normalisation bug shows up here immediately.
        for v in [0u8, 1, 127, 200, 255] {
            let src = vec![v; 40 * 90];
            let out = pil_bilinear_resize(&src, 40, 90, INPUT_SIZE, INPUT_SIZE);
            assert!(out.iter().all(|p| *p == v), "value {v} did not survive the resize");
        }
    }

    #[test]
    fn resize_matches_pillow_byte_for_byte() {
        // Both directions, recorded from `PIL.Image.resize(..., BILINEAR)` on
        // Pillow 12.2.0 — the version the golden strings were produced with.
        //
        // These two cases are the whole reason this resize is hand-written
        // rather than delegated to `image`'s Triangle filter. Upscaling
        // exercises the `filterscale == 1` branch and downscaling exercises the
        // widened filter; both go through the 22-bit fixed-point weights and
        // the 8-bit intermediate, and a float implementation lands a count or
        // two off on several of these pixels.
        let up_src: [u8; 15] = [11, 48, 85, 122, 159, 196, 233, 14, 51, 88, 125, 162, 199, 236, 17];
        let up_want: [u8; 16] =
            [20, 63, 107, 150, 136, 112, 63, 106, 178, 155, 105, 76, 134, 177, 221, 72];
        assert_eq!(pil_bilinear_resize(&up_src, 5, 3, 4, 4), up_want);

        let down_src: Vec<u8> = (0..(11 * 7)).map(|i| ((i * 13 + 5) % 256) as u8).collect();
        assert_eq!(pil_bilinear_resize(&down_src, 11, 7, 3, 2), [110, 138, 117, 146, 116, 120]);
    }

    #[test]
    fn resize_to_the_same_size_is_the_identity() {
        let src: Vec<u8> = (0..(16 * 16)).map(|i| (i * 7 % 256) as u8).collect();
        let out = pil_bilinear_resize(&src, 16, 16, 16, 16);
        assert_eq!(out, src);
    }

    #[test]
    fn preprocess_produces_the_encoders_tensor_shape_and_range() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(37, 140, Rgb([255, 255, 255])));
        let t = preprocess(&img);
        assert_eq!(t.len(), 3 * INPUT_SIZE * INPUT_SIZE);
        // White normalises to +1 on every channel.
        assert!(t.iter().all(|v| (*v - 1.0).abs() < 1e-6));

        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(37, 140, Rgb([0, 0, 0])));
        let t = preprocess(&img);
        assert!(t.iter().all(|v| (*v + 1.0).abs() < 1e-6));
    }

    #[test]
    fn post_process_reproduces_the_python_functions_steps() {
        // The tokenizer's spaces go, and nothing else changes.
        assert_eq!(post_process("こ ん に ち は"), "こんにちは");
        // "…" becomes three ASCII dots, which h2z then widens.
        assert_eq!(post_process("あ…"), "あ．．．");
        // A run of two or more dots or middle dots collapses to that many
        // ASCII dots; a lone one is left for h2z to handle on its own terms.
        assert_eq!(post_process("あ・・い"), "あ．．い");
        assert_eq!(post_process("あ・い"), "あ・い");
        assert_eq!(post_process("あ..い"), "あ．．い");
        // ascii=True, digit=True.
        assert_eq!(post_process("AB12!?"), "ＡＢ１２！？");
        // Half-width katakana, dakuten first.
        assert_eq!(post_process("ｶﾞｷ"), "ガキ");
        // Japanese text with no half-width anything is untouched.
        assert_eq!(post_process("面識がない"), "面識がない");
    }

    #[test]
    fn h2z_leaves_a_voiced_mark_that_follows_nothing_it_can_join_alone() {
        // A standing invitation to "fix" the table by adding U+FF9E -> U+309B
        // and U+FF9F -> U+309C, which look like obvious omissions and are not:
        // `HALF_KANA_SEION` does not list either mark, so `jaconv.h2z` leaves a
        // mark it could not pair with the preceding kana exactly as it found
        // it. Checked against the sidecar's own jaconv 0.5.0:
        //   >>> jaconv.h2z('あﾞ', ascii=True, digit=True) == 'あﾞ'
        assert_eq!(h2z("\u{FF9E}"), "\u{FF9E}");
        assert_eq!(h2z("\u{FF9F}"), "\u{FF9F}");
        assert_eq!(h2z("あ\u{FF9E}"), "あ\u{FF9E}");
        // Full-width katakana is not a pairing partner either — only the
        // half-width kana in `DAKUTEN_PAIRS` are.
        assert_eq!(h2z("ア\u{FF9E}"), "ア\u{FF9E}");
        // Whereas a mark that *does* follow a half-width kana is absorbed.
        assert_eq!(h2z("ｳ\u{FF9E}"), "ヴ");
        assert_eq!(h2z("ﾊ\u{FF9F}"), "パ");
    }

    #[test]
    fn banned_tokens_bans_only_repeated_trigrams() {
        let mut out = Vec::new();
        // Too short for a trigram to exist yet.
        banned_tokens(&[2], &mut out);
        assert!(out.is_empty());
        // [2, 10] -> the sequence 2,10,X has never been seen.
        banned_tokens(&[2, 10], &mut out);
        assert!(out.is_empty());
        // 2,10,11 has been seen, and the tail is again 2,10, so 11 is banned.
        banned_tokens(&[2, 10, 11, 2, 10], &mut out);
        assert_eq!(out, vec![11]);
        // Same prefix seen twice with different completions bans both.
        banned_tokens(&[2, 10, 11, 2, 10, 12, 2, 10], &mut out);
        assert_eq!(out, vec![11, 12]);
        // A different tail bans nothing.
        banned_tokens(&[2, 10, 11, 2, 13], &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn the_trigram_ban_lands_after_the_log_softmax_not_before_it() {
        // The order `transformers` uses in `_beam_search` and *not* the one it
        // uses in `_sample`, which is why this is worth a test of its own.
        // Two equal logits log-softmax to ln(0.5) each; banning the first
        // afterwards leaves the second at ln(0.5), because nothing
        // renormalises. Ban first and the second would come out at 0.
        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[0], 0.0);
        assert_eq!(row[0], f32::NEG_INFINITY);
        assert!(
            (row[1] - 0.5f32.ln()).abs() < 1e-6,
            "survivors must not be renormalised after a ban: {}",
            row[1]
        );

        // The beam's running score is added last, to every candidate.
        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[], -2.0);
        assert!((row[0] - (0.5f32.ln() - 2.0)).abs() < 1e-6, "{}", row[0]);
        assert!((row[1] - (0.5f32.ln() - 2.0)).abs() < 1e-6, "{}", row[1]);

        // A banned token stays at -inf however large the beam score is.
        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[1], 1e9);
        assert_eq!(row[1], f32::NEG_INFINITY);
    }

    #[test]
    fn log_softmax_sums_to_one_and_preserves_order() {
        let mut row = [1.0f32, 2.0, 3.0, -5.0];
        log_softmax(&mut row);
        let total: f32 = row.iter().map(|v| v.exp()).sum();
        assert!((total - 1.0).abs() < 1e-5, "probabilities summed to {total}");
        assert!(row[2] > row[1] && row[1] > row[0] && row[0] > row[3]);
    }

    #[test]
    fn beam_pool_keeps_the_best_four_and_applies_the_length_penalty() {
        let mut pool = BeamHypotheses::new();
        // Same log-prob sum, different lengths. Dividing a negative sum by a
        // larger `len ** 2.0` moves it *up*, so a length penalty above 1
        // rewards longer sequences — the opposite of what the word "penalty"
        // suggests, and the direction a port is most likely to invert.
        pool.add(vec![2, 10], -4.0, 2);
        pool.add(vec![2, 10, 11, 12], -4.0, 4);
        assert!((pool.beams[0].score - (-1.0)).abs() < 1e-12);
        assert!((pool.beams[1].score - (-0.25)).abs() < 1e-12);
        assert!(pool.beams[1].score > pool.beams[0].score);
        assert!(!pool.is_done());

        pool.add(vec![2, 13], -100.0, 2);
        pool.add(vec![2, 14], -200.0, 2);
        assert!(pool.is_done());
        // A fifth, worse hypothesis is rejected outright; the pool stays at four.
        pool.add(vec![2, 15], -1000.0, 2);
        assert_eq!(pool.beams.len(), NUM_BEAMS);
        assert!(pool.beams.iter().all(|h| h.tokens != vec![2, 15]));
    }

    /// One entry of `ocr-golden.json`: a crop and what the Python sidecar's
    /// real manga-ocr returned for it on this machine.
    #[derive(serde::Deserialize)]
    struct GoldenCrop {
        crop: String,
        jp: String,
    }

    /// Load a fixture crop the way the Python path saw it.
    ///
    /// These PNGs were written by `cv2.imwrite` from BGR ndarrays, so the files
    /// on disk hold the true colours — but the array the sidecar handed to
    /// `Image.fromarray` was that same BGR buffer, which PIL read as RGB. PIL's
    /// luma weights therefore landed on the channels in the opposite order, and
    /// swapping red and blue back on the way in is what makes this test feed
    /// the model the bytes the Python run fed it.
    ///
    /// It is worth being clear about how much this proves. The crops are not
    /// channel-equal — screentone and JPEG ringing leave real colour behind, so
    /// 5.8% of their pixels come out with a different luma under the two orders,
    /// by up to 7 counts. But the fixture passes 34/34 either way: on
    /// near-monochrome line art that much drift is not enough to move a beam.
    /// So the swap is here because it is the faithful reproduction of the
    /// fixture's provenance, not because the fixture can tell the difference.
    fn load_crop_as_python_saw_it(path: &Path) -> DynamicImage {
        let rgb = image::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())).to_rgb8();
        let mut swapped = rgb.clone();
        for px in swapped.pixels_mut() {
            px.0.swap(0, 2);
        }
        DynamicImage::ImageRgb8(swapped)
    }

    #[test]
    fn ocr_matches_the_python_sidecar_on_the_golden_crops() {
        // The point of the port is that it reads the same text as the
        // `transformers` path it replaces. Every other test here checks one
        // stage in isolation; this is the only one that checks the stages
        // compose into the same pipeline, on real crops.
        //
        // It skips rather than fails when its inputs are absent: the two ONNX
        // graphs are a 440 MB download that is not in the repo.
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping golden test: HOME not set");
            return;
        };
        let model_dir = std::path::PathBuf::from(home)
            .join(".mangatypesetter")
            .join("models")
            .join("manga-ocr");
        if !model_dir.join("encoder_model.onnx").exists() {
            eprintln!("skipping golden test: models not found in {}", model_dir.display());
            return;
        }

        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/analyze-golden");
        let Ok(fixture_json) = std::fs::read_to_string(fixture_dir.join("ocr-golden.json")) else {
            eprintln!("skipping golden test: fixture not found in {}", fixture_dir.display());
            return;
        };
        let golden: Vec<GoldenCrop> =
            serde_json::from_str(&fixture_json).expect("ocr-golden.json is not the expected shape");

        let started = std::time::Instant::now();
        let mut engine = OcrEngine::load(&model_dir).expect("failed to load the OCR models");

        // Every crop is run and reported before anything is asserted, so a
        // partial failure shows the whole picture rather than only the first
        // disagreement.
        let mut failures = Vec::new();
        for g in &golden {
            let path = fixture_dir.join(&g.crop);
            let img = load_crop_as_python_saw_it(&path);
            let got = engine.ocr(&img).expect("ocr failed");
            if got == g.jp {
                eprintln!("  ok   {}: {got}", g.crop);
            } else {
                eprintln!("  FAIL {}\n    python: {}\n    rust:   {got}", g.crop, g.jp);
                failures.push(g.crop.clone());
            }
        }
        eprintln!(
            "golden ocr: {}/{} crops matched in {:.1}s",
            golden.len() - failures.len(),
            golden.len(),
            started.elapsed().as_secs_f64()
        );

        assert!(
            failures.is_empty(),
            "{} of {} crops disagreed with the Python sidecar: {:?}",
            failures.len(),
            golden.len(),
            failures
        );
    }
}
