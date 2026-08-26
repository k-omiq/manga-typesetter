//! The brush settings, read out of a `.sut`'s outer database.
//!
//! The 127 columns of the `Variant` table are Clip Studio's brush settings under
//! readable names, and the `Node` table carries the sub tool's name. Both are
//! plain SQLite in the outer file, so unlike the tip pixels they need no
//! archaeology - only normalising, because CSP's units are not ours.
//!
//! Two things make that less simple than a `select`:
//!
//! 1. Celsys adds and removes columns between versions, so a `select` naming a
//!    column the file does not have fails the *whole* read. Every column is
//!    looked up in `pragma table_info` first and every value is optional, with
//!    the JS engine's own default ([`BrushSettings::default`], which mirrors
//!    `defaultBrushSettings()` in `src/lib/brush.js`) standing in for anything
//!    missing.
//! 2. A `.sut` holds two `Variant` rows - the sub tool's current settings and
//!    the settings it was installed with. `Node.NodeVariantID` names the current
//!    one; in half the corpus the other row is entirely `NULL`.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

/// Millimetres are resolution-independent, so a length stored in them only
/// becomes pixels against a page resolution, and the file does not record one.
/// 600 dpi is Clip Studio's default for a monochrome manga document, which is
/// what every brush in the corpus was authored for, so it is what a millimetre
/// is converted at here. It is the one assumption in the whole table; a brush
/// that lands too large is one drag of the size slider away from right.
pub const CSP_DPI: f64 = 600.0;

/// `BrushSizeUnit` and its siblings: 0 is pixels, 2 is millimetres. No corpus
/// file uses any other code, and an unknown one is read as pixels because that
/// is the conversion that cannot make a value wrong by a factor of 23.
const UNIT_MM: i64 = 2;

/// The columns [`read`] asks for. Selecting these by name rather than `select *`
/// keeps the `Effector` blobs - which are variable-length binary this build does
/// not decode - out of the query entirely.
const WANTED: &[&str] = &[
    "VariantID",
    "Opacity",
    "AntiAlias",
    "BrushSize",
    "BrushSizeUnit",
    "BrushFlow",
    "BrushHardness",
    "BrushInterval",
    "BrushThickness",
    "BrushRotation",
    "BrushRotationRandomScale",
    "BrushUsePatternImage",
    "BrushUseRevision",
    "BrushRevision",
    "BrushUseIn",
    "BrushInLength",
    "BrushInLengthUnit",
    "BrushInRatio",
    "BrushUseOut",
    "BrushOutLength",
    "BrushOutLengthUnit",
    "BrushOutRatio",
    "BrushSharpenCorner",
    "BrushUseWaterEdge",
    "BrushWaterEdgeRadius",
    "BrushWaterEdgeRadiusUnit",
    "BrushWaterEdgeAlphaPower",
];

/// A taper: how far into the stroke it runs and how thin it gets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Taper {
    pub on: bool,
    /// Page px.
    pub len: f32,
    /// Percent of full width the end tapers away, 0-100.
    pub ratio: f32,
}

/// Corner preservation: vertices turning by more than `deg` are exempt from the
/// post-stroke smoothing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SharpAngles {
    pub on: bool,
    /// Degrees.
    pub deg: f32,
}

/// One imported brush's settings, in the units `src/lib/brush.js` expects.
///
/// Field for field this is the subset of `defaultBrushSettings()` a `.sut` can
/// answer for. What it cannot answer for - the size dynamics - lives in the
/// undecoded `Effector` blobs and is left to the JS default.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushSettings {
    /// Page px.
    pub size: f32,
    /// 0-1.
    pub opacity: f32,
    /// Percent of the tip's size between stamps.
    pub spacing: f32,
    /// 0 (fully soft) to 100 (hard edge).
    pub hardness: f32,
    /// Degrees, 0-360.
    pub angle: f32,
    /// Percent of a half turn of random rotation per stamp, 0-100.
    pub angle_jitter: f32,
    /// Tip squash across its short axis, 0-1, where 1 is unsquashed.
    pub flatness: f32,
    pub antialias: bool,
    pub taper_in: Taper,
    pub taper_out: Taper,
    pub water_edge: bool,
    /// Px, 1-20.
    pub water_edge_width: f32,
    /// 0-1.
    pub water_edge_power: f32,
    /// Stabilisation window, 0-100.
    pub stabilise: f32,
    pub sharp_angles: SharpAngles,
}

impl Default for BrushSettings {
    /// `defaultBrushSettings()` from `src/lib/brush.js`, so a column that is
    /// missing leaves the engine exactly where it would have been anyway.
    fn default() -> Self {
        BrushSettings {
            size: 24.0,
            opacity: 1.0,
            spacing: 10.0,
            hardness: 100.0,
            angle: 0.0,
            angle_jitter: 0.0,
            flatness: 1.0,
            antialias: true,
            taper_in: Taper { on: true, len: 20.0, ratio: 60.0 },
            taper_out: Taper { on: true, len: 20.0, ratio: 60.0 },
            water_edge: false,
            water_edge_width: 4.0,
            water_edge_power: 0.5,
            stabilise: 12.0,
            sharp_angles: SharpAngles { on: false, deg: 45.0 },
        }
    }
}

/// What the outer database says about a brush: its name, its settings, and
/// whether it has a tip image at all.
#[derive(Debug, Clone)]
pub struct BrushMeta {
    /// The sub tool name from `Node`, absent when the file has no usable one.
    pub name: Option<String>,
    pub settings: BrushSettings,
    /// `BrushUsePatternImage`. False means the brush draws with a generated
    /// round tip rather than a stored image, which is the one legitimate reason
    /// a file yields no pixels.
    pub has_pattern_image: bool,
}

/// One `Variant` row, as the numbers this module reads out of it.
///
/// Every wanted column is numeric in every file seen, and SQLite converts
/// integers to `f64` losslessly at this magnitude, so one map covers them all.
/// A column that holds something else is dropped rather than coerced.
struct Row(HashMap<&'static str, f64>);

impl Row {
    fn num(&self, key: &str) -> Option<f64> {
        self.0.get(key).copied()
    }

    fn int(&self, key: &str) -> Option<i64> {
        self.num(key).map(|v| v as i64)
    }

    /// A CSP flag column: present and non-zero.
    fn on(&self, key: &str) -> Option<bool> {
        self.num(key).map(|v| v != 0.0)
    }
}

/// The column names a table actually has.
fn table_columns(con: &Connection, table: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(mut stmt) = con.prepare("select name from pragma_table_info(?1)") else {
        return out;
    };
    let Ok(rows) = stmt.query_map([table], |r| r.get::<_, String>(0)) else {
        return out;
    };
    out.extend(rows.flatten());
    out
}

/// Every `Variant` row, restricted to the wanted columns the file has.
fn variant_rows(con: &Connection) -> Vec<Row> {
    let have = table_columns(con, "Variant");
    let cols: Vec<&'static str> = WANTED.iter().copied().filter(|c| have.contains(*c)).collect();
    if cols.is_empty() {
        return Vec::new();
    }
    // The names come from `WANTED`, never from the file, so the only thing the
    // quoting guards against is a future column name that needs it.
    let list = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(",");
    let Ok(mut stmt) = con.prepare(&format!("select {list} from Variant")) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        let mut m = HashMap::with_capacity(cols.len());
        for (i, c) in cols.iter().enumerate() {
            if let Ok(Some(v)) = r.get::<_, Option<f64>>(i) {
                m.insert(*c, v);
            }
        }
        Ok(Row(m))
    }) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

/// The sub tool's name and the id of the variant it is currently set to.
fn node(con: &Connection) -> (Option<String>, Option<i64>) {
    let have = table_columns(con, "Node");
    let name = have
        .contains("NodeName")
        .then(|| {
            con.query_row(
                "select NodeName from Node where NodeName is not null and NodeName <> '' limit 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
        .flatten()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty());
    let variant = have
        .contains("NodeVariantID")
        .then(|| {
            con.query_row(
                "select NodeVariantID from Node where NodeVariantID is not null limit 1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        })
        .flatten();
    (name, variant)
}

/// A CSP length in pixels. Unit 2 is millimetres; everything else is already px.
fn to_px(value: f64, unit: Option<i64>) -> f64 {
    if unit == Some(UNIT_MM) {
        value / 25.4 * CSP_DPI
    } else {
        value
    }
}

/// Everything the outer database can say about the brush in `con`.
///
/// Never fails: a file with no `Variant` table, or one whose columns are all
/// absent, comes back as the JS engine's own defaults.
pub fn read(con: &Connection) -> BrushMeta {
    let (name, current) = node(con);
    let rows = variant_rows(con);
    // The row `Node` points at, else the first row that has a brush size at all
    // (the installed-defaults row is often entirely NULL), else whatever exists.
    let row = current
        .and_then(|id| rows.iter().find(|r| r.int("VariantID") == Some(id)))
        .or_else(|| rows.iter().find(|r| r.num("BrushSize").is_some()))
        .or_else(|| rows.first());
    let Some(row) = row else {
        return BrushMeta { name, settings: BrushSettings::default(), has_pattern_image: true };
    };
    BrushMeta {
        name,
        settings: normalise(row),
        // Absent means the ordinary case: a brush with a stored tip image.
        has_pattern_image: row.on("BrushUsePatternImage").unwrap_or(true),
    }
}

/// One `Variant` row in the JS engine's units.
fn normalise(r: &Row) -> BrushSettings {
    let d = BrushSettings::default();

    // A length in whatever unit its sibling column names, capped so a corrupt
    // value cannot ask the engine for a stroke wider than any page.
    let len = |value: &str, unit: &str, hi: f64| -> Option<f32> {
        r.num(value).map(|v| to_px(v, r.int(unit)).clamp(0.0, hi) as f32)
    };
    // A CSP percent column, which is already 0-100 the way the engine wants it.
    let pct = |key: &str| -> Option<f32> { r.num(key).map(|v| v.clamp(0.0, 100.0) as f32) };

    // Opacity and flow are separate 0-100 sliders in CSP and one 0-1 number
    // here, so they multiply: 100% opacity at 72% flow is a 0.72 stroke.
    let opacity = match (r.num("Opacity"), r.num("BrushFlow")) {
        (None, None) => d.opacity,
        (o, f) => {
            let o = o.unwrap_or(100.0) / 100.0;
            let f = f.unwrap_or(100.0) / 100.0;
            (o * f).clamp(0.0, 1.0) as f32
        }
    };

    let taper = |used: &str, length: &str, unit: &str, ratio: &str, dflt: Taper| Taper {
        on: r.on(used).unwrap_or(dflt.on),
        len: len(length, unit, 4000.0).unwrap_or(dflt.len),
        ratio: pct(ratio).unwrap_or(dflt.ratio),
    };

    BrushSettings {
        // 1000 px is already a stroke as wide as a page; past that the value is
        // damage rather than a brush.
        size: len("BrushSize", "BrushSizeUnit", 1000.0).map(|v| v.max(1.0)).unwrap_or(d.size),
        opacity,
        // `BrushInterval` is a percent of the tip's size, which is the unit the
        // engine's `step = size * spacing / 100` already works in. The corpus
        // runs 0.1 to 24 and clusters on 10, the engine's own default, which is
        // the evidence for reading it as a percent rather than a multiplier.
        spacing: r.num("BrushInterval").map(|v| v.clamp(0.1, 100.0) as f32).unwrap_or(d.spacing),
        hardness: pct("BrushHardness").unwrap_or(d.hardness),
        // CSP stores a bearing; the engine wants one too, folded into one turn.
        angle: r.num("BrushRotation").map(|v| v.rem_euclid(360.0) as f32).unwrap_or(d.angle),
        angle_jitter: pct("BrushRotationRandomScale").unwrap_or(d.angle_jitter),
        // `BrushThickness` is a percent, but the corpus holds values up to 153,
        // so it is clamped rather than trusted: past 100 the tip is round, and
        // an unsquashed tip is what 1.0 means here.
        flatness: r
            .num("BrushThickness")
            .map(|v| (v / 100.0).clamp(0.05, 1.0) as f32)
            .unwrap_or(d.flatness),
        // CSP grades antialiasing none/weak/medium/strong; the engine has it on
        // or off, so anything but "none" is on.
        antialias: r.on("AntiAlias").unwrap_or(d.antialias),
        taper_in: taper("BrushUseIn", "BrushInLength", "BrushInLengthUnit", "BrushInRatio", d.taper_in),
        taper_out: taper(
            "BrushUseOut",
            "BrushOutLength",
            "BrushOutLengthUnit",
            "BrushOutRatio",
            d.taper_out,
        ),
        water_edge: r.on("BrushUseWaterEdge").unwrap_or(d.water_edge),
        // The engine's edge is a band a few px wide, so the radius is clamped
        // into the range its slider offers. `BrushWaterEdgeBlur` has no
        // counterpart in the engine and is not read.
        water_edge_width: len("BrushWaterEdgeRadius", "BrushWaterEdgeRadiusUnit", 20.0)
            .map(|v| v.max(1.0))
            .unwrap_or(d.water_edge_width),
        water_edge_power: pct("BrushWaterEdgeAlphaPower")
            .map(|v| v / 100.0)
            .unwrap_or(d.water_edge_power),
        // Correction off means no stabilisation, not the engine's default: the
        // brush was authored to track the pointer exactly.
        stabilise: match r.on("BrushUseRevision") {
            Some(false) => 0.0,
            Some(true) => pct("BrushRevision").unwrap_or(d.stabilise),
            None => d.stabilise,
        },
        // `BrushSharpenCorner` is 0 in every corpus file, so its scale cannot be
        // measured. It is read as a flag, and the threshold stays the engine's
        // default rather than being invented from a number that has never been
        // seen set.
        sharp_angles: SharpAngles {
            on: r.on("BrushSharpenCorner").unwrap_or(d.sharp_angles.on),
            deg: d.sharp_angles.deg,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-row `Variant` table holding exactly the named columns.
    fn db(cols: &[(&str, &str)]) -> Connection {
        let con = Connection::open_in_memory().unwrap();
        let decl = cols.iter().map(|(c, _)| format!("\"{c}\"")).collect::<Vec<_>>().join(",");
        let vals = cols.iter().map(|(_, v)| (*v).to_owned()).collect::<Vec<_>>().join(",");
        con.execute_batch(&format!(
            "create table Variant({decl}); insert into Variant values ({vals});"
        ))
        .unwrap();
        con
    }

    #[test]
    fn a_file_with_no_variant_table_reads_as_the_engines_own_defaults() {
        let con = Connection::open_in_memory().unwrap();
        let meta = read(&con);
        assert_eq!(meta.settings, BrushSettings::default());
        assert_eq!(meta.name, None);
        assert!(meta.has_pattern_image, "a file that says nothing is assumed to have a tip");
    }

    #[test]
    fn a_column_the_file_does_not_have_leaves_its_setting_at_the_default() {
        // One column present out of the twenty-seven wanted: the select must
        // still run, and everything else must fall back rather than fail.
        let meta = read(&db(&[("BrushHardness", "40")]));
        assert_eq!(meta.settings.hardness, 40.0);
        assert_eq!(meta.settings.size, BrushSettings::default().size);
        assert_eq!(meta.settings.spacing, BrushSettings::default().spacing);
    }

    #[test]
    fn millimetres_become_pixels_and_pixels_are_left_alone() {
        // 7.59 mm at 600 dpi is 179.3 px; the same number in unit 0 is 7.59 px.
        let mm = read(&db(&[("BrushSize", "7.59"), ("BrushSizeUnit", "2")]));
        assert!((mm.settings.size - 179.3).abs() < 0.1, "got {}", mm.settings.size);
        let px = read(&db(&[("BrushSize", "110.8"), ("BrushSizeUnit", "0")]));
        assert!((px.settings.size - 110.8).abs() < 0.01);
        // An unknown unit code is read as pixels rather than guessed at.
        let odd = read(&db(&[("BrushSize", "42"), ("BrushSizeUnit", "9")]));
        assert_eq!(odd.settings.size, 42.0);
    }

    #[test]
    fn opacity_is_the_product_of_the_two_sliders() {
        let s = read(&db(&[("Opacity", "100"), ("BrushFlow", "72")])).settings;
        assert!((s.opacity - 0.72).abs() < 1e-6);
        let half = read(&db(&[("Opacity", "50")])).settings;
        assert!((half.opacity - 0.5).abs() < 1e-6, "a missing flow is full flow");
        assert_eq!(read(&db(&[("BrushHardness", "1")])).settings.opacity, 1.0);
    }

    #[test]
    fn the_taper_columns_arrive_whole() {
        let s = read(&db(&[
            ("BrushUseIn", "1"),
            ("BrushInLength", "20.0"),
            ("BrushInLengthUnit", "0"),
            ("BrushInRatio", "16.3"),
            ("BrushUseOut", "0"),
            ("BrushOutLength", "1.0"),
            ("BrushOutLengthUnit", "2"),
            ("BrushOutRatio", "100.0"),
        ]))
        .settings;
        assert_eq!(s.taper_in, Taper { on: true, len: 20.0, ratio: 16.3 });
        assert!(!s.taper_out.on);
        // 1 mm at 600 dpi is 23.6 px.
        assert!((s.taper_out.len - 23.62).abs() < 0.01, "got {}", s.taper_out.len);
        assert_eq!(s.taper_out.ratio, 100.0);
    }

    #[test]
    fn correction_that_is_switched_off_is_no_stabilisation_at_all() {
        assert_eq!(
            read(&db(&[("BrushUseRevision", "0"), ("BrushRevision", "10")])).settings.stabilise,
            0.0
        );
        assert_eq!(
            read(&db(&[("BrushUseRevision", "1"), ("BrushRevision", "40")])).settings.stabilise,
            40.0
        );
        // Neither column present: the engine's default stands.
        assert_eq!(read(&db(&[("Opacity", "100")])).settings.stabilise, 12.0);
    }

    #[test]
    fn the_out_of_range_columns_are_clamped_rather_than_trusted() {
        let s = read(&db(&[
            ("BrushThickness", "153"),
            ("BrushRotation", "450"),
            ("BrushRotationRandomScale", "-5"),
            ("BrushInterval", "0"),
            ("BrushWaterEdgeRadius", "1.0"),
            ("BrushWaterEdgeRadiusUnit", "2"),
            ("BrushWaterEdgeAlphaPower", "50"),
        ]))
        .settings;
        assert_eq!(s.flatness, 1.0, "a thickness past 100 is a round tip");
        assert_eq!(s.angle, 90.0, "450 degrees is 90 degrees");
        assert_eq!(s.angle_jitter, 0.0);
        assert_eq!(s.spacing, 0.1, "zero spacing would stamp forever");
        assert_eq!(s.water_edge_width, 20.0, "23.6 px of edge is clamped to the slider's top");
        assert_eq!(s.water_edge_power, 0.5);
    }

    #[test]
    fn antialias_is_graded_in_csp_and_a_flag_here() {
        assert!(!read(&db(&[("AntiAlias", "0")])).settings.antialias);
        for level in ["1", "2", "3"] {
            assert!(read(&db(&[("AntiAlias", level)])).settings.antialias);
        }
    }

    #[test]
    fn the_row_the_node_points_at_is_the_one_that_is_read() {
        let con = Connection::open_in_memory().unwrap();
        con.execute_batch(
            "create table Variant(VariantID, BrushSize, BrushSizeUnit);
             insert into Variant values (1076, 110.8, 0), (1077, 2.5, 0);
             create table Node(NodeName, NodeVariantID);
             insert into Node values ('battle letter pen', 1077);",
        )
        .unwrap();
        let meta = read(&con);
        assert_eq!(meta.name.as_deref(), Some("battle letter pen"));
        assert_eq!(meta.settings.size, 2.5, "the current variant, not the first row");
    }

    #[test]
    fn a_variant_row_that_is_all_null_is_stepped_over() {
        let con = Connection::open_in_memory().unwrap();
        con.execute_batch(
            "create table Variant(VariantID, BrushSize);
             insert into Variant values (3520, null), (3519, 7.59);",
        )
        .unwrap();
        // No Node table at all, so the fallback picks the row with a size.
        assert_eq!(read(&con).settings.size, 7.59);
    }

    #[test]
    fn a_column_holding_text_is_dropped_rather_than_coerced() {
        let meta = read(&db(&[("BrushSize", "'wide'"), ("BrushHardness", "60")]));
        assert_eq!(meta.settings.size, BrushSettings::default().size);
        assert_eq!(meta.settings.hardness, 60.0);
    }

    #[test]
    fn a_brush_with_no_pattern_image_says_so() {
        assert!(!read(&db(&[("BrushUsePatternImage", "0")])).has_pattern_image);
        assert!(read(&db(&[("BrushUsePatternImage", "1")])).has_pattern_image);
    }
}
