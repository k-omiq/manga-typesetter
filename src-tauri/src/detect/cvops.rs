//! Bit-for-bit OpenCV raster operations for text detector post-processing.
//!
//! Re-implements OpenCV's fixed-point linear resize, Suzuki-Abe border following (`findContours`),
//! Bresenham scanline polygon fill (`fillPoly`), and contour mean scoring (`box_score_fast`).

/// `cv2.resize(..., INTER_LINEAR)` for 8-bit images using OpenCV's 11-bit fixed-point arithmetic.
pub fn resize_linear_u8(src: &[u8], sw: usize, sh: usize, cn: usize, dw: usize, dh: usize) -> Vec<u8> {
    assert_eq!(src.len(), sw * sh * cn);
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    let (xo, xa) = axis_taps(dw, sw);
    let (yo, ya) = axis_taps(dh, sh);

    // Shared horizontal row cache (up to two destination rows).
    let hrow = |sy: usize, out: &mut Vec<i64>| {
        let s = &src[sy * sw * cn..(sy + 1) * sw * cn];
        for d in 0..dw {
            let sx = xo[d];
            let (a0, a1) = xa[d];
            for k in 0..cn {
                let left = s[sx * cn + k] as i64;
                let right = if sx + 1 < sw { s[(sx + 1) * cn + k] as i64 } else { 0 };
                out[d * cn + k] = left * a0 + right * a1;
            }
        }
    };

    let mut buf0 = vec![0i64; dw * cn];
    let mut buf1 = vec![0i64; dw * cn];
    let mut cached: (Option<usize>, Option<usize>) = (None, None);
    let mut dst = vec![0u8; dw * dh * cn];

    for d in 0..dh {
        let sy = yo[d];
        let (b0, b1) = ya[d];
        let sy1 = (sy + 1).min(sh - 1);
        if cached.0 != Some(sy) {
            hrow(sy, &mut buf0);
            cached.0 = Some(sy);
        }
        if cached.1 != Some(sy1) {
            hrow(sy1, &mut buf1);
            cached.1 = Some(sy1);
        }
        let row = &mut dst[d * dw * cn..(d + 1) * dw * cn];
        for i in 0..dw * cn {
            let v = (((b0 * (buf0[i] >> 4)) >> 16) + ((b1 * (buf1[i] >> 4)) >> 16) + 2) >> 2;
            row[i] = v.clamp(0, 255) as u8;
        }
    }
    dst
}

/// Computes source indices and 11-bit tap weights for pixel centres: `(d + 0.5) * scale - 0.5`.
fn axis_taps(dsize: usize, ssize: usize) -> (Vec<usize>, Vec<(i64, i64)>) {
    const COEF_SCALE: f32 = 2048.0;
    let scale = ssize as f64 / dsize as f64;
    let mut ofs = Vec::with_capacity(dsize);
    let mut taps = Vec::with_capacity(dsize);
    for d in 0..dsize {
        let f = ((d as f64 + 0.5) * scale - 0.5) as f32;
        let mut s = f.floor() as i64;
        let mut fr = f - s as f32;
        if s < 0 {
            fr = 0.0;
            s = 0;
        }
        if s >= ssize as i64 - 1 {
            fr = 0.0;
            s = ssize as i64 - 1;
        }
        ofs.push(s as usize);
        taps.push((
            ((1.0 - fr) * COEF_SCALE).round() as i64,
            (fr * COEF_SCALE).round() as i64,
        ));
    }
    (ofs, taps)
}

/// One traced border, in image coordinates.
pub type Contour = Vec<(i32, i32)>;

/// `cv2.findContours(bitmap, RETR_LIST, CHAIN_APPROX_SIMPLE)` via Suzuki-Abe border following.
pub fn find_contours(bitmap: &[bool], w: usize, h: usize) -> Vec<Contour> {
    // Direction index 0 is +x, counting counter-clockwise on screen (y down).
    const DX: [i32; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
    const DY: [i32; 8] = [0, -1, -1, -1, 0, 1, 1, 1];
    const NBD: i16 = 2;
    const MARK: i16 = -126; // (schar)(NBD | -128)

    // Pad by 1 to bound edge-touching foreground by background.
    let (bw, bh) = (w + 2, h + 2);
    let mut f = vec![0i16; bw * bh];
    for y in 0..h {
        for x in 0..w {
            if bitmap[y * w + x] {
                f[(y + 1) * bw + (x + 1)] = 1;
            }
        }
    }

    // 16 flat neighbour offsets.
    let mut deltas = [0isize; 16];
    for i in 0..16 {
        deltas[i] = DX[i & 7] as isize + DY[i & 7] as isize * bw as isize;
    }

    let mut contours: Vec<Contour> = Vec::new();
    for y in 1..bh - 1 {
        for x in 1..bw - 1 {
            let p = f[y * bw + x];
            let prev = f[y * bw + x - 1];
            let is_hole = if prev == 0 && p == 1 {
                0usize
            } else if p == 0 && prev >= 1 {
                1usize
            } else {
                continue;
            };
            let i0 = y * bw + x - is_hole;
            let pts = fetch_contour(&mut f, bw, &deltas, i0, is_hole, NBD, MARK, &DX, &DY);
            contours.push(pts.into_iter().map(|(px, py)| (px - 1, py - 1)).collect());
        }
    }
    contours.reverse();
    contours
}

#[allow(clippy::too_many_arguments)]
fn fetch_contour(
    f: &mut [i16],
    bw: usize,
    deltas: &[isize; 16],
    i0: usize,
    is_hole: usize,
    nbd: i16,
    mark: i16,
    dx: &[i32; 8],
    dy: &[i32; 8],
) -> Vec<(i32, i32)> {
    let mut pt = ((i0 % bw) as i32, (i0 / bw) as i32);
    let s_end = if is_hole == 1 { 0usize } else { 4usize };
    let mut s = s_end;
    let i1;
    loop {
        s = (s + 7) & 7; // (s - 1) & 7
        let cand = (i0 as isize + deltas[s]) as usize;
        if f[cand] != 0 || s == s_end {
            i1 = cand;
            break;
        }
    }

    if s == s_end {
        // Isolated pixel.
        f[i0] = mark;
        return vec![pt];
    }

    let mut out = Vec::new();
    let mut i3 = i0;
    let mut i4 = i0;
    let mut prev_s = s ^ 4;
    loop {
        let s_start = s;
        while s < 15 {
            s += 1;
            i4 = (i3 as isize + deltas[s]) as usize;
            if f[i4] != 0 {
                break;
            }
        }
        s &= 7;

        // Right-bound check: true when right neighbour is background.
        if s >= 1 && s <= s_start {
            f[i3] = mark;
        } else if f[i3] == 1 {
            f[i3] = nbd;
        }

        // CHAIN_APPROX_SIMPLE: emit points only where the boundary turns.
        if s != prev_s {
            out.push(pt);
            prev_s = s;
        }
        pt.0 += dx[s];
        pt.1 += dy[s];

        if i4 == i0 && i3 == i1 {
            break;
        }
        i3 = i4;
        s = (s + 4) & 7;
    }
    out
}

/// Left-to-right Bresenham line drawer matching OpenCV's `LINE_8` / `LineIterator`.
fn line8(mask: &mut [u8], w: usize, h: usize, p0: (i32, i32), p1: (i32, i32)) {
    let (a, b) = if p1.0 < p0.0 { (p1, p0) } else { (p0, p1) };
    let mut dx = b.0 - a.0;
    let ystep = if b.1 >= a.1 { 1 } else { -1 };
    let mut dy = (b.1 - a.1).abs();
    let (maj, min) = if dy > dx {
        std::mem::swap(&mut dx, &mut dy);
        ((0, ystep), (1, 0))
    } else {
        ((1, 0), (0, ystep))
    };
    let mut err = dx - 2 * dy;
    let (mut x, mut y) = (a.0, a.1);
    for _ in 0..=dx {
        if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
            mask[y as usize * w + x as usize] = 1;
        }
        let neg = err < 0;
        err += -(2 * dy) + if neg { 2 * dx } else { 0 };
        x += maj.0 + if neg { min.0 } else { 0 };
        y += maj.1 + if neg { min.1 } else { 0 };
    }
}

const XY_SHIFT: i64 = 16;
const XY_ONE: i64 = 1 << XY_SHIFT;

/// `cv2.fillPoly` for one closed polygon (outline stroked with LINE_8, interior filled via scanline).
pub fn fill_poly(mask: &mut [u8], w: usize, h: usize, poly: &[(i32, i32)]) {
    if poly.is_empty() {
        return;
    }
    // (y0, y1, x at y0 in 16.16, dx per scanline in 16.16)
    let mut edges: Vec<(i32, i32, i64, i64)> = Vec::with_capacity(poly.len());
    let mut prev = poly[poly.len() - 1];
    for &cur in poly {
        line8(mask, w, h, prev, cur);
        if prev.1 != cur.1 {
            let xp = (prev.0 as i64) << XY_SHIFT;
            let xc = (cur.0 as i64) << XY_SHIFT;
            // Integer division truncating toward zero.
            let d = (xc - xp) / (cur.1 - prev.1) as i64;
            if prev.1 < cur.1 {
                edges.push((prev.1, cur.1, xp, d));
            } else {
                edges.push((cur.1, prev.1, xc, d));
            }
        }
        prev = cur;
    }
    if edges.len() < 2 {
        return;
    }
    let y_min = edges.iter().map(|e| e.0).min().unwrap();
    let y_max = edges.iter().map(|e| e.1).max().unwrap().min(h as i32);
    let mut xs: Vec<i64> = Vec::with_capacity(edges.len());
    for y in y_min.max(0)..y_max {
        xs.clear();
        for e in &edges {
            if e.0 <= y && y < e.1 {
                xs.push(e.2 + (y - e.0) as i64 * e.3);
            }
        }
        xs.sort_unstable();
        for pair in xs.chunks_exact(2) {
            let x1 = (pair[0] + XY_ONE - 1) >> XY_SHIFT;
            let x2 = pair[1] >> XY_SHIFT;
            if x1 < w as i64 && x2 >= 0 {
                let x1 = x1.max(0) as usize;
                let x2 = (x2.min(w as i64 - 1)) as usize;
                let row = y as usize * w;
                for x in x1..=x2 {
                    mask[row + x] = 1;
                }
            }
        }
    }
}

/// Computes the mean probability of `pred` over the pixels enclosed by `contour`.
pub fn box_score_fast(pred: &[f32], pw: usize, ph: usize, contour: &[(i32, i32)]) -> f32 {
    if contour.is_empty() {
        return 0.0;
    }
    let clamp = |v: i32, hi: i32| v.clamp(0, hi);
    let xmin = clamp(contour.iter().map(|p| p.0).min().unwrap(), pw as i32 - 1);
    let xmax = clamp(contour.iter().map(|p| p.0).max().unwrap(), pw as i32 - 1);
    let ymin = clamp(contour.iter().map(|p| p.1).min().unwrap(), ph as i32 - 1);
    let ymax = clamp(contour.iter().map(|p| p.1).max().unwrap(), ph as i32 - 1);
    let w = (xmax - xmin + 1) as usize;
    let h = (ymax - ymin + 1) as usize;
    let mut mask = vec![0u8; w * h];
    let shifted: Vec<(i32, i32)> = contour.iter().map(|p| (p.0 - xmin, p.1 - ymin)).collect();
    fill_poly(&mut mask, w, h, &shifted);

    let mut total = 0f64;
    let mut count = 0usize;
    for j in 0..h {
        for i in 0..w {
            if mask[j * w + i] != 0 {
                total += pred[(ymin as usize + j) * pw + (xmin as usize + i)] as f64;
                count += 1;
            }
        }
    }
    if count == 0 { 0.0 } else { (total / count as f64) as f32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bm(rows: &[&str]) -> (Vec<bool>, usize, usize) {
        let h = rows.len();
        let w = rows[0].len();
        let mut v = Vec::with_capacity(w * h);
        for r in rows {
            for c in r.chars() {
                v.push(c == '#');
            }
        }
        (v, w, h)
    }

    #[test]
    fn resize_of_the_same_size_is_the_identity() {
        let src: Vec<u8> = (0..64).map(|i| (i * 3) as u8).collect();
        assert_eq!(resize_linear_u8(&src, 8, 8, 1, 8, 8), src);
    }

    #[test]
    fn resize_of_a_flat_image_stays_flat() {
        // Any weighted average of one value is that value. This catches a tap
        // pair that does not sum to 2048, which would darken or brighten the
        // whole image by a fraction of a count.
        let src = vec![200u8; 40 * 30];
        for (dw, dh) in [(17usize, 91usize), (91, 17), (40, 30)] {
            let out = resize_linear_u8(&src, 40, 30, 1, dw, dh);
            assert!(out.iter().all(|&v| v == 200), "{dw}x{dh}");
        }
    }

    #[test]
    fn resize_keeps_channels_independent() {
        // Interleaving mistakes are the classic bug here and they look like a
        // colour shift, which is invisible on a greyscale manga page until the
        // model sees it.
        let mut src = vec![0u8; 4 * 4 * 3];
        for i in 0..16 {
            src[i * 3] = 250;
            src[i * 3 + 2] = 10;
        }
        let out = resize_linear_u8(&src, 4, 4, 3, 8, 8);
        for i in 0..64 {
            assert_eq!(out[i * 3], 250);
            assert_eq!(out[i * 3 + 1], 0);
            assert_eq!(out[i * 3 + 2], 10);
        }
    }

    #[test]
    fn resize_upscale_interpolates_a_two_pixel_ramp() {
        // 2 -> 4 samples at 0.25/0.75 of the way across, which with pixel-centre
        // sampling clamps the outer two and blends the inner two.
        let out = resize_linear_u8(&[0u8, 100], 2, 1, 1, 4, 1);
        assert_eq!(out, vec![0, 25, 75, 100]);
    }

    #[test]
    fn find_contours_traces_a_single_rectangle() {
        let (b, w, h) = bm(&["......", ".####.", ".####.", ".####.", "......"]);
        let cs = find_contours(&b, w, h);
        assert_eq!(cs.len(), 1);
        // CHAIN_APPROX_SIMPLE keeps only the four corners.
        assert_eq!(cs[0], vec![(1, 1), (1, 3), (4, 3), (4, 1)]);
    }

    #[test]
    fn find_contours_finds_a_hole_as_its_own_border() {
        // RETR_LIST returns holes too, ensuring hole borders are properly detected.
        let (b, w, h) = bm(&[
            ".......",
            ".#####.",
            ".#...#.",
            ".#...#.",
            ".#####.",
            ".......",
        ]);
        let cs = find_contours(&b, w, h);
        assert_eq!(cs.len(), 2, "outer + hole, got {cs:?}");
    }

    #[test]
    fn find_contours_separates_two_blobs_and_handles_a_lone_pixel() {
        let (b, w, h) = bm(&["#.....", "......", "..##..", "..##..", "......"]);
        let cs = find_contours(&b, w, h);
        assert_eq!(cs.len(), 2);
        assert!(cs.iter().any(|c| c == &vec![(0, 0)]));
    }

    #[test]
    fn find_contours_reaches_foreground_on_the_image_border() {
        // The pad-by-one is what makes this work; without it the tracer would
        // read outside the buffer or silently drop the blob.
        let (b, w, h) = bm(&["##", "##"]);
        let cs = find_contours(&b, w, h);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0], vec![(0, 0), (0, 1), (1, 1), (1, 0)]);
    }

    #[test]
    // The 1*8+1 index is row*stride+col spelled out; clearer than the bare sum.
    #[allow(clippy::identity_op)]
    fn fill_poly_fills_a_rectangle_inclusive_of_its_border() {
        let mut m = vec![0u8; 8 * 8];
        fill_poly(&mut m, 8, 8, &[(1, 1), (6, 1), (6, 6), (1, 6)]);
        assert_eq!(m.iter().filter(|&&v| v == 1).count(), 6 * 6);
        assert_eq!(m[1 * 8 + 1], 1);
        assert_eq!(m[6 * 8 + 6], 1);
        assert_eq!(m[0], 0);
    }

    #[test]
    fn fill_poly_fills_a_triangle_the_way_opencv_does() {
        // Captured from cv2.fillPoly on the same polygon. The interesting part
        // is the boundary: a pure scanline fill loses the leftmost pixel of the
        // second row.
        let mut m = vec![0u8; 9 * 9];
        fill_poly(&mut m, 9, 9, &[(1, 1), (7, 3), (4, 7)]);
        let expect = [
            "000000000", "011000000", "011111000", "001111110", "001111100", "000111000",
            "000111000", "000010000", "000000000",
        ];
        for (y, row) in expect.iter().enumerate() {
            let got: String = (0..9).map(|x| if m[y * 9 + x] == 1 { '1' } else { '0' }).collect();
            assert_eq!(&got, row, "row {y}");
        }
    }

    #[test]
    fn box_score_averages_only_the_pixels_inside_the_contour() {
        // A 4x4 square of 1.0 inside an otherwise 0.0 map. Scoring the bounding
        // box instead of the polygon, or forgetting to offset into the crop,
        // both show up as a score well under 1.
        let (pw, ph) = (10usize, 10usize);
        let mut pred = vec![0f32; pw * ph];
        for y in 3..7 {
            for x in 3..7 {
                pred[y * pw + x] = 1.0;
            }
        }
        let s = box_score_fast(&pred, pw, ph, &[(3, 3), (3, 6), (6, 6), (6, 3)]);
        assert!((s - 1.0).abs() < 1e-6, "{s}");
    }

    #[test]
    fn box_score_of_a_contour_over_empty_map_is_zero() {
        let pred = vec![0f32; 100];
        assert_eq!(box_score_fast(&pred, 10, 10, &[(1, 1), (1, 4), (4, 4), (4, 1)]), 0.0);
    }
}
