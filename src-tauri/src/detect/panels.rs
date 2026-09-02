//! Panel detection using manga109 YOLO model.
//!
//! Provides panel bounding boxes to guide reading-order sorting.

use image::{DynamicImage, GenericImageView, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

use super::cvops::resize_linear_u8;
use super::geometry::{decode_yolo11, nms, BBox, Letterbox};

/// Class index for panel frame in manga109 YOLO model.
pub const FRAME_CLASS: usize = 2;

/// Class index for text region in manga109 YOLO model (`{0: 'body', 1: 'face', 2: 'frame', 3: 'text'}`).
pub const TEXT_CLASS: usize = 3;

/// Loads an ONNX session for manga109 panel detection (CPU only).
///
/// CPU execution is used deliberately to match float precision: GPU providers
/// (CoreML measurably, the others by the same mechanism) drift box edges.
pub fn load_session(model_path: &std::path::Path) -> ort::Result<Session> {
    Session::builder()?.commit_from_file(model_path)
}

/// Long-edge size budget for YOLO letterboxing (640).
pub const INPUT_SIZE: u32 = 640;

/// Model stride for padding alignment (32).
pub const STRIDE: u32 = 32;

/// Padding color (114 grey, matching Ultralytics).
const PAD: u8 = 114;

/// Confidence and NMS IoU thresholds matching Ultralytics defaults.
pub const CONF_THRESHOLD: f32 = 0.25;
pub const IOU_THRESHOLD: f32 = 0.7;

/// Detected panel in page coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Panel {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
}

/// Preprocesses image for YOLO input: letterbox fit, OpenCV fixed-point linear resize, grey padding.
pub fn preprocess(img: &DynamicImage) -> (RgbImage, Letterbox) {
    let (w, h) = img.dimensions();
    let lb = Letterbox::fit(w, h, INPUT_SIZE, STRIDE);
    let rgb = img.to_rgb8();

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

/// Packs RGB image into normalized float NCHW planar tensor.
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

/// Runs panel detection model on an image and returns all kept bounding boxes in page coordinates.
pub fn detect_classes(session: &mut Session, img: &DynamicImage) -> ort::Result<Vec<BBox>> {
    let (w, h) = img.dimensions();
    let (padded, lb) = preprocess(img);
    let input = Tensor::from_array((
        [1usize, 3, lb.net_h as usize, lb.net_w as usize],
        to_nchw(&padded),
    ))?;

    let outputs = session.run(ort::inputs![input])?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;

    let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
    if dims.len() != 3 {
        return Ok(Vec::new());
    }
    let boxes = decode_yolo11(data, dims[1], dims[2], CONF_THRESHOLD);
    let kept = nms(boxes, IOU_THRESHOLD);

    Ok(kept.into_iter().map(|b| lb.to_source(b, w, h)).collect())
}

/// Runs panel detection model on an image and returns panel boxes in page coordinates.
pub fn detect(session: &mut Session, img: &DynamicImage, class_frame: usize) -> ort::Result<Vec<Panel>> {
    let boxes = detect_classes(session, img)?;
    Ok(boxes
        .into_iter()
        .filter(|b| b.class == class_frame)
        .map(|s| Panel {
            x1: s.x1,
            y1: s.y1,
            x2: s.x2,
            y2: s.y2,
            score: s.score,
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
        // Pad color goes to border, page image to center.
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
        assert!(
            names.contains("3: 'text'"),
            "expected metadata 'names' to contain \"3: 'text'\", got: {names}"
        );
    }

    /// Golden page fixture entry from `panel-golden.json`.
    #[derive(serde::Deserialize)]
    struct GoldenPage {
        file: String,
        img_width: u32,
        img_height: u32,
        panels: Vec<[i32; 4]>,
    }

    /// Minimum IoU floor for pairing detected boxes against golden references.
    const GOLDEN_MIN_IOU: f32 = 0.9;

    /// Maximum allowed delta between Rust and Python panel box coordinates (0 px).
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

