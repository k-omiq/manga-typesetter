//! Grading a candidate tip against the preview CSP ships beside it.
//!
//! Every material archive contains `thumbnail/thumbnail.png`, CSP's own render
//! of the finished tip. That is an answer key inside every file: score each
//! candidate plane against it, in both polarities, and keep the best. A reading
//! that does not match is not shipped as though it were sharp - it falls back
//! to the preview and says so.

use image::{imageops::FilterType, GrayImage};

use super::{Tip, TipSource, TRUST_MAX_DIFF};

/// CSP's thumbnail as an ink mask: 255 where the brush marks.
///
/// The tip is stored in the alpha channel when there is one, and as dark ink on
/// white when there is not.
pub fn as_ink(png: &[u8]) -> Option<GrayImage> {
    let im = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let (w, h) = (im.width(), im.height());
    if w == 0 || h == 0 {
        return None;
    }
    if im.color().has_alpha() {
        let rgba = im.to_rgba8();
        let alpha: Vec<u8> = rgba.pixels().map(|p| p.0[3]).collect();
        // A fully opaque alpha channel carries no shape; the ink is in the RGB.
        if alpha.iter().copied().min().unwrap_or(255) < 250 {
            return GrayImage::from_raw(w, h, alpha);
        }
    }
    let rgb = im.to_rgb8();
    // ITU-R 601-2 luma, the same integer form PIL's `convert("L")` uses, so a
    // reading graded here scores what it scored in the reference extractor.
    let ink: Vec<u8> = rgb
        .pixels()
        .map(|p| {
            let [r, g, b] = p.0;
            let l = (r as u32 * 19595 + g as u32 * 38470 + b as u32 * 7471 + 0x8000) >> 16;
            255 - l.min(255) as u8
        })
        .collect();
    GrayImage::from_raw(w, h, ink)
}

/// A candidate at the thumbnail's size, for comparison.
fn fit(tip: &GrayImage, w: u32, h: u32) -> GrayImage {
    image::imageops::resize(tip, w.max(1), h.max(1), FilterType::Lanczos3)
}

/// Mean absolute difference from the thumbnail, 0 (same) to 255.
fn diff(small: &GrayImage, oracle: &GrayImage, inverted: bool) -> f32 {
    let n = small.len().min(oracle.len());
    if n == 0 {
        return f32::MAX;
    }
    let mut sum = 0f64;
    for (s, o) in small.iter().take(n).zip(oracle.iter()) {
        let s = if inverted { 255 - *s } else { *s };
        sum += (s as f64 - *o as f64).abs();
    }
    (sum / n as f64) as f32
}

/// The best candidate seen so far, and nothing else.
///
/// Candidates arrive one at a time and only the winner is held: a page-sized
/// brush strip is tens of megabytes per plane, and a material can hold several
/// rows of several planes. Collecting them all to pick one cost 488 MB over the
/// corpus against 285 MB for this shape, which is the whole reason [`offer`]
/// takes ownership of one image rather than a list.
///
/// [`offer`]: Scorer::offer
pub struct Scorer {
    oracle: Option<GrayImage>,
    best: Option<GrayImage>,
    best_diff: Option<f32>,
    best_inverted: bool,
}

impl Scorer {
    /// A scorer graded against `oracle`, or ungraded when the file shipped no
    /// preview to grade against.
    pub fn new(oracle: Option<GrayImage>) -> Self {
        Scorer { oracle, best: None, best_diff: None, best_inverted: false }
    }

    /// Offer one candidate plane. Kept only if it beats the current best.
    pub fn offer(&mut self, img: GrayImage) {
        let Some(oracle) = self.oracle.as_ref() else {
            // Nothing to grade against: take the largest reading.
            // `map_or` rather than `is_none_or`: the crate's declared MSRV is 1.77.
            let bigger = self.best.as_ref().map_or(true, |b| img.len() > b.len());
            if bigger {
                self.best = Some(img);
                self.best_inverted = false;
            }
            return;
        };
        // Score both polarities from one downscale rather than building an
        // inverted full-size copy of every candidate.
        let small = fit(&img, oracle.width(), oracle.height());
        let straight = diff(&small, oracle, false);
        let flipped = diff(&small, oracle, true);
        let (d, inverted) =
            if flipped < straight { (flipped, true) } else { (straight, false) };
        if self.best_diff.map_or(true, |b| d < b) {
            self.best = Some(img);
            self.best_diff = Some(d);
            self.best_inverted = inverted;
        }
    }

    /// The ladder: full-resolution pixels that match, else CSP's preview, else
    /// nothing at all.
    pub fn finish(self) -> Option<Tip> {
        let Scorer { oracle, best, best_diff, best_inverted } = self;
        if let Some(mut image) = best {
            if oracle.is_none() || best_diff.is_some_and(|d| d <= TRUST_MAX_DIFF) {
                if best_inverted {
                    image.iter_mut().for_each(|p| *p = 255 - *p);
                }
                return Some(Tip { image, source: TipSource::Pixels, diff: best_diff });
            }
        }
        // The pixels were unreadable or did not match. The thumbnail is small
        // but it is certainly this brush, so ship it and say so. CSP caps its
        // own thumbnails at 300 px; a file that does not is cut down to the
        // promised size rather than trusted.
        oracle.map(|image| {
            let (w, h) = image.dimensions();
            let side = w.max(h);
            let image = if side > 300 {
                fit(&image, w * 300 / side, h * 300 / side)
            } else {
                image
            };
            Tip { image, source: TipSource::Thumbnail, diff: best_diff }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, v: u8) -> GrayImage {
        GrayImage::from_raw(w, h, vec![v; (w * h) as usize]).unwrap()
    }

    #[test]
    fn a_matching_plane_is_taken_at_pixel_source() {
        let mut s = Scorer::new(Some(solid(4, 4, 255)));
        s.offer(solid(16, 16, 255));
        let tip = s.finish().unwrap();
        assert_eq!(tip.source, TipSource::Pixels);
        assert_eq!(tip.image.dimensions(), (16, 16));
        assert!(tip.trusted());
    }

    #[test]
    fn an_inverted_plane_is_flipped_back_before_it_ships() {
        let mut s = Scorer::new(Some(solid(4, 4, 255)));
        s.offer(solid(16, 16, 0));
        let tip = s.finish().unwrap();
        assert_eq!(tip.source, TipSource::Pixels);
        assert!(tip.image.iter().all(|&p| p == 255), "the stored polarity is ink-at-255");
    }

    #[test]
    fn a_plane_that_does_not_match_falls_back_to_the_preview() {
        let mut s = Scorer::new(Some(solid(4, 4, 128)));
        s.offer(solid(16, 16, 255));
        let tip = s.finish().unwrap();
        assert_eq!(tip.source, TipSource::Thumbnail);
        assert_eq!(tip.image.dimensions(), (4, 4));
        assert!(!tip.trusted());
        assert!(tip.diff.unwrap() > TRUST_MAX_DIFF, "the miss is reported, not hidden");
    }

    #[test]
    fn with_no_preview_the_largest_reading_wins_ungraded() {
        let mut s = Scorer::new(None);
        s.offer(solid(4, 4, 255));
        s.offer(solid(16, 16, 255));
        s.offer(solid(2, 2, 255));
        let tip = s.finish().unwrap();
        assert_eq!(tip.image.dimensions(), (16, 16));
        assert_eq!(tip.diff, None);
        assert!(!tip.trusted(), "an ungraded reading is never called trusted");
    }

    #[test]
    fn nothing_at_all_yields_no_tip() {
        assert!(Scorer::new(None).finish().is_none());
    }

    #[test]
    fn a_thumbnail_that_is_not_a_png_is_declined_rather_than_decoded() {
        assert!(as_ink(b"not a png").is_none());
        assert!(as_ink(&[]).is_none());
    }
}
