//! Brush import: reading brush tips out of the files a letterer already owns.
//!
//! [`sut`] is the parser for Clip Studio Paint `.sut` files; [`score`] grades
//! what it read against the preview image CSP ships inside the same file. The
//! Tauri command and the fallback ladder above them live one level up.

pub mod score;
pub mod sut;

use image::GrayImage;

/// A reading is only trusted when it is at least this close to the thumbnail.
/// Measured as mean absolute difference over 0-255, so 24 is under 10%.
pub const TRUST_MAX_DIFF: f32 = 24.0;

/// Where a tip's pixels came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TipSource {
    /// Full resolution, out of the material's pixel blob.
    Pixels,
    /// CSP's own preview, capped at 300 px, used when the pixels were
    /// unreadable or did not match.
    Thumbnail,
}

/// One brush tip, and how much to trust it.
#[derive(Debug, Clone)]
pub struct Tip {
    /// 8-bit mask, 255 where the brush marks.
    pub image: GrayImage,
    pub source: TipSource,
    /// Mean absolute difference from CSP's preview, 0 (same) to 255. `None`
    /// when there was nothing to check against.
    pub diff: Option<f32>,
}

impl Tip {
    /// Full-resolution pixels that agree with CSP's own preview.
    pub fn trusted(&self) -> bool {
        self.source == TipSource::Pixels && self.diff.is_some_and(|d| d <= TRUST_MAX_DIFF)
    }

    /// Pixel count, which is how tips are ranked.
    pub fn area(&self) -> u64 {
        self.image.width() as u64 * self.image.height() as u64
    }
}
