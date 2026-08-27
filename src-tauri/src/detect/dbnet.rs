//! Recovers text-line quads from DBNet's shrunk probability map via polygon unclip.
//!
//! Port of `SegDetectorRepresenter.boxes_from_bitmap` in `comic_text_detector`.

use super::cvops::{box_score_fast, find_contours};
use super::minrect::{mini_box, offset_round};

/// Probability above which a pixel counts as part of a shrunk text region.
pub const BITMAP_THRESH: f32 = 0.3;
/// How far the fitted rectangle is grown, as a multiple of area/perimeter.
pub const UNCLIP_RATIO: f64 = 1.5;
/// Contours past this many are ignored, as in the original.
pub const MAX_CANDIDATES: usize = 1000;
/// Minimum short side, in model pixels, for a candidate to be considered.
pub const MIN_SHORT_SIDE: f32 = 2.0;

/// One text-line candidate: a quad in model-input pixels and its mean probability.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineQuad {
    pub pts: [[i32; 2]; 4],
    pub score: f32,
}

/// Half-to-even rounding matching numpy.
fn round_half_even(v: f32) -> f32 {
    let r = v.round();
    if (v - v.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - v.signum()
    } else {
        r
    }
}

/// Extracts line quads from a DBNet probability map in model coordinates.
pub fn boxes_from_bitmap(pred: &[f32], w: usize, h: usize) -> Vec<LineQuad> {
    let bitmap: Vec<bool> = pred.iter().map(|&v| v > BITMAP_THRESH).collect();
    let contours = find_contours(&bitmap, w, h);
    let mut out = Vec::new();

    for contour in contours.iter().take(MAX_CANDIDATES) {
        let fpts: Vec<(f32, f32)> = contour.iter().map(|&(x, y)| (x as f32, y as f32)).collect();
        let (quad, sside) = mini_box(&fpts);
        if sside < MIN_SHORT_SIDE {
            continue;
        }
        // Scored on the contour rather than the bounding box.
        let score = box_score_fast(pred, w, h, contour);

        let side_a = ((quad[1].0 - quad[0].0) as f64).hypot((quad[1].1 - quad[0].1) as f64);
        let side_b = ((quad[2].0 - quad[1].0) as f64).hypot((quad[2].1 - quad[1].1) as f64);
        let perimeter = 2.0 * (side_a + side_b);
        if perimeter <= 0.0 {
            continue;
        }
        let distance = side_a * side_b * UNCLIP_RATIO / perimeter;

        let expanded = offset_round(&quad.map(|p| (p.0 as f64, p.1 as f64)), distance);
        if expanded.len() < 3 {
            continue;
        }
        let epts: Vec<(f32, f32)> = expanded.iter().map(|&(x, y)| (x as f32, y as f32)).collect();
        let (refit, _) = mini_box(&epts);

        let mut pts = [[0i32; 2]; 4];
        for (i, p) in refit.iter().enumerate() {
            pts[i][0] = round_half_even(p.0).clamp(0.0, w as f32) as i32;
            pts[i][1] = round_half_even(p.1).clamp(0.0, h as f32) as i32;
        }
        out.push(LineQuad { pts, score });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_half_even_matches_numpy() {
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(-0.5), -0.0);
        assert_eq!(round_half_even(-1.5), -2.0);
        assert_eq!(round_half_even(2.4), 2.0);
        assert_eq!(round_half_even(2.6), 3.0);
    }

    /// Paint a filled rectangle of high probability into an otherwise empty map.
    fn map_with_rect(w: usize, h: usize, x1: usize, y1: usize, x2: usize, y2: usize) -> Vec<f32> {
        let mut p = vec![0.0f32; w * h];
        for y in y1..y2 {
            for x in x1..x2 {
                p[y * w + x] = 0.9;
            }
        }
        p
    }

    #[test]
    fn a_single_blob_becomes_one_quad_grown_past_the_blob() {
        // The whole point of the unclip: the network's blob is the *shrunk*
        // line, so the quad must come back bigger than what was painted.
        let (w, h) = (64usize, 64usize);
        let pred = map_with_rect(w, h, 20, 10, 30, 50);
        let quads = boxes_from_bitmap(&pred, w, h);
        assert_eq!(quads.len(), 1);
        let q = quads[0];
        assert!(q.score > 0.85, "score {}", q.score);
        let xs: Vec<i32> = q.pts.iter().map(|p| p[0]).collect();
        let ys: Vec<i32> = q.pts.iter().map(|p| p[1]).collect();
        assert!(*xs.iter().min().unwrap() < 20, "{q:?}");
        assert!(*xs.iter().max().unwrap() > 29, "{q:?}");
        assert!(*ys.iter().min().unwrap() < 10, "{q:?}");
        assert!(*ys.iter().max().unwrap() > 49, "{q:?}");
    }

    #[test]
    fn two_separated_blobs_stay_two_quads() {
        let (w, h) = (80usize, 80usize);
        let mut pred = map_with_rect(w, h, 10, 10, 18, 60);
        for (i, v) in map_with_rect(w, h, 50, 10, 58, 60).iter().enumerate() {
            if *v > 0.0 {
                pred[i] = *v;
            }
        }
        assert_eq!(boxes_from_bitmap(&pred, w, h).len(), 2);
    }

    #[test]
    fn a_blob_thinner_than_the_minimum_short_side_is_dropped() {
        let (w, h) = (40usize, 40usize);
        let pred = map_with_rect(w, h, 10, 5, 11, 35);
        assert!(boxes_from_bitmap(&pred, w, h).is_empty());
    }

    #[test]
    fn a_blob_below_the_bitmap_threshold_is_invisible() {
        let (w, h) = (40usize, 40usize);
        let mut pred = vec![0.0f32; w * h];
        for y in 5..35 {
            for x in 10..20 {
                pred[y * w + x] = 0.29;
            }
        }
        assert!(boxes_from_bitmap(&pred, w, h).is_empty());
    }

    #[test]
    fn a_hollow_blob_scores_low_on_its_hole() {
        // RETR_LIST returns the hole border as its own candidate. It survives to
        // here, and what keeps it out of the output is its score: the mean
        // probability inside a hole is near zero, far below the 0.6 the caller
        // applies.
        let (w, h) = (60usize, 60usize);
        let mut pred = map_with_rect(w, h, 10, 10, 50, 50);
        for y in 20..40 {
            for x in 20..40 {
                pred[y * w + x] = 0.0;
            }
        }
        let quads = boxes_from_bitmap(&pred, w, h);
        assert_eq!(quads.len(), 2);
        let mut scores: Vec<f32> = quads.iter().map(|q| q.score).collect();
        scores.sort_by(f32::total_cmp);
        assert!(scores[0] < 0.6, "hole scored {}", scores[0]);
        assert!(scores[1] > 0.6, "outer scored {}", scores[1]);
    }

    #[test]
    fn an_empty_map_yields_nothing() {
        assert!(boxes_from_bitmap(&vec![0.0f32; 32 * 32], 32, 32).is_empty());
    }
}
