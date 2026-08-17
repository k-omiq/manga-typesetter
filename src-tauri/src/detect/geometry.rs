//! The arithmetic every ONNX vision model here needs, with no model attached.
//!
//! Split out because it is the part that can be tested without a 100 MB
//! download and without a session: letterboxing, the inverse mapping back to
//! page coordinates, IoU and non-maximum suppression are ordinary geometry, and
//! they are also where a port like this actually goes wrong. A box that is off
//! by the padding offset still looks like a plausible box.

/// How an image was fitted into the model input, and everything needed to map a
/// prediction back out of it.
///
/// This is Ultralytics' `LetterBox` in prediction mode, and the shape it
/// produces is the thing most easily got wrong: **not a square**. `Model.predict`
/// sets `rect=True` (`ultralytics/engine/model.py:524`), which makes the
/// predictor build `LetterBox(auto=True, stride=32)`
/// (`ultralytics/engine/predictor.py:197-203`), and `auto=True` reduces the
/// padding modulo the stride (`ultralytics/data/augment.py:1721-1722`). A
/// 1080×1535 page therefore enters the network at 480×640, not 640×640 — the
/// export's height and width are dynamic, so the graph accepts it — and every
/// coordinate the network predicts is relative to that rectangle.
///
/// The page is scaled by a single ratio — the same on both axes, or the aspect
/// would skew and every predicted box with it — and the leftover is split
/// evenly. `pad_x`/`pad_y` are the *leading* pad only, which is what an inverse
/// mapping subtracts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Letterbox {
    /// Scale applied to the source before padding (`r` in Ultralytics).
    pub ratio: f64,
    /// Padding added on the left, in model-input pixels (Ultralytics' `left`).
    pub pad_x: u32,
    /// Padding added on the top, in model-input pixels (Ultralytics' `top`).
    pub pad_y: u32,
    /// The scaled size, before padding (Ultralytics' `new_unpad`).
    pub inner_w: u32,
    pub inner_h: u32,
    /// The padded size actually handed to the network.
    pub net_w: u32,
    pub net_h: u32,
}

/// Python's `round`: half to even. Ultralytics computes every letterbox
/// dimension with it, and `f64::round` disagrees on exact halves.
fn round_py(v: f64) -> f64 {
    super::textblock::round_half_even(v)
}

impl Letterbox {
    /// Fit `src_w × src_h` into a stride-aligned rectangle no larger than
    /// `size × size`, centred.
    ///
    /// A transcription of `LetterBox.get_params`
    /// (`ultralytics/data/augment.py:1697-1744`) at the settings the predictor
    /// uses: `new_shape=(size, size)`, `auto=True`, `scale_fill=False`,
    /// `scaleup=True`, `center=True`. The `-0.1`/`+0.1` in the top/left versus
    /// bottom/right split is Ultralytics' own, and it is load-bearing: it is
    /// what puts the odd pixel of an odd pad on the *trailing* edge.
    pub fn fit(src_w: u32, src_h: u32, size: u32, stride: u32) -> Letterbox {
        let (w0, h0) = (src_w as f64, src_h as f64);
        // `r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])` — height
        // first, because Ultralytics' shapes are (h, w).
        let ratio = (size as f64 / h0).min(size as f64 / w0);
        // The one deliberate departure from Ultralytics: a floor of one pixel.
        // A webtoon slice a pixel or two wide scales its short side to less
        // than half a pixel, which rounds to 0 — and a 0 there is not a small
        // image, it is a `[1, 3, 640, 0]` tensor that ONNX Runtime rejects and
        // a `gain` of 0 that divides by zero on the way back out. Ultralytics
        // never sees this because it never letterboxes a strip that thin.
        let inner_w = (round_py(w0 * ratio) as u32).max(1);
        let inner_h = (round_py(h0 * ratio) as u32).max(1);

        // `dw, dh = np.mod(dw, stride), np.mod(dh, stride)`, then halved.
        let s = stride.max(1) as i64;
        let dw = (size as i64 - inner_w as i64).rem_euclid(s) as f64 / 2.0;
        let dh = (size as i64 - inner_h as i64).rem_euclid(s) as f64 / 2.0;
        let (left, right) = (round_py(dw - 0.1), round_py(dw + 0.1));
        let (top, bottom) = (round_py(dh - 0.1), round_py(dh + 0.1));

        Letterbox {
            ratio,
            pad_x: left as u32,
            pad_y: top as u32,
            inner_w,
            inner_h,
            net_w: inner_w + left as u32 + right as u32,
            net_h: inner_h + top as u32 + bottom as u32,
        }
    }

    /// Undo the fit for one box, returning page coordinates clamped to the page.
    ///
    /// A transcription of `ops.scale_boxes` (`ultralytics/utils/ops.py:103-142`)
    /// with `ratio_pad=None`, which is how the detection predictor calls it:
    /// the gain and the pad are *recomputed* from the network input shape and
    /// the page shape rather than carried over from the letterbox. They come out
    /// identical to [`Letterbox::fit`]'s `ratio`, `pad_x` and `pad_y` — there is
    /// a test below that pins that — but recomputing is what the original does,
    /// so it is what this does.
    ///
    /// The arithmetic is `f32` because Ultralytics' is: the boxes are a `float32`
    /// tensor and the Python-float `gain` is cast down to the tensor's dtype
    /// before the division, not the other way round.
    ///
    /// Clamped because a model is free to predict a box that runs off the edge
    /// of the image it was given, and every consumer downstream — the reading
    /// order sort, the queue, the placement rect — assumes a box is on the page.
    pub fn to_source(&self, b: BBox, src_w: u32, src_h: u32) -> BBox {
        let (w0, h0) = (src_w as f64, src_h as f64);
        let gain = (self.net_h as f64 / h0).min(self.net_w as f64 / w0);
        // `.max(1.0)` for the same reason [`Letterbox::fit`] floors `inner_w`:
        // the scaled size is recomputed here rather than carried over, so it
        // has to round the same way or the two disagree by a pixel on a strip
        // thin enough to round to nothing. On any ordinary page it is a no-op.
        let pad_x = round_py((self.net_w as f64 - round_py(w0 * gain).max(1.0)) / 2.0 - 0.1) as f32;
        let pad_y = round_py((self.net_h as f64 - round_py(h0 * gain).max(1.0)) / 2.0 - 0.1) as f32;
        let gain = gain as f32;

        let x1 = ((b.x1 - pad_x) / gain).clamp(0.0, src_w as f32);
        let y1 = ((b.y1 - pad_y) / gain).clamp(0.0, src_h as f32);
        let x2 = ((b.x2 - pad_x) / gain).clamp(0.0, src_w as f32);
        let y2 = ((b.y2 - pad_y) / gain).clamp(0.0, src_h as f32);
        BBox { x1, y1, x2, y2, ..b }
    }
}

/// An axis-aligned box in whatever space its producer was working in, with the
/// class and confidence that came with it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
    pub class: usize,
}

impl BBox {
    pub fn area(&self) -> f32 {
        (self.x2 - self.x1).max(0.0) * (self.y2 - self.y1).max(0.0)
    }

    /// Intersection over union.
    pub fn iou(&self, other: &BBox) -> f32 {
        let ix = (self.x2.min(other.x2) - self.x1.max(other.x1)).max(0.0);
        let iy = (self.y2.min(other.y2) - self.y1.max(other.y1)).max(0.0);
        let inter = ix * iy;
        let union = self.area() + other.area() - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }
}

/// Greedy non-maximum suppression, per class.
///
/// Per class rather than across all of them: two different kinds of thing may
/// legitimately occupy the same rectangle — a panel and the speech bubble
/// inside it — and suppressing across classes would delete one of them.
/// Ultralytics spells this the other way round, offsetting each box by
/// `class * 7680` before a single class-agnostic pass
/// (`ultralytics/utils/nms.py:141-147`); with a 640-pixel input no two classes
/// can then touch, so the two are the same operation.
///
/// Ultralytics also caps the input at `max_nms = 30000` boxes and the output at
/// `max_det = 300`. Neither is reproduced here and neither can bite: both caps
/// are applied in descending-score order, and a manga page yields tens of
/// detections above the 0.25 confidence floor, not thousands.
pub fn nms(mut boxes: Vec<BBox>, iou_threshold: f32) -> Vec<BBox> {
    // Descending by score, so the first box of any overlapping group is the one
    // kept. `total_cmp` rather than `partial_cmp().unwrap()`: a NaN score from a
    // malformed output would panic on the unwrap, and sorting it to one end is
    // strictly better than taking the process down.
    boxes.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<BBox> = Vec::new();
    for b in boxes {
        if kept
            .iter()
            .any(|k| k.class == b.class && k.iou(&b) > iou_threshold)
        {
            continue;
        }
        kept.push(b);
    }
    kept
}

/// Decode one YOLO11 ONNX output tensor.
///
/// The layout is `[1, 4 + num_classes, num_anchors]` — note that it is
/// transposed relative to how it reads: all the centre-x values come first,
/// then all the centre-y, and so on. Indexing it the obvious way (anchor-major)
/// produces boxes made of unrelated numbers, which is the single easiest
/// mistake to make here and the reason this function exists rather than being
/// inlined at the call site.
///
/// There is no objectness score in v8/v11; the class score *is* the confidence.
/// Boxes come back in model-input pixels, still needing `Letterbox::to_source`.
pub fn decode_yolo11(data: &[f32], channels: usize, anchors: usize, conf: f32) -> Vec<BBox> {
    if channels < 5 || anchors == 0 || data.len() < channels * anchors {
        return Vec::new();
    }
    let num_classes = channels - 4;
    let at = |c: usize, a: usize| data[c * anchors + a];
    let mut out = Vec::new();
    for a in 0..anchors {
        // Best class for this anchor, and its score.
        let mut best = 0usize;
        let mut best_score = f32::MIN;
        for c in 0..num_classes {
            let s = at(4 + c, a);
            if s > best_score {
                best_score = s;
                best = c;
            }
        }
        // Strictly greater, as Ultralytics' candidate mask is
        // (`xc = prediction[:, 4:mi].amax(1) > conf_thres`,
        // `ultralytics/utils/nms.py:78`).
        if best_score <= conf {
            continue;
        }
        // Centre form to corner form.
        let (cx, cy, w, h) = (at(0, a), at(1, a), at(2, a), at(3, a));
        // A NaN or infinite coordinate has to be dropped here, at the only
        // place it can still be dropped. `clamp` does not remove it — Rust's
        // `f32::clamp` returns NaN for NaN — so it survives the inverse
        // mapping, and the `as i32` that turns a box into a panel then
        // silently reads it as 0, fabricating a `[0, 0, 0, 0]` panel at the
        // page corner that the reading-order sort takes entirely seriously.
        if !(cx.is_finite() && cy.is_finite() && w.is_finite() && h.is_finite()) {
            continue;
        }
        out.push(BBox {
            x1: cx - w / 2.0,
            y1: cy - h / 2.0,
            x2: cx + w / 2.0,
            y2: cy + h / 2.0,
            score: best_score,
            class: best,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x1: f32, y1: f32, x2: f32, y2: f32) -> BBox {
        BBox { x1, y1, x2, y2, score: 1.0, class: 0 }
    }

    #[test]
    fn letterbox_produces_the_stride_32_rectangle_ultralytics_does() {
        // The golden pages. `LetterBox(auto=True, stride=32)` scales 1080x1535
        // by 640/1535, giving 450x640, and pads the width up to the next
        // multiple of 32 — 480, not 640. Captured from the venv:
        //   predictor input tensor shape == (1, 3, 640, 480)
        let lb = Letterbox::fit(1080, 1535, 640, 32);
        assert_eq!((lb.inner_w, lb.inner_h), (450, 640));
        assert_eq!((lb.net_w, lb.net_h), (480, 640));
        assert_eq!((lb.pad_x, lb.pad_y), (15, 0));
    }

    #[test]
    fn letterbox_puts_the_odd_pixel_of_an_odd_pad_on_the_trailing_edge() {
        // 1000x1500 scales by 640/1500 to 427x640; 640 - 427 = 213, and
        // 213 % 32 = 21, so the pad is 10 leading and 11 trailing. That
        // asymmetry is the whole point of Ultralytics' `round(d - 0.1)` /
        // `round(d + 0.1)` split, and getting it backwards moves every box a
        // pixel.
        let lb = Letterbox::fit(1000, 1500, 640, 32);
        assert_eq!((lb.inner_w, lb.inner_h), (427, 640));
        assert_eq!(lb.pad_x, 10);
        assert_eq!(lb.net_w, 427 + 21);
    }

    #[test]
    fn letterbox_of_a_square_pads_nothing() {
        let lb = Letterbox::fit(500, 500, 640, 32);
        assert_eq!((lb.pad_x, lb.pad_y), (0, 0));
        assert_eq!((lb.inner_w, lb.inner_h), (640, 640));
        assert_eq!((lb.net_w, lb.net_h), (640, 640));
    }

    #[test]
    fn to_source_recomputes_exactly_the_pad_the_fit_applied() {
        // `scale_boxes` derives the gain and the pad afresh from the two shapes
        // rather than being handed the letterbox's. That is only safe because
        // the two agree; this is the check that they do, over every page shape
        // the app is likely to see. A box at the very corner of the scaled image
        // must map to the very corner of the page.
        for (w, h) in [
            (1080u32, 1535u32),
            (1000, 1500),
            (1536, 2048),
            (2048, 1536),
            (800, 800),
            (500, 500),
            (1200, 1800),
            (17, 4000),
            // Degenerate strips: the short side scales to under half a pixel
            // and only survives because `fit` floors it at one.
            (1, 2000),
            (2000, 1),
        ] {
            let lb = Letterbox::fit(w, h, 640, 32);
            let full = b(
                lb.pad_x as f32,
                lb.pad_y as f32,
                (lb.pad_x + lb.inner_w) as f32,
                (lb.pad_y + lb.inner_h) as f32,
            );
            let back = lb.to_source(full, w, h);
            assert_eq!((back.x1, back.y1), (0.0, 0.0), "{w}x{h}");
            assert!((back.x2 - w as f32).abs() <= 1.0, "{w}x{h}: x2 {}", back.x2);
            assert!((back.y2 - h as f32).abs() <= 1.0, "{w}x{h}: y2 {}", back.y2);
        }
    }

    #[test]
    fn to_source_clamps_a_prediction_that_runs_off_the_page() {
        let lb = Letterbox::fit(1000, 1000, 640, 32);
        let out = lb.to_source(b(-50.0, -50.0, 900.0, 900.0), 1000, 1000);
        assert_eq!((out.x1, out.y1), (0.0, 0.0));
        assert_eq!((out.x2, out.y2), (1000.0, 1000.0));
    }

    #[test]
    fn letterbox_of_an_extreme_strip_never_collapses_a_side_to_nothing() {
        // A 1x2000 slice scales its width to 0.32 px, which rounds to 0. That
        // 0 became the last dimension of the input tensor — a shape ONNX
        // Runtime refuses — and a `gain` of 0 in the inverse mapping.
        for (w, h) in [(1u32, 2000u32), (2000, 1), (1, 1), (3, 5000), (5000, 3)] {
            let lb = Letterbox::fit(w, h, 640, 32);
            assert!(lb.inner_w >= 1 && lb.inner_h >= 1, "{w}x{h}: {lb:?}");
            assert!(lb.net_w >= 1 && lb.net_h >= 1, "{w}x{h}: {lb:?}");

            let out = lb.to_source(b(0.0, 0.0, lb.net_w as f32, lb.net_h as f32), w, h);
            for v in [out.x1, out.y1, out.x2, out.y2] {
                assert!(v.is_finite(), "{w}x{h}: {out:?}");
            }
        }
    }

    #[test]
    fn decode_drops_an_anchor_whose_coordinates_are_not_finite() {
        // A NaN coordinate cannot be clamped away later — `f32::clamp` passes
        // NaN straight through, and `NaN as i32` is 0, so the box would arrive
        // downstream as a confident [0, 0, 0, 0] panel in the page corner.
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let data: Vec<f32> = vec![bad, 100.0, 20.0, 20.0, 0.9];
            assert!(decode_yolo11(&data, 5, 1, 0.5).is_empty(), "{bad}");
            let data: Vec<f32> = vec![100.0, 100.0, bad, 20.0, 0.9];
            assert!(decode_yolo11(&data, 5, 1, 0.5).is_empty(), "{bad}");
        }
        // And a sound anchor beside a bad one still comes through.
        let data: Vec<f32> = vec![
            f32::NAN, 300.0, // cx
            100.0, 300.0, // cy
            20.0, 40.0, // w
            20.0, 40.0, // h
            0.9, 0.9, // class 0 score
        ];
        let out = decode_yolo11(&data, 5, 2, 0.5);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].x1, out[0].x2), (280.0, 320.0));
    }

    #[test]
    fn iou_of_identical_boxes_is_one_and_of_disjoint_is_zero() {
        let a = b(0.0, 0.0, 10.0, 10.0);
        assert!((a.iou(&a) - 1.0).abs() < 1e-6);
        assert_eq!(a.iou(&b(20.0, 20.0, 30.0, 30.0)), 0.0);
    }

    #[test]
    fn iou_of_half_overlap() {
        let a = b(0.0, 0.0, 10.0, 10.0);
        let c = b(5.0, 0.0, 15.0, 10.0);
        // 50 intersection, 150 union.
        assert!((a.iou(&c) - 50.0 / 150.0).abs() < 1e-6);
    }

    #[test]
    fn nms_keeps_the_highest_scoring_of_an_overlapping_group() {
        let boxes = vec![
            BBox { score: 0.6, ..b(0.0, 0.0, 10.0, 10.0) },
            BBox { score: 0.9, ..b(1.0, 1.0, 11.0, 11.0) },
            BBox { score: 0.7, ..b(50.0, 50.0, 60.0, 60.0) },
        ];
        let kept = nms(boxes, 0.5);
        assert_eq!(kept.len(), 2);
        assert!((kept[0].score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn nms_does_not_suppress_across_classes() {
        // A panel and the bubble inside it occupy nearly the same rectangle.
        // Suppressing across classes would delete one of them.
        let boxes = vec![
            BBox { score: 0.9, class: 0, ..b(0.0, 0.0, 10.0, 10.0) },
            BBox { score: 0.8, class: 1, ..b(0.0, 0.0, 10.0, 10.0) },
        ];
        assert_eq!(nms(boxes, 0.5).len(), 2);
    }

    #[test]
    fn decode_reads_the_transposed_layout() {
        // Two anchors, two classes, so channels = 6. Laid out channel-major,
        // which is the thing being tested: read anchor-major, the second box
        // would come out as nonsense.
        let anchors = 2;
        let data: Vec<f32> = vec![
            // cx
            100.0, 300.0, // cy
            100.0, 300.0, // w
            20.0, 40.0, // h
            20.0, 40.0, // class 0 score
            0.9, 0.1, // class 1 score
            0.2, 0.8,
        ];
        let out = decode_yolo11(&data, 6, anchors, 0.5);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].x1, out[0].y1, out[0].x2, out[0].y2), (90.0, 90.0, 110.0, 110.0));
        assert_eq!(out[0].class, 0);
        assert_eq!(out[1].class, 1);
        assert_eq!((out[1].x1, out[1].x2), (280.0, 320.0));
    }

    #[test]
    fn decode_drops_anchors_below_the_confidence_floor() {
        let data: Vec<f32> = vec![100.0, 100.0, 20.0, 20.0, 0.2];
        assert!(decode_yolo11(&data, 5, 1, 0.5).is_empty());
    }

    #[test]
    fn decode_refuses_a_malformed_tensor_instead_of_panicking() {
        // A shape that does not match the buffer is a bug somewhere upstream,
        // but reading past the end of the slice would be a crash in the host
        // process rather than a failed detection.
        assert!(decode_yolo11(&[1.0, 2.0], 6, 100, 0.5).is_empty());
    }
}
