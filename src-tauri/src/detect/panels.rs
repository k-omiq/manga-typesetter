//! The manga109 panel detector, in Rust.
//!
//! What it is for: the sidecar sorts detected text into reading order, and to
//! do that well it needs to know where the panels are. Without them the sort
//! falls back to banding the whole page horizontally, which on an ordinary
//! two-panel tier reads right-top, left-top, right-bottom, left-bottom — wrong
//! on most pages, and felt on every one of them because the Text Queue
//! auto-advances as the letterer places lines.
//!
//! In Python this cost the `ultralytics` package and, through it, most of a
//! gigabyte: the `.pt` checkpoint pickles live `ultralytics` classes, so
//! `torch.load` cannot open it without them. The ONNX export of the same model
//! has no such dependency — it is a graph, and this file is all the code needed
//! to run it.

use image::{DynamicImage, GenericImageView, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

use super::cvops::resize_linear_u8;
use super::geometry::{decode_yolo11, nms, BBox, Letterbox};

/// The class index representing a panel frame in the manga109 YOLO model.
///
/// Pinned from the model's own metadata, key `"names"` = `{0: 'body', 1: 'face', 2: 'frame', 3: 'text'}`,
/// for `huggingface.co/deepghs/manga109_yolo` `v2023.12.07_l_yv11/model.onnx`.
pub const FRAME_CLASS: usize = 2;

/// Load an ONNX session for the manga109 panel detection model.
///
/// **CPU, deliberately.** CoreML was tried and dropped. It runs this graph at
/// reduced precision, which moves a predicted edge by around a thirtieth of a
/// model pixel — enough to round one panel of the golden fixture to 85 instead
/// of 84, and enough, on a page with two panels of near-equal confidence, to
/// swap them in the detection order and so flip two lines of reading order. On
/// CPU every coordinate of all fourteen fixture panels reproduces Ultralytics
/// exactly (see the golden test below).
///
/// There was no speed to trade away for that: measured over five runs of a
/// 1080x1535 page on this machine, CPU was 287 ms and CoreML 361 ms — the graph
/// is small enough that CoreML's per-call overhead outweighs it. If a future
/// model is large enough to change that arithmetic, the golden test is the place
/// to relitigate it.
pub fn load_session(model_path: &std::path::Path) -> ort::Result<Session> {
    Session::builder()?.commit_from_file(model_path)
}

/// The long-edge budget the page is fitted into — `imgsz`, which `detect.py`
/// passes explicitly and which is also Ultralytics' default.
///
/// Not the input *shape*: the page goes in as a stride-aligned rectangle no
/// larger than this on either side. See [`Letterbox`].
pub const INPUT_SIZE: u32 = 640;

/// The model's stride, from `model.stride` — 32 for every YOLO11 detect export.
/// It is what the letterbox rounds the padding to.
pub const STRIDE: u32 = 32;

/// Ultralytics' letterbox fill. Grey rather than black on purpose: a black
/// border reads as ink to a detector trained on black-and-white line art.
const PAD: u8 = 114;

/// Defaults matching the Python path (`detect.py` runs the panel model at
/// Ultralytics' own prediction defaults).
///
/// `conf` is passed explicitly by `detect_panels`; `iou` is Ultralytics' own
/// default for NMS, `0.7` (`ultralytics/cfg/default.yaml:54`). It is not `0.45`
/// — that is the default of the bare `non_max_suppression` helper, which the
/// predictor never calls without overriding.
pub const CONF_THRESHOLD: f32 = 0.25;
pub const IOU_THRESHOLD: f32 = 0.7;

/// A detected panel, in page coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Panel {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
}

/// Fit an image into the model's input.
///
/// Returns the padded RGB rectangle and the `Letterbox` that produced it — the
/// caller needs the latter to map predictions back, and returning them together
/// is what stops the two drifting apart.
///
/// Two things here are copied rather than approximated. The resize is OpenCV's
/// fixed-point `INTER_LINEAR`, because that is what `LetterBox.apply_image`
/// calls (`ultralytics/data/augment.py:1761`) and a float bilinear differs by a
/// count or two per pixel — which is a different image and therefore a different
/// prediction. And the canvas is the letterbox's *rectangle*, not a 640 square;
/// padding out to a square would hand the network a strip of grey it never saw
/// in prediction and shift every box by the difference in pad.
///
/// Colour order: `detect.py` hands `cv2` a BGR page and the predictor flips it
/// to RGB (`im[..., ::-1]`, `ultralytics/engine/predictor.py:167`), so the
/// network sees RGB — what `to_rgb8` already gives. Resizing commutes with a
/// channel permutation, so doing the flip first, as here, is the same image.
pub fn preprocess(img: &DynamicImage) -> (RgbImage, Letterbox) {
    let (w, h) = img.dimensions();
    let lb = Letterbox::fit(w, h, INPUT_SIZE, STRIDE);
    let rgb = img.to_rgb8();

    // Ultralytics skips the resize entirely when the shape already matches;
    // `resize_linear_u8` is an identity there anyway, but not calling it keeps
    // the two paths obviously the same.
    let scaled = if (lb.inner_w, lb.inner_h) == (w, h) {
        rgb.into_raw()
    } else {
        resize_linear_u8(
            rgb.as_raw(),
            w as usize,
            h as usize,
            3,
            lb.inner_w as usize,
            lb.inner_h as usize,
        )
    };
    let scaled = RgbImage::from_raw(lb.inner_w, lb.inner_h, scaled)
        .expect("resize_linear_u8 returns inner_w * inner_h * 3 bytes");

    let mut canvas = RgbImage::from_pixel(lb.net_w, lb.net_h, image::Rgb([PAD, PAD, PAD]));
    image::imageops::replace(&mut canvas, &scaled, lb.pad_x as i64, lb.pad_y as i64);
    (canvas, lb)
}

/// Pack the padded input into the NCHW float tensor the model expects.
///
/// Planar, not interleaved — all the red values, then all the green, then all
/// the blue. Feeding interleaved data produces output that is not obviously
/// wrong, just quietly bad, which is why this is its own function with its own
/// test rather than a loop inside `detect`.
pub fn to_nchw(img: &RgbImage) -> Vec<f32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut out = vec![0f32; 3 * w * h];
    for (x, y, px) in img.enumerate_pixels() {
        let (x, y) = (x as usize, y as usize);
        for c in 0..3 {
            out[c * w * h + y * w + x] = px.0[c] as f32 / 255.0;
        }
    }
    out
}

/// Run the panel model over one page.
///
/// `class_frame` is the class index the export uses for a panel. The manga109
/// model is multi-class — text, face, body, frame — and only frames are wanted
/// here; the index is a parameter rather than a constant because it belongs to
/// the checkpoint, and a checkpoint swapped for a newer revision could
/// reorder it. Slice 1 pins it once the real model's metadata has been read.
pub fn detect(session: &mut Session, img: &DynamicImage, class_frame: usize) -> ort::Result<Vec<Panel>> {
    let (w, h) = img.dimensions();
    let (padded, lb) = preprocess(img);
    let input = Tensor::from_array((
        [1usize, 3, lb.net_h as usize, lb.net_w as usize],
        to_nchw(&padded),
    ))?;

    // Addressed by position, not by name: the exported graph has exactly one
    // input and one output, and the names differ between Ultralytics versions.
    let outputs = session.run(ort::inputs![input])?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;

    // `[1, 4 + classes, anchors]`.
    let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
    if dims.len() != 3 {
        return Ok(Vec::new());
    }
    let boxes = decode_yolo11(data, dims[1], dims[2], CONF_THRESHOLD);
    let kept = nms(boxes, IOU_THRESHOLD);

    Ok(kept
        .into_iter()
        .filter(|b| b.class == class_frame)
        .map(|b| {
            let s: BBox = lb.to_source(b, w, h);
            Panel { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, score: s.score }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn page(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb([255, 255, 255])))
    }

    #[test]
    fn preprocess_produces_a_stride_aligned_rectangle_not_a_square() {
        // The long edge reaches `INPUT_SIZE`; the short edge stops at the next
        // multiple of the stride and no further. A square canvas here is the
        // bug this test exists to catch.
        for (w, h) in [(1200u32, 1800u32), (1800, 1200), (640, 640), (1080, 1535)] {
            let (im, lb) = preprocess(&page(w, h));
            assert_eq!((im.width(), im.height()), (lb.net_w, lb.net_h), "{w}x{h}");
            assert_eq!(im.width() % STRIDE, 0, "{w}x{h}: width {}", im.width());
            assert_eq!(im.height() % STRIDE, 0, "{w}x{h}: height {}", im.height());
            assert_eq!(im.width().max(im.height()), INPUT_SIZE, "{w}x{h}");
            assert!(im.width() <= INPUT_SIZE && im.height() <= INPUT_SIZE, "{w}x{h}");
            // Never more than a stride of padding on either axis.
            assert!(im.width() - lb.inner_w < STRIDE, "{w}x{h}");
            assert!(im.height() - lb.inner_h < STRIDE, "{w}x{h}");
        }
        // The golden pages, spelled out: 640x480 into the network.
        let (im, _) = preprocess(&page(1080, 1535));
        assert_eq!((im.width(), im.height()), (480, 640));
    }

    #[test]
    fn preprocess_fills_the_border_with_grey_and_the_middle_with_the_page() {
        // A tall page pads left and right. The corner must be the pad colour and
        // the centre must be the page — swapped, the model would be looking at
        // a grey rectangle with a white frame.
        let (im, lb) = preprocess(&page(1200, 1800));
        assert!(lb.pad_x > 0 && lb.pad_y == 0);
        assert_eq!(im.get_pixel(0, lb.net_h / 2).0, [PAD, PAD, PAD]);
        assert_eq!(im.get_pixel(lb.net_w / 2, lb.net_h / 2).0, [255, 255, 255]);
    }

    #[test]
    fn to_nchw_is_planar_and_normalised() {
        let mut img = RgbImage::from_pixel(2, 2, Rgb([0, 0, 0]));
        img.put_pixel(1, 0, Rgb([255, 128, 0]));
        let t = to_nchw(&img);
        assert_eq!(t.len(), 3 * 4);
        // Plane offsets: red is 0..4, green 4..8, blue 8..12. Pixel (1,0) is
        // index 1 within each plane.
        assert_eq!(t[1], 1.0);
        assert!((t[4 + 1] - 128.0 / 255.0).abs() < 1e-6);
        assert_eq!(t[8 + 1], 0.0);
        // Everything else is the black fill.
        assert_eq!(t[0], 0.0);
    }

    #[test]
    fn to_nchw_length_matches_the_declared_tensor_shape() {
        let (im, lb) = preprocess(&page(1200, 1800));
        assert_eq!(to_nchw(&im).len(), 3 * lb.net_w as usize * lb.net_h as usize);
    }

    #[test]
    fn load_session_opens_model_and_frame_class_matches_metadata() {
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping test: HOME not set");
            return;
        };
        let model_path = std::path::PathBuf::from(home)
            .join(".mangatypesetter")
            .join("models")
            .join("manga109_yolo_l_yv11.onnx");
        if !model_path.exists() {
            eprintln!("skipping test: model not found at {}", model_path.display());
            return;
        }

        let session = load_session(&model_path).expect("failed to load session");
        let metadata = session.metadata().expect("failed to get metadata");
        let names = metadata.custom("names").expect("missing 'names' in metadata");
        assert!(
            names.contains("2: 'frame'"),
            "expected metadata 'names' to contain \"2: 'frame'\", got: {names}"
        );
    }

    /// One page of the golden fixture: what the Python sidecar returned for it.
    ///
    /// `panels` is in the sidecar's *detection* order, which is score order out
    /// of NMS and not anything stable, so the comparison below treats it as a
    /// set. `img_width`/`img_height` are carried so a fixture accidentally
    /// regenerated against different scans fails loudly on the dimensions
    /// rather than subtly on the boxes.
    #[derive(serde::Deserialize)]
    struct GoldenPage {
        file: String,
        img_width: u32,
        img_height: u32,
        panels: Vec<[i32; 4]>,
    }

    /// The IoU a Rust panel must reach against a golden box to be *paired* with
    /// it.
    ///
    /// This is only the matcher: it decides which Rust box is which golden box,
    /// and then the coordinates are compared directly against
    /// [`GOLDEN_MAX_COORD_DELTA`]. It is set well above what any pairing needs
    /// so that a genuinely misplaced box fails on the coordinate assertion, with
    /// its numbers printed, rather than silently failing to pair.
    const GOLDEN_MIN_IOU: f32 = 0.9;

    /// How far a rounded panel coordinate may sit from Ultralytics'.
    ///
    /// Zero. Both sides run the same letterbox, the same fixed-point resize, the
    /// same decode, the same NMS and the same `scale_boxes`, and both round the
    /// result with Python's round-half-to-even — so once the preprocessing is
    /// faithful the only difference left is the network itself, `torch` against
    /// `onnxruntime`, and that lands far below the half-pixel it would take to
    /// move an integer. Measured across all three fixture pages: every one of
    /// the 4 + 6 + 4 boxes agrees on all four edges exactly.
    ///
    /// If this ever has to be raised, raise it with a comment naming the
    /// coordinate and the cause. Loosening it silently would give back exactly
    /// the drift this test was tightened to remove.
    const GOLDEN_MAX_COORD_DELTA: i32 = 0;

    fn as_bbox(x1: f32, y1: f32, x2: f32, y2: f32) -> BBox {
        BBox { x1, y1, x2, y2, score: 1.0, class: FRAME_CLASS }
    }

    /// `[int(round(v)) for v in box]`, which is how `detect_panels` emits a box.
    fn rounded(p: &Panel) -> [i32; 4] {
        let r = |v: f32| super::super::textblock::round_half_even(v as f64) as i32;
        [r(p.x1), r(p.y1), r(p.x2), r(p.y2)]
    }

    #[test]
    fn detect_matches_the_python_sidecar_on_the_golden_pages() {
        // The whole point of the port is that it produces the same panels as
        // the `ultralytics` path it replaces. Every other test in this file
        // checks a piece of the pipeline in isolation; this is the only one
        // that checks the pipeline is the *same* pipeline, end to end, on real
        // scans rather than on a white rectangle.
        //
        // It skips rather than fails when its inputs are absent: the model is a
        // 97 MB download that is not in the repo, and the fixture references
        // pages under the developer's own Documents folder, so on CI or a fresh
        // clone there is nothing here to compare against.
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping golden test: HOME not set");
            return;
        };
        let model_path = std::path::PathBuf::from(home)
            .join(".mangatypesetter")
            .join("models")
            .join("manga109_yolo_l_yv11.onnx");
        if !model_path.exists() {
            eprintln!("skipping golden test: model not found at {}", model_path.display());
            return;
        }

        let fixture_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/panel-golden.json");
        let Ok(fixture_json) = std::fs::read_to_string(&fixture_path) else {
            eprintln!("skipping golden test: fixture not found at {}", fixture_path.display());
            return;
        };
        let golden: Vec<GoldenPage> =
            serde_json::from_str(&fixture_json).expect("panel-golden.json is not the expected shape");

        for page in &golden {
            if !std::path::Path::new(&page.file).exists() {
                eprintln!("skipping golden test: fixture page not found at {}", page.file);
                return;
            }
        }

        let mut session = load_session(&model_path).expect("failed to load session");

        for page in &golden {
            let img = image::open(&page.file).unwrap_or_else(|e| panic!("{}: {e}", page.file));
            let (w, h) = img.dimensions();
            assert_eq!(
                (w, h),
                (page.img_width, page.img_height),
                "{}: page on disk is {w}x{h} but the fixture was recorded at {}x{}",
                page.file,
                page.img_width,
                page.img_height
            );

            let found = detect(&mut session, &img, FRAME_CLASS).expect("detect failed");

            assert_eq!(
                found.len(),
                page.panels.len(),
                "{}: {} panels {:?}, expected {} {:?}",
                page.file,
                found.len(),
                found.iter().map(rounded).collect::<Vec<_>>(),
                page.panels.len(),
                page.panels
            );

            // Greedy one-to-one matching, best first. Greedy is safe at this
            // threshold: two boxes that both reach 0.9 IoU against the same
            // golden box would have to overlap each other by more than NMS
            // allows, so there is no pairing this misses that an optimal
            // assignment would find. Matching rather than zipping because the
            // fixture is in the sidecar's detection order, which is score order
            // out of NMS and not anything stable.
            let mut unmatched: Vec<[i32; 4]> = found.iter().map(rounded).collect();
            let mut worst_delta = 0i32;

            for g in &page.panels {
                let gold = as_bbox(g[0] as f32, g[1] as f32, g[2] as f32, g[3] as f32);
                let best = unmatched
                    .iter()
                    .enumerate()
                    .map(|(i, c)| (i, gold.iou(&as_bbox(c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32))))
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                let Some((i, iou)) = best else {
                    panic!(
                        "{}: golden box {:?} has no Rust panel left to match \
                         ({} golden boxes, {} Rust panels)",
                        page.file,
                        g,
                        page.panels.len(),
                        found.len()
                    );
                };
                assert!(
                    iou >= GOLDEN_MIN_IOU,
                    "{}: golden box {:?} best-matches Rust panel {:?} at IoU {iou:.4}, \
                     below the {GOLDEN_MIN_IOU} pairing floor",
                    page.file,
                    g,
                    unmatched[i]
                );

                // The assertion that matters. IoU only paired the boxes; this
                // is the claim that the port reproduces Ultralytics' arithmetic
                // rather than merely landing near it.
                let got = unmatched.swap_remove(i);
                let delta = (0..4).map(|k| (got[k] - g[k]).abs()).max().unwrap_or(0);
                assert!(
                    delta <= GOLDEN_MAX_COORD_DELTA,
                    "{}: panel {got:?} differs from Ultralytics' {g:?} by {delta} px \
                     (per edge: {:?}); the ceiling is {GOLDEN_MAX_COORD_DELTA}",
                    page.file,
                    (0..4).map(|k| got[k] - g[k]).collect::<Vec<_>>()
                );
                worst_delta = worst_delta.max(delta);
            }

            assert!(
                unmatched.is_empty(),
                "{}: Rust produced {} panel(s) with no golden counterpart: {:?}",
                page.file,
                unmatched.len(),
                unmatched
            );

            eprintln!(
                "golden {}: {} panels, worst coordinate delta {worst_delta} px",
                std::path::Path::new(&page.file)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                page.panels.len(),
            );
        }
    }
}

