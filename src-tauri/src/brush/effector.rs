//! The `Effector` blobs: the size dynamics a `.sut` brush was authored with.
//!
//! Every dynamic setting in the `Variant` table is a pair: a plain column with
//! the value (`BrushSize`), and a BLOB column with the dynamics that modulate
//! it (`BrushSizeEffector`). The blobs were the last undecoded part of the
//! format; `docs/superpowers/specs/effector-format.md` is the findings doc this
//! module implements, including the evidence for every field and the confidence
//! it carries.
//!
//! The layout, which parses all 1351 blobs in the 64-file corpus:
//!
//! ```text
//! 0    u32   44, the header length
//! 4    i32   sources this parameter offers      (0x0F0 or 0x1F0)
//! 8    i32   sources switched on                (a subset of the above)
//! 12   i32   minimum value, pen pressure, %
//! 16   i32   minimum value, tilt, %
//! 20   i32   minimum value, velocity, %
//! 24   i32   minimum value, random, %           (-100 on signed parameters)
//! 28   i32   minimum value, the fifth source, % (0 in every corpus blob)
//! 32   i32   byte length of the pen pressure graph, 0 when absent
//! 36   i32   byte length of the velocity graph, 0 when absent
//! 40   i32   100 or 500, undecoded
//! 44   ..    the graphs, back to back
//! ```
//!
//! A graph is Celsys's ordinary array record - `u32` header length (12), `u32`
//! element count, `u32` element size (16) - over control points stored as two
//! big-endian `f64`, input then output, both 0 to 1. The same record shape is
//! what `VariantShowParam` and `BrushInOutTarget` use with other element sizes.
//!
//! Two self-checks make a wrong reading loud rather than plausible, and both
//! hold on every corpus blob: `44 + pressure_len + velocity_len` is exactly the
//! blob length, and the switched-on mask is a subset of the offered mask. A
//! blob that fails either is [`None`] rather than a guess.

use serde::Serialize;

/// The header, and the offset the graphs begin at.
const HEADER_LEN: usize = 44;

/// A graph's own record header: length, count, element size.
const RECORD_HEADER_LEN: u32 = 12;

/// Bytes per control point: two big-endian `f64`.
const POINT_LEN: u32 = 16;

/// A graph with more nodes than this is damage, not a curve. CSP's editor
/// offers a handful; the corpus tops out at 14.
const MAX_POINTS: u32 = 1024;

/// What drives a dynamic setting. The bit values are the ones in the mask at
/// offset 8, and their order is the order CSP's Dynamics dialog lists them in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Pressure,
    Tilt,
    Velocity,
    Random,
}

impl Source {
    /// The mask bit this source occupies.
    pub const fn bit(self) -> u32 {
        match self {
            Source::Pressure => 0x10,
            Source::Tilt => 0x20,
            Source::Velocity => 0x40,
            Source::Random => 0x80,
        }
    }

    /// The four sources, in the order CSP lists them, which is also the order
    /// their minimum-value words sit in the header.
    pub const ALL: [Source; 4] =
        [Source::Pressure, Source::Tilt, Source::Velocity, Source::Random];
}

/// One brush parameter's dynamics.
///
/// The minimums are percentages and are kept for every source, switched on or
/// not, because that is how the file stores them: CSP keeps a source's slider
/// where the author left it after they switch the source off.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectorDynamics {
    /// The sources this parameter offers, as a raw mask.
    pub available: u32,
    /// The sources switched on, as a raw mask. Always a subset of
    /// [`available`](Self::available).
    pub enabled: u32,
    /// Minimum value per source, in percent, indexed by [`Source::ALL`].
    /// -100 to 100; negative only on the signed parameters (hue, saturation
    /// and value shift), where a random source swings both ways.
    pub minimums: [f32; 4],
    /// The pen pressure response graph, input then output, both 0 to 1.
    /// Absent when the file stores no graph, which means the straight line.
    pub pressure_curve: Option<Vec<[f32; 2]>>,
    /// The velocity response graph, in the same units.
    pub velocity_curve: Option<Vec<[f32; 2]>>,
    /// The word at offset 40, 100 or 500 across the whole corpus and never
    /// anything else. It is not decoded: it is 500 for every colour-shift and
    /// dual-brush parameter, and 100 for the rest, except in three `Variant`
    /// rows where every parameter reads 500 at once, which is a property of
    /// the row rather than of the parameter. Carried through so a later
    /// session has it without re-reading the corpus.
    pub trailer: i32,
}

impl EffectorDynamics {
    /// Whether a source is switched on.
    pub fn on(&self, source: Source) -> bool {
        self.enabled & source.bit() != 0
    }

    /// A source's minimum value, in percent.
    pub fn minimum(&self, source: Source) -> f32 {
        self.minimums[Self::index(source)]
    }

    /// A source's response graph, where it has one. Tilt and random carry no
    /// graph in the format: random has no input axis to plot, and no corpus
    /// file stores a tilt graph.
    pub fn curve(&self, source: Source) -> Option<&[[f32; 2]]> {
        match source {
            Source::Pressure => self.pressure_curve.as_deref(),
            Source::Velocity => self.velocity_curve.as_deref(),
            Source::Tilt | Source::Random => None,
        }
    }

    /// The one source to hand an engine that models a single driver, which is
    /// what `src/lib/brush.js` does with its `off`/`pressure`/`velocity`/
    /// `random` choice.
    ///
    /// A parameter may have several sources switched on at once - one corpus
    /// brush drives its size off three - so the precedence is fixed and stated
    /// here: pressure, then velocity, then random, which is the order of how
    /// much of the stroke's expression each carries. `None` when the parameter
    /// has no dynamics at all.
    ///
    /// Tilt is never returned, whether or not it is switched on: the engine
    /// has no tilt source to map it onto, and a pointer event the app can
    /// receive does not carry tilt. A tilt-only parameter therefore reads as
    /// `None` rather than as something the engine would silently mis-drive.
    /// No corpus file switches tilt on.
    pub fn primary(&self) -> Option<Source> {
        [Source::Pressure, Source::Velocity, Source::Random].into_iter().find(|s| self.on(*s))
    }

    fn index(source: Source) -> usize {
        match source {
            Source::Pressure => 0,
            Source::Tilt => 1,
            Source::Velocity => 2,
            Source::Random => 3,
        }
    }
}

/// One `Effector` blob, or `None` when the bytes are not the structure above.
///
/// Never panics and never allocates on a length the blob does not account for:
/// the two graph lengths are checked against the blob's own length before
/// either is read, so a truncated or corrupt blob is refused rather than
/// half-read.
pub fn decode_effector(blob: &[u8]) -> Option<EffectorDynamics> {
    if u32_at(blob, 0)? != HEADER_LEN as u32 {
        return None;
    }
    let w: Vec<i32> = (1..11).map(|i| i32_at(blob, i * 4)).collect::<Option<_>>()?;
    let available = w[0] as u32;
    let enabled = w[1] as u32;
    // The subset rule is the cheapest way to tell "this is the structure" from
    // "these bytes happened to start with 44".
    if enabled & !available != 0 {
        return None;
    }
    let mut minimums = [0f32; 4];
    for (i, m) in minimums.iter_mut().enumerate() {
        let v = w[2 + i];
        if !(-100..=100).contains(&v) {
            return None;
        }
        *m = v as f32;
    }
    // Offset 28 is the fifth source's minimum. It is 0 in every corpus blob and
    // has no source bit to go with it, so it is range-checked and dropped.
    if !(-100..=100).contains(&w[6]) {
        return None;
    }

    let pressure_len = usize::try_from(w[7]).ok()?;
    let velocity_len = usize::try_from(w[8]).ok()?;
    // The size identity: the header plus the two graphs is the whole blob. It
    // holds on all 1351 corpus blobs and is what makes a misread loud.
    if HEADER_LEN.checked_add(pressure_len)?.checked_add(velocity_len)? != blob.len() {
        return None;
    }
    // A velocity graph with no pressure graph before it is a layout the corpus
    // never uses - CSP wrote slot A whenever it wrote slot B - but nothing in
    // the container forbids it, and the size identity above already gates
    // where each slot starts, so it is read rather than refused.
    let pressure_curve = read_curve(blob, HEADER_LEN, pressure_len)?;
    let velocity_curve = read_curve(blob, HEADER_LEN + pressure_len, velocity_len)?;

    Some(EffectorDynamics {
        available,
        enabled,
        minimums,
        pressure_curve,
        velocity_curve,
        trailer: w[9],
    })
}

/// The graph in `len` bytes at `at`, `None` for a zero length, and the whole
/// decode fails when the bytes are there but are not a graph.
///
/// The outer `Option` is the failure and the inner one is the absence, so a
/// caller cannot confuse "no graph" with "unreadable graph".
fn read_curve(blob: &[u8], at: usize, len: usize) -> Option<Option<Vec<[f32; 2]>>> {
    if len == 0 {
        return Some(None);
    }
    let head = u32_at(blob, at)?;
    let count = u32_at(blob, at + 4)?;
    let point = u32_at(blob, at + 8)?;
    if head != RECORD_HEADER_LEN || point != POINT_LEN || !(2..=MAX_POINTS).contains(&count) {
        return None;
    }
    // The record must fill its slot exactly; a short one means the slot
    // lengths and the record disagree about where the next graph starts.
    if u64::from(head) + u64::from(count) * u64::from(point) != len as u64 {
        return None;
    }

    let mut pts = Vec::with_capacity(count as usize);
    let mut prev = f64::NEG_INFINITY;
    for i in 0..count as usize {
        let o = at + RECORD_HEADER_LEN as usize + i * POINT_LEN as usize;
        let x = f64_at(blob, o)?;
        let y = f64_at(blob, o + 8)?;
        // Both axes are normalised in the format. Out of range is a misread,
        // not a brush, so it fails rather than clamping into plausibility.
        if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
            return None;
        }
        if x < prev {
            return None;
        }
        prev = x;
        pts.push([x as f32, y as f32]);
    }
    Some(Some(pts))
}

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(o..o + 4)?.try_into().ok()?))
}

fn i32_at(b: &[u8], o: usize) -> Option<i32> {
    u32_at(b, o).map(|v| v as i32)
}

/// A big-endian `f64`, refused when it is NaN or infinite: either would pass
/// every range check below it and then poison whatever the engine did with it.
fn f64_at(b: &[u8], o: usize) -> Option<f64> {
    let v = f64::from_be_bytes(b.get(o..o + 8)?.try_into().ok()?);
    v.is_finite().then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::sut::open_read_only;
    use std::path::{Path, PathBuf};

    /// The 64 `.sut` files under `external/`, the import regression suite.
    fn corpus() -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sut")) {
                    out.push(p);
                }
            }
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../external");
        let mut out = Vec::new();
        walk(&root, &mut out);
        out.sort();
        out
    }

    /// Every `Effector` blob in one file, with the column it came from.
    fn blobs(path: &Path) -> Vec<(String, Vec<u8>)> {
        let Ok(con) = open_read_only(path) else { return Vec::new() };
        let Ok(mut cols) = con.prepare("select name from pragma_table_info('Variant')") else {
            return Vec::new();
        };
        let names: Vec<String> = cols
            .query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().filter(|n| n.ends_with("Effector")).collect())
            .unwrap_or_default();
        drop(cols);
        let mut out = Vec::new();
        for name in names {
            let Ok(mut stmt) = con.prepare(&format!("select \"{name}\" from Variant")) else {
                continue;
            };
            let Ok(rows) = stmt.query_map([], |r| r.get::<_, Option<Vec<u8>>>(0)) else { continue };
            for blob in rows.flatten().flatten() {
                out.push((name.clone(), blob));
            }
        }
        out
    }

    /// Every graph coordinate in a blob, read straight out of the bytes as
    /// `f64`, independently of the decoder. The grid check has to see the
    /// stored value: a coordinate rounded into an `f32` is off the grid by up
    /// to 7e-6 after scaling, which is enough slack to hide a wrong reading.
    fn raw_graph_values(blob: &[u8]) -> Vec<f64> {
        let word = |o: usize| -> usize {
            blob.get(o..o + 4)
                .and_then(|b| b.try_into().ok())
                .map_or(0, |b| u32::from_be_bytes(b) as usize)
        };
        let f64_at = |o: usize| -> f64 {
            blob.get(o..o + 8)
                .and_then(|b| b.try_into().ok())
                .map_or(f64::NAN, f64::from_be_bytes)
        };
        let mut out = Vec::new();
        let mut o = HEADER_LEN;
        while o + 12 <= blob.len() {
            let (head, count) = (word(o), word(o + 4));
            for i in 0..count {
                let p = o + head + i * 16;
                out.push(f64_at(p));
                out.push(f64_at(p + 8));
            }
            o += head + count * 16;
        }
        out
    }

    /// A minimal blob: the header words, then the graphs verbatim.
    fn blob(words: [i32; 10], graphs: &[&[(f64, f64)]]) -> Vec<u8> {
        let mut out = (HEADER_LEN as u32).to_be_bytes().to_vec();
        for w in words {
            out.extend_from_slice(&w.to_be_bytes());
        }
        for g in graphs {
            out.extend_from_slice(&RECORD_HEADER_LEN.to_be_bytes());
            out.extend_from_slice(&(g.len() as u32).to_be_bytes());
            out.extend_from_slice(&POINT_LEN.to_be_bytes());
            for (x, y) in *g {
                out.extend_from_slice(&x.to_be_bytes());
                out.extend_from_slice(&y.to_be_bytes());
            }
        }
        out
    }

    /// The lengths a two-graph blob has to declare for the size identity.
    fn lens(a: usize, b: usize) -> (i32, i32) {
        let n = |c: usize| if c == 0 { 0 } else { (12 + 16 * c) as i32 };
        (n(a), n(b))
    }

    #[test]
    fn every_corpus_effector_blob_decodes_and_is_in_range() {
        let files = corpus();
        assert_eq!(files.len(), 64, "the corpus is 64 .sut files under external/");

        let (mut decoded, mut skipped, mut with_curve, mut points) = (0, 0, 0, 0usize);
        let mut columns = std::collections::BTreeSet::new();
        let mut failed: Vec<String> = Vec::new();
        for path in &files {
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            for (column, bytes) in blobs(path) {
                columns.insert(column.clone());
                let Some(d) = decode_effector(&bytes) else {
                    skipped += 1;
                    failed.push(format!("{name}/{column} ({} bytes)", bytes.len()));
                    continue;
                };
                decoded += 1;
                assert_eq!(d.enabled & !d.available, 0, "{name}/{column}: a source not offered");
                for s in Source::ALL {
                    let m = d.minimum(s);
                    assert!((-100.0..=100.0).contains(&m), "{name}/{column}: minimum {m}");
                }
                let mut here = 0;
                for s in [Source::Pressure, Source::Velocity] {
                    let Some(c) = d.curve(s) else { continue };
                    with_curve += 1;
                    points += c.len();
                    here += c.len();
                    assert!(c.len() >= 2, "{name}/{column}: a graph of one node");
                    assert_eq!(c[0][0], 0.0, "{name}/{column}: a graph not starting at zero");
                    assert_eq!(c[c.len() - 1][0], 1.0, "{name}/{column}: a graph not ending at one");
                    for w in c.windows(2) {
                        assert!(w[0][0] < w[1][0], "{name}/{column}: x is not increasing");
                    }
                    for p in c {
                        assert!((0.0..=1.0).contains(&p[0]) && (0.0..=1.0).contains(&p[1]));
                    }
                }
                // CSP's graph editor is 110 units across, so every node it ever
                // wrote lands on an exact 110th. Nothing else about this
                // reading - the offset, the endianness, the width - survives
                // being wrong, so it is checked against the stored `f64` at
                // full precision rather than against the decoder's `f32`.
                let raw = raw_graph_values(&bytes);
                assert_eq!(raw.len(), here * 2, "{name}/{column}: the graphs do not fill the blob");
                for v in raw {
                    let k = v * 110.0;
                    assert!(
                        (k - k.round()).abs() < 1e-6,
                        "{name}/{column}: {v} is not a multiple of 1/110"
                    );
                }
            }
        }
        assert!(failed.is_empty(), "{skipped} blobs did not decode: {failed:?}");
        assert_eq!(decoded, 1351, "the corpus holds 1351 Effector blobs");
        assert_eq!(with_curve, 169, "and 169 response graphs across them");
        eprintln!(
            "effector corpus: {decoded} blobs decoded, {skipped} skipped, over {} columns; \
             {with_curve} graphs, {points} control points",
            columns.len()
        );
    }

    #[test]
    fn the_corpus_names_a_size_driver_for_every_brush_but_two() {
        let mut tally = std::collections::BTreeMap::new();
        for path in corpus() {
            for (column, bytes) in blobs(&path) {
                if column != "BrushSizeEffector" {
                    continue;
                }
                let d = decode_effector(&bytes).expect("every size effector decodes");
                *tally.entry(format!("{:?}", d.primary())).or_insert(0) += 1;
                // Whatever drives the size, its minimum is a percentage of it.
                for s in Source::ALL {
                    assert!((0.0..=100.0).contains(&d.minimum(s)), "size minimum out of range");
                }
            }
        }
        let total: i32 = tally.values().sum();
        assert_eq!(total, 70, "70 Variant rows in the corpus carry a size effector");
        assert_eq!(tally.get("Some(Pressure)"), Some(&67), "pressure drives 67 of them");
        assert_eq!(tally.get("Some(Velocity)"), Some(&1));
        assert_eq!(tally.get("None"), Some(&2), "two brushes have no size dynamics");
        eprintln!("effector size drivers: {tally:?}");
    }

    #[test]
    fn a_blob_that_is_not_one_is_refused_rather_than_read() {
        assert_eq!(decode_effector(&[]), None);
        assert_eq!(decode_effector(&[0; 43]), None, "shorter than the header");
        assert_eq!(decode_effector(&[0; 44]), None, "44 zeros do not declare a 44 header");
        // A blob whose first word is right but whose length is not accounted
        // for by the two graph slots.
        let mut b = blob([496, 0x10, 0, 0, 0, 0, 0, 0, 0, 100], &[]);
        b.push(0);
        assert_eq!(decode_effector(&b), None, "a trailing byte no slot claims");
        // A source switched on that the parameter does not offer.
        assert_eq!(decode_effector(&blob([0xF0, 0x100, 0, 0, 0, 0, 0, 0, 0, 100], &[])), None);
        // A minimum outside the percent range.
        assert_eq!(decode_effector(&blob([496, 0x10, 101, 0, 0, 0, 0, 0, 0, 100], &[])), None);
        assert_eq!(decode_effector(&blob([496, 0x10, 0, 0, 0, -101, 0, 0, 0, 100], &[])), None);
    }

    #[test]
    fn the_header_and_the_graphs_are_read_the_way_the_corpus_stores_them() {
        let pressure = [(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)];
        let velocity = [(0.0, 0.0), (0.5, 1.0), (0.8, 1.0), (1.0, 0.5)];
        let (a, b) = lens(pressure.len(), velocity.len());
        let bytes =
            blob([496, 0x50, 40, 0, 70, 0, 0, a, b, 100], &[&pressure[..], &velocity[..]]);
        let d = decode_effector(&bytes).expect("the shape the corpus uses");
        assert!(d.on(Source::Pressure) && d.on(Source::Velocity));
        assert!(!d.on(Source::Tilt) && !d.on(Source::Random));
        assert_eq!(d.minimum(Source::Pressure), 40.0);
        assert_eq!(d.minimum(Source::Velocity), 70.0);
        assert_eq!(d.primary(), Some(Source::Pressure));
        assert_eq!(d.curve(Source::Pressure).map(<[_]>::len), Some(3));
        assert_eq!(d.curve(Source::Velocity).map(<[_]>::len), Some(4));
        assert_eq!(d.curve(Source::Tilt), None, "tilt carries no graph in the format");
        assert_eq!(d.curve(Source::Random), None);
        assert_eq!(d.trailer, 100);
        // Random alone is still a driver, and the only one that reads negative.
        let r = decode_effector(&blob([240, 0x80, 0, 100, 0, -100, 0, 0, 0, 500], &[]))
            .expect("the hue, saturation and value shape");
        assert_eq!(r.primary(), Some(Source::Random));
        assert_eq!(r.minimum(Source::Random), -100.0);
        assert_eq!(r.pressure_curve, None);
        // Tilt is never the primary source: the engine has no tilt to drive.
        let t = decode_effector(&blob([496, 0x20, 0, 40, 0, 0, 0, 0, 0, 100], &[]))
            .expect("a tilt-driven parameter still decodes");
        assert!(t.on(Source::Tilt));
        assert_eq!(t.primary(), None, "tilt is read but never handed to the engine");
    }

    #[test]
    fn a_velocity_graph_with_no_pressure_graph_is_read_rather_than_refused() {
        // The corpus never stores this - CSP wrote slot A whenever it wrote
        // slot B - but nothing in the container forbids it, and the size
        // identity still says where the one graph starts.
        let velocity = [(0.0, 0.0), (0.5, 1.0), (1.0, 0.5)];
        let (_, b) = lens(0, velocity.len());
        let d = decode_effector(&blob([496, 0x40, 0, 0, 60, 0, 0, 0, b, 100], &[&velocity[..]]))
            .expect("slot B alone is a layout, not damage");
        assert_eq!(d.pressure_curve, None);
        assert_eq!(d.curve(Source::Velocity).map(<[_]>::len), Some(3));
        assert_eq!(d.primary(), Some(Source::Velocity));
        assert_eq!(d.minimum(Source::Velocity), 60.0);
    }

    #[test]
    fn a_graph_that_does_not_hold_together_fails_the_whole_blob() {
        let good = [(0.0, 0.0), (1.0, 1.0)];
        let (a, _) = lens(good.len(), 0);
        // A slot length that does not match the record inside it.
        let mut bytes = blob([496, 0x10, 0, 0, 0, 0, 0, a + 16, 0, 100], &[&good[..]]);
        bytes.extend_from_slice(&[0; 16]);
        assert_eq!(decode_effector(&bytes), None, "a slot longer than its record");
        // A control point outside 0..1.
        let out = [(0.0, 0.0), (1.0, 1.5)];
        assert_eq!(
            decode_effector(&blob([496, 0x10, 0, 0, 0, 0, 0, a, 0, 100], &[&out[..]])),
            None
        );
        // x going backwards.
        let back = [(1.0, 0.0), (0.0, 1.0)];
        assert_eq!(
            decode_effector(&blob([496, 0x10, 0, 0, 0, 0, 0, a, 0, 100], &[&back[..]])),
            None
        );
        // A NaN, which would pass every range test that used a comparison.
        let nan = [(0.0, 0.0), (1.0, f64::NAN)];
        assert_eq!(
            decode_effector(&blob([496, 0x10, 0, 0, 0, 0, 0, a, 0, 100], &[&nan[..]])),
            None
        );
        // A node count the blob cannot hold, which must not be allocated for.
        let mut huge = blob([496, 0x10, 0, 0, 0, 0, 0, a, 0, 100], &[&good[..]]);
        huge[HEADER_LEN + 4..HEADER_LEN + 8].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(decode_effector(&huge), None);
    }
}
