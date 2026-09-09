//! Minimum-area bounding rectangles and polygon offsetting for DBNet post-processing.
//!
//! Re-implements OpenCV rotating calipers (`minAreaRect`) and pyclipper `JT_ROUND` offsetting.

/// Rotated rectangle: centre, `(w, h)`, and angle in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RotRect {
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
    pub angle: f32,
}

impl RotRect {
    /// Shorter side length.
    pub fn short_side(&self) -> f32 {
        self.w.min(self.h)
    }
}

/// Strict 2D convex hull matching OpenCV `convexHull(clockwise=true)` vertex ordering.
pub fn convex_hull(points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut pts: Vec<(f32, f32)> = points.to_vec();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    pts.dedup();
    if pts.len() <= 2 {
        return pts;
    }
    let cross = |o: (f32, f32), a: (f32, f32), b: (f32, f32)| -> f64 {
        (a.0 - o.0) as f64 * (b.1 - o.1) as f64 - (a.1 - o.1) as f64 * (b.0 - o.0) as f64
    };
    let mut lower: Vec<(f32, f32)> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<(f32, f32)> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    let mut hull: Vec<(f32, f32)> = Vec::with_capacity(lower.len() + upper.len());
    hull.extend_from_slice(&lower[..lower.len() - 1]);
    hull.extend_from_slice(&upper[..upper.len() - 1]);
    // Sklansky ordering reversal.
    let rest: Vec<(f32, f32)> = hull[1..].iter().rev().copied().collect();
    let mut out = vec![hull[0]];
    out.extend(rest);
    out
}

/// Rotating calipers minimum-area bounding box matching OpenCV's `minAreaRect`.
pub fn min_area_rect(points: &[(f32, f32)]) -> RotRect {
    let p = convex_hull(points);
    let n = p.len();
    if n == 0 {
        return RotRect { cx: 0.0, cy: 0.0, w: 0.0, h: 0.0, angle: 0.0 };
    }
    if n == 1 {
        return RotRect { cx: p[0].0, cy: p[0].1, w: 0.0, h: 0.0, angle: 0.0 };
    }
    if n == 2 {
        let dx = (p[1].0 - p[0].0) as f64;
        let dy = (p[1].1 - p[0].1) as f64;
        return RotRect {
            cx: (p[0].0 + p[1].0) * 0.5,
            cy: (p[0].1 + p[1].1) * 0.5,
            w: (dx * dx + dy * dy).sqrt() as f32,
            h: 0.0,
            angle: (dy.atan2(dx) * 180.0 / std::f64::consts::PI) as f32,
        };
    }

    let mut vect: Vec<(f32, f32)> = Vec::with_capacity(n);
    let mut inv_len: Vec<f32> = Vec::with_capacity(n);
    let (mut left, mut bottom, mut right, mut top) = (0usize, 0usize, 0usize, 0usize);
    let mut pt0 = p[0];
    let (mut left_x, mut right_x) = (pt0.0, pt0.0);
    let (mut top_y, mut bottom_y) = (pt0.1, pt0.1);
    for i in 0..n {
        if pt0.0 < left_x {
            left_x = pt0.0;
            left = i;
        }
        if pt0.0 > right_x {
            right_x = pt0.0;
            right = i;
        }
        if pt0.1 > top_y {
            top_y = pt0.1;
            top = i;
        }
        if pt0.1 < bottom_y {
            bottom_y = pt0.1;
            bottom = i;
        }
        let pt = p[(i + 1) % n];
        let dx = pt.0 as f64 - pt0.0 as f64;
        let dy = pt.1 as f64 - pt0.1 as f64;
        vect.push((dx as f32, dy as f32));
        inv_len.push((1.0 / (dx * dx + dy * dy).sqrt()) as f32);
        pt0 = pt;
    }

    // Determine initial caliper orientation.
    let mut orientation = 0f32;
    let (mut ax, mut ay) = (vect[n - 1].0 as f64, vect[n - 1].1 as f64);
    for e in &vect {
        let (bx, by) = (e.0 as f64, e.1 as f64);
        let convexity = ax * by - ay * bx;
        if convexity != 0.0 {
            orientation = if convexity > 0.0 { 1.0 } else { -1.0 };
            break;
        }
        ax = bx;
        ay = by;
    }

    let mut base_a = orientation;
    let mut base_b = 0f32;
    let mut seq = [bottom, right, top, left];
    let mut minarea = f32::MAX;
    let mut best = (0usize, 0f32, 0f32, 0f32, 0f32, 0usize);

    for _ in 0..n {
        let dp = [
            base_a * vect[seq[0]].0 + base_b * vect[seq[0]].1,
            -base_b * vect[seq[1]].0 + base_a * vect[seq[1]].1,
            -base_a * vect[seq[2]].0 - base_b * vect[seq[2]].1,
            base_b * vect[seq[3]].0 - base_a * vect[seq[3]].1,
        ];
        let mut maxcos = dp[0] * inv_len[seq[0]];
        let mut main = 0usize;
        for i in 1..4 {
            let c = dp[i] * inv_len[seq[i]];
            if c > maxcos {
                main = i;
                maxcos = c;
            }
        }
        let pi = seq[main];
        let lead_x = vect[pi].0 * inv_len[pi];
        let lead_y = vect[pi].1 * inv_len[pi];
        match main {
            0 => {
                base_a = lead_x;
                base_b = lead_y;
            }
            1 => {
                base_a = lead_y;
                base_b = -lead_x;
            }
            2 => {
                base_a = -lead_x;
                base_b = -lead_y;
            }
            _ => {
                base_a = -lead_y;
                base_b = lead_x;
            }
        }
        seq[main] = (seq[main] + 1) % n;

        let dx = p[seq[1]].0 - p[seq[3]].0;
        let dy = p[seq[1]].1 - p[seq[3]].1;
        let width = dx * base_a + dy * base_b;
        let dx = p[seq[2]].0 - p[seq[0]].0;
        let dy = p[seq[2]].1 - p[seq[0]].1;
        let height = -dx * base_b + dy * base_a;
        let area = width * height;
        if area < minarea {
            minarea = area;
            best = (seq[3], base_a, width, base_b, height, seq[0]);
        }
    }

    let (i3, a1, w, b1, h, i0) = best;
    let a2 = -b1;
    let b2 = a1;
    let c1 = a1 * p[i3].0 + p[i3].1 * b1;
    let c2 = a2 * p[i0].0 + p[i0].1 * b2;
    let idet = 1.0 / (a1 * b2 - a2 * b1);
    let px = (c1 * b2 - c2 * b1) * idet;
    let py = (a1 * c2 - a2 * c1) * idet;
    let (o1x, o1y) = (a1 * w, b1 * w);
    let (o2x, o2y) = (a2 * h, b2 * h);
    RotRect {
        cx: px + (o1x + o2x) * 0.5,
        cy: py + (o1y + o2y) * 0.5,
        w: ((o1x as f64 * o1x as f64 + o1y as f64 * o1y as f64).sqrt()) as f32,
        h: ((o2x as f64 * o2x as f64 + o2y as f64 * o2y as f64).sqrt()) as f32,
        angle: ((o1y as f64).atan2(o1x as f64) * 180.0 / std::f64::consts::PI) as f32,
    }
}

/// Four rectangle corners in OpenCV `boxPoints` order.
pub fn box_points(r: &RotRect) -> [(f32, f32); 4] {
    let rad = r.angle as f64 * std::f64::consts::PI / 180.0;
    let a = (rad.sin() * 0.5) as f32;
    let b = (rad.cos() * 0.5) as f32;
    let p0 = (r.cx - a * r.h - b * r.w, r.cy + b * r.h - a * r.w);
    let p1 = (r.cx + a * r.h - b * r.w, r.cy - b * r.h - a * r.w);
    [p0, p1, (2.0 * r.cx - p0.0, 2.0 * r.cy - p0.1), (2.0 * r.cx - p1.0, 2.0 * r.cy - p1.1)]
}

/// Minimum-area rectangle ordered [TL, TR, BR, BL] and its short side length.
pub fn mini_box(points: &[(f32, f32)]) -> ([(f32, f32); 4], f32) {
    let rect = min_area_rect(points);
    let mut pts = box_points(&rect);
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (i1, i4) = if pts[1].1 > pts[0].1 { (0, 1) } else { (1, 0) };
    let (i2, i3) = if pts[3].1 > pts[2].1 { (2, 3) } else { (3, 2) };
    ([pts[i1], pts[i2], pts[i3], pts[i4]], rect.short_side())
}

/// Half-away-from-zero integer rounding matching Clipper.
fn clip_round(v: f64) -> i64 {
    if v < 0.0 { (v - 0.5) as i64 } else { (v + 0.5) as i64 }
}

/// Signed polygon area for winding check.
fn clipper_area(poly: &[(i64, i64)]) -> f64 {
    if poly.len() < 3 {
        return 0.0;
    }
    let mut a = 0f64;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        a += (poly[j].0 + poly[i].0) as f64 * (poly[j].1 - poly[i].1) as f64;
        j = i;
    }
    -a * 0.5
}

/// Polygon expansion matching `pyclipper.PyclipperOffset(JT_ROUND, ET_CLOSEDPOLYGON)`.
pub fn offset_round(path: &[(f64, f64)], delta: f64) -> Vec<(f64, f64)> {
    const DEF_ARC_TOLERANCE: f64 = 0.25;
    let raw: Vec<(i64, i64)> = path.iter().map(|&(x, y)| (x as i64, y as i64)).collect();
    if raw.is_empty() {
        return Vec::new();
    }
    // Clipper's AddPath strips the closing duplicate and any consecutive repeats.
    let mut high = raw.len() - 1;
    while high > 0 && raw[0] == raw[high] {
        high -= 1;
    }
    let mut contour: Vec<(i64, i64)> = vec![raw[0]];
    for &p in &raw[1..=high] {
        if *contour.last().unwrap() != p {
            contour.push(p);
        }
    }
    while contour.len() > 1 && contour[contour.len() - 1] == contour[0] {
        contour.pop();
    }
    if contour.len() < 3 {
        return Vec::new();
    }
    if clipper_area(&contour) < 0.0 {
        contour.reverse();
    }
    if delta.abs() < 1e-20 {
        return contour.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
    }

    let y = if DEF_ARC_TOLERANCE > delta.abs() * DEF_ARC_TOLERANCE {
        delta.abs() * DEF_ARC_TOLERANCE
    } else {
        DEF_ARC_TOLERANCE
    };
    let steps = std::f64::consts::PI / (1.0 - y / delta.abs()).acos();
    let two_pi = 2.0 * std::f64::consts::PI;
    let m_sin = if delta < 0.0 { -(two_pi / steps).sin() } else { (two_pi / steps).sin() };
    let m_cos = (two_pi / steps).cos();
    let steps_per_rad = steps / two_pi;

    let n = contour.len();
    let normals: Vec<(f64, f64)> = (0..n)
        .map(|j| {
            let p1 = contour[j];
            let p2 = contour[(j + 1) % n];
            let dx = (p2.0 - p1.0) as f64;
            let dy = (p2.1 - p1.1) as f64;
            if dx == 0.0 && dy == 0.0 {
                (0.0, 0.0)
            } else {
                let f = 1.0 / (dx * dx + dy * dy).sqrt();
                (dy * f, -dx * f)
            }
        })
        .collect();

    let mut out: Vec<(i64, i64)> = Vec::new();
    let mut k = n - 1;
    let at = |c: (i64, i64), nrm: (f64, f64)| {
        (clip_round(c.0 as f64 + nrm.0 * delta), clip_round(c.1 as f64 + nrm.1 * delta))
    };
    for j in 0..n {
        let (nk, nj) = (normals[k], normals[j]);
        let mut sin_a = nk.0 * nj.1 - nj.0 * nk.1;
        if (sin_a * delta).abs() < 1.0 {
            let cos_a = nk.0 * nj.0 + nk.1 * nj.1;
            if cos_a > 0.0 {
                // Effectively a straight join: one point, no arc.
                out.push(at(contour[j], nk));
                k = j;
                continue;
            }
        } else {
            sin_a = sin_a.clamp(-1.0, 1.0);
        }
        if sin_a * delta < 0.0 {
            // Concave corner: the offset folds back through the source vertex.
            out.push(at(contour[j], nk));
            out.push(contour[j]);
            out.push(at(contour[j], nj));
        } else {
            let a = sin_a.atan2(nk.0 * nj.0 + nk.1 * nj.1);
            let nsteps = clip_round(steps_per_rad * a.abs()).max(1);
            let (mut x, mut yv) = nk;
            for _ in 0..nsteps {
                out.push(at(contour[j], (x, yv)));
                let x2 = x;
                x = x * m_cos - m_sin * yv;
                yv = x2 * m_sin + yv * m_cos;
            }
            out.push(at(contour[j], nj));
        }
        k = j;
    }
    out.into_iter().map(|(x, y)| (x as f64, y as f64)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quad(x1: f32, y1: f32, x2: f32, y2: f32) -> Vec<(f32, f32)> {
        vec![(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    }

    #[test]
    fn min_area_rect_of_an_axis_aligned_box_is_that_box() {
        let r = min_area_rect(&quad(10.0, 20.0, 40.0, 80.0));
        assert!((r.cx - 25.0).abs() < 1e-4 && (r.cy - 50.0).abs() < 1e-4);
        let (a, b) = (r.w.min(r.h), r.w.max(r.h));
        assert!((a - 30.0).abs() < 1e-3 && (b - 60.0).abs() < 1e-3, "{r:?}");
    }

    #[test]
    fn min_area_rect_of_a_rotated_square_recovers_its_side() {
        // A square rotated 45 degrees: the minimum-area rectangle is the square
        // itself, not its axis-aligned bounding box (which is twice the area).
        let pts = vec![(0.0f32, 10.0f32), (10.0, 0.0), (20.0, 10.0), (10.0, 20.0)];
        let r = min_area_rect(&pts);
        let side = (200.0f32).sqrt();
        assert!((r.w - side).abs() < 1e-2 && (r.h - side).abs() < 1e-2, "{r:?}");
    }

    #[test]
    fn min_area_rect_ignores_points_inside_the_hull() {
        let mut pts = quad(0.0, 0.0, 100.0, 50.0);
        pts.push((50.0, 25.0));
        pts.push((10.0, 40.0));
        let r = min_area_rect(&pts);
        assert!((r.w.max(r.h) - 100.0).abs() < 1e-3 && (r.w.min(r.h) - 50.0).abs() < 1e-3);
    }

    #[test]
    fn min_area_rect_degenerates_gracefully() {
        // A single point and a bare segment both appear in real contour output;
        // DBNet drops them on the short side, so what matters is that the short
        // side comes back as zero rather than as a panic.
        assert_eq!(min_area_rect(&[(5.0, 5.0)]).short_side(), 0.0);
        assert_eq!(min_area_rect(&[(0.0, 0.0), (0.0, 9.0)]).short_side(), 0.0);
        assert_eq!(min_area_rect(&[]).short_side(), 0.0);
    }

    #[test]
    fn box_points_round_trips_through_min_area_rect() {
        let pts = vec![(3.0f32, 7.0f32), (40.0, 12.0), (44.0, 30.0), (7.0, 25.0)];
        let r = min_area_rect(&pts);
        let bp = box_points(&r);
        let r2 = min_area_rect(&bp);
        assert!((r2.w.max(r2.h) - r.w.max(r.h)).abs() < 1e-2);
        assert!((r2.w.min(r2.h) - r.w.min(r.h)).abs() < 1e-2);
    }

    #[test]
    fn mini_box_orders_corners_clockwise_from_top_left() {
        let (b, sside) = mini_box(&quad(10.0, 20.0, 40.0, 80.0));
        assert!((sside - 30.0).abs() < 1e-3);
        assert_eq!(b[0], (10.0, 20.0));
        assert_eq!(b[1], (40.0, 20.0));
        assert_eq!(b[2], (40.0, 80.0));
        assert_eq!(b[3], (10.0, 80.0));
    }

    #[test]
    fn offset_grows_an_axis_aligned_rectangle_by_the_distance() {
        // The reference case: a 7x91 quad, DBNet's unclip distance, and the
        // exact quad the Python pipeline produced for it on a real page.
        let quad = [(121.0, 827.0), (128.0, 827.0), (128.0, 918.0), (121.0, 918.0)];
        let (w, h) = (7.0f64, 91.0f64);
        let d = w * h * 1.5 / (2.0 * (w + h));
        let expanded = offset_round(&quad, d);
        let pts: Vec<(f32, f32)> = expanded.iter().map(|&(x, y)| (x as f32, y as f32)).collect();
        let (b, _) = mini_box(&pts);
        assert_eq!(b[0].0.round(), 116.0);
        assert_eq!(b[0].1.round(), 822.0);
        assert_eq!(b[2].0.round(), 133.0);
        assert_eq!(b[2].1.round(), 923.0);
    }

    #[test]
    fn offset_by_zero_returns_the_path() {
        let out = offset_round(&[(0.0, 0.0), (10.0, 0.0), (10.0, 5.0), (0.0, 5.0)], 0.0);
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn offset_rejects_a_path_that_collapses_to_a_line() {
        // Truncation to integers can flatten a very thin quad; Clipper drops
        // such a path rather than offsetting it, and so must this.
        assert!(offset_round(&[(0.2, 0.2), (0.7, 0.3), (0.9, 0.4)], 3.0).is_empty());
    }

    #[test]
    fn offset_encloses_the_source_and_grows_with_the_distance() {
        let src = [(20.0, 20.0), (60.0, 20.0), (60.0, 50.0), (20.0, 50.0)];
        let small: Vec<(f32, f32)> =
            offset_round(&src, 3.0).iter().map(|&(x, y)| (x as f32, y as f32)).collect();
        let big: Vec<(f32, f32)> =
            offset_round(&src, 9.0).iter().map(|&(x, y)| (x as f32, y as f32)).collect();
        let (sb, _) = mini_box(&small);
        let (bb, _) = mini_box(&big);
        assert!(sb[0].0 < 20.0 && sb[2].0 > 60.0);
        assert!(bb[0].0 < sb[0].0 && bb[2].0 > sb[2].0);
    }
}
