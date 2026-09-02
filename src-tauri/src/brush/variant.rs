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

use super::effector::{decode_effector, EffectorDynamics, Source};

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

/// The numeric columns [`read`] asks for. Selecting these by name rather than
/// `select *` keeps every `Effector` blob but the one below out of the query.
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

/// The one BLOB column read here: the dynamics that modulate `BrushSize`, in
/// the format [`super::effector`] decodes. Every other `Effector` column names a
/// parameter the engine does not have.
const SIZE_EFFECTOR: &str = "BrushSizeEffector";

/// The engine's floor on the width factor - `MIN_W` in `src/lib/brush.js`. A
/// source that bottoms out still draws at 8% of the size rather than breaking
/// the stroke into beads, and that floor is what the conversion below inverts
/// through.
const ENGINE_MIN_W: f64 = 0.08;

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

/// What drives the tip's width along a stroke, and how hard.
///
/// `defaultBrushSettings().dyn` in `src/lib/brush.js`, field for field: `src` is
/// one of that file's `DYN_SOURCES` (never `off` - a brush with no size dynamics
/// omits the whole struct rather than switching the letterer's off) and `amount`
/// is its 0-100 strength slider.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SizeDynamics {
    pub src: Source,
    /// 0-100, the engine's strength slider.
    pub amount: f32,
    /// The brush's response graph for `src`, input then output, both 0 to 1 and
    /// `x` ascending - `dynCurve` in `src/lib/brush.js`, which remaps the
    /// source's raw input through it before `amount` fades the result.
    ///
    /// Absent for the straight line, which is both what the file stores when it
    /// has no graph and what an identity graph means. Random has no graph in the
    /// format at all: there is no input axis to plot a random draw against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curve: Option<Vec<[f32; 2]>>,
}

/// One imported brush's settings, in the units `src/lib/brush.js` expects.
///
/// Field for field this is the subset of `defaultBrushSettings()` a `.sut` can
/// answer for.
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
    /// The size dynamics, out of the `BrushSizeEffector` blob.
    ///
    /// The one OPTIONAL setting, and the reason it is optional is the picker's
    /// contract: `pickedSettings` spreads these settings over the tool's, so a
    /// key that is absent leaves the letterer's own value alone. A brush whose
    /// blob is missing, undecodable, or names no source the engine has must not
    /// stomp hand-set dynamics, so it sends no key at all rather than a default.
    #[serde(rename = "dyn", skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<SizeDynamics>,
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
            // NOT `defaultBrushSettings().dyn`: the default here is "the file
            // said nothing", which the JS side reads as "keep what you have".
            dynamics: None,
        }
    }
}

/// The engine's size dynamics for a decoded `BrushSizeEffector`, or `None` when
/// the brush drives its size off nothing the engine has.
///
/// Two numbers cross here, and neither is the other's unit:
///
/// * CSP stores a MINIMUM - "at zero pressure the tip is 30% of its size".
/// * The engine has a STRENGTH - `widthFactors` fades the source's whole effect
///   back towards full width, so `amount` of 0 is no dynamics and 100 is all of
///   them, and the thinnest the stroke gets is `1 - amount/100 * (1 - MIN_W)`.
///
/// So the strength is the minimum inverted through that line: setting the two
/// equal would make a brush authored at a 30% minimum draw at 70% of its size,
/// which is a visibly different pen. It is rounded to a whole percent because
/// that is the step the panel's slider offers - the letterer must be able to
/// land back on the imported value by hand.
///
/// A minimum of 0 asks for a strength of 108.7, past the slider, so it clamps to
/// 100 and the stroke bottoms out at the engine's own `MIN_W` instead of at
/// nothing. A NEGATIVE minimum - which only the signed parameters (hue,
/// saturation, value) ever store, never a size in the corpus - is read as 0 for
/// the same reason: the engine's width factor only ever scales a stamp down.
///
/// The response graph rides along with them, for the PRIMARY source only.
/// [`EffectorDynamics::curve`] keeps one graph per source and the engine drives
/// size off one source, so handing over the other source's graph would apply a
/// velocity response to pressure input. Random has no graph in the format and
/// therefore sends none.
///
/// An identity graph - every node on `y = x` - is omitted rather than sent. It
/// is what the engine does with no curve at all, so sending it would put an
/// array in the settings, in the index on disk and in every equality check to
/// say precisely nothing.
fn size_dynamics(d: &EffectorDynamics) -> Option<SizeDynamics> {
    let src = d.primary()?;
    let minimum = f64::from(d.minimum(src)).clamp(0.0, 100.0);
    let amount = ((100.0 - minimum) / (1.0 - ENGINE_MIN_W)).round().clamp(0.0, 100.0);
    let curve = d.curve(src).filter(|c| !is_identity(c)).map(<[[f32; 2]]>::to_vec);
    Some(SizeDynamics { src, amount: amount as f32, curve })
}

/// Whether a graph is the straight line the engine already draws without one.
///
/// The tolerance is a hair rather than exact equality because the control points
/// come off the file as `f64` on CSP's 1/110 grid and arrive here as `f32`: a
/// node the author left on the diagonal can land a rounding step off it, and
/// treating that as a curve would ship an array that changes no pixel.
fn is_identity(curve: &[[f32; 2]]) -> bool {
    curve.iter().all(|[x, y]| (x - y).abs() <= 1e-6)
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

/// One `Variant` row, as the numbers this module reads out of it, plus the one
/// blob it reads.
///
/// Every wanted column is numeric in every file seen, and SQLite converts
/// integers to `f64` losslessly at this magnitude, so one map covers them all.
/// A column that holds something else is dropped rather than coerced.
struct Row {
    nums: HashMap<&'static str, f64>,
    /// `BrushSizeEffector`, undecoded. Absent when the file has no such column,
    /// the row holds `NULL`, or the value is not a blob.
    size_effector: Option<Vec<u8>>,
}

impl Row {
    fn num(&self, key: &str) -> Option<f64> {
        // A NaN or infinity would survive every clamp below and then fail the
        // whole IPC reply at serialisation, so it is dropped like a non-number.
        self.nums.get(key).copied().filter(|v| v.is_finite())
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
    // The blob rides in the same select, at a known index past the numbers, so
    // a file that predates the column costs nothing and one that has it needs no
    // second query.
    let blob = have.contains(SIZE_EFFECTOR);
    if cols.is_empty() && !blob {
        return Vec::new();
    }
    // The names come from `WANTED` and `SIZE_EFFECTOR`, never from the file, so
    // the only thing the quoting guards against is a future column name that
    // needs it.
    let mut list: Vec<String> = cols.iter().map(|c| format!("\"{c}\"")).collect();
    if blob {
        list.push(format!("\"{SIZE_EFFECTOR}\""));
    }
    let list = list.join(",");
    let Ok(mut stmt) = con.prepare(&format!("select {list} from Variant")) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        let mut nums = HashMap::with_capacity(cols.len());
        for (i, c) in cols.iter().enumerate() {
            if let Ok(Some(v)) = r.get::<_, Option<f64>>(i) {
                nums.insert(*c, v);
            }
        }
        // A column holding something that is not a blob is dropped exactly the
        // way a numeric column holding text is: the decoder never sees it.
        let size_effector =
            blob.then(|| r.get::<_, Option<Vec<u8>>>(cols.len()).ok().flatten()).flatten();
        Ok(Row { nums, size_effector })
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
        // A blob that is not the structure `decode_effector` knows comes back
        // as `None` and is treated exactly like a missing column: the key is
        // omitted and the letterer keeps their own dynamics. There is no
        // guessing rung here - a half-read Effector would silently change how
        // every stroke thins.
        dynamics: r
            .size_effector
            .as_deref()
            .and_then(decode_effector)
            .as_ref()
            .and_then(size_dynamics),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `Effector` blob as the SQL blob literal `db` wants: the 44-byte header
    /// and nothing after it, which is what a brush whose response curves are the
    /// straight line stores. `minimums` is per [`Source::ALL`].
    fn effector(available: i32, enabled: i32, minimums: [i32; 4]) -> String {
        let mut bytes = 44u32.to_be_bytes().to_vec();
        for w in [available, enabled, minimums[0], minimums[1], minimums[2], minimums[3], 0, 0, 0, 100] {
            bytes.extend_from_slice(&w.to_be_bytes());
        }
        hex(&bytes)
    }

    /// The same blob with response graphs in one or both slots. An empty slice
    /// is the slot the file leaves out, which is what a straight line stores.
    fn effector_curved(
        available: i32,
        enabled: i32,
        minimums: [i32; 4],
        pressure: &[[f64; 2]],
        velocity: &[[f64; 2]],
    ) -> String {
        // One graph as its own record: a 12-byte header, then big-endian `f64`
        // pairs. This is the writer for the reader in `effector.rs`.
        let graph = |pts: &[[f64; 2]]| {
            let mut out = Vec::new();
            if pts.is_empty() {
                return out;
            }
            out.extend_from_slice(&12u32.to_be_bytes());
            out.extend_from_slice(&(pts.len() as u32).to_be_bytes());
            out.extend_from_slice(&16u32.to_be_bytes());
            for [x, y] in pts {
                out.extend_from_slice(&x.to_be_bytes());
                out.extend_from_slice(&y.to_be_bytes());
            }
            out
        };
        let (p, v) = (graph(pressure), graph(velocity));
        let mut bytes = 44u32.to_be_bytes().to_vec();
        for w in [
            available,
            enabled,
            minimums[0],
            minimums[1],
            minimums[2],
            minimums[3],
            0,
            p.len() as i32,
            v.len() as i32,
            100,
        ] {
            bytes.extend_from_slice(&w.to_be_bytes());
        }
        bytes.extend_from_slice(&p);
        bytes.extend_from_slice(&v);
        hex(&bytes)
    }

    /// Any bytes as a SQLite blob literal.
    fn hex(bytes: &[u8]) -> String {
        let mut out = String::from("x'");
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out.push('\'');
        out
    }

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

    /// The one source bit CSP's size parameter offers on top of the four.
    const OFFERED: i32 = 0x1F0;

    #[test]
    fn the_size_effector_becomes_the_engines_own_dynamics() {
        let s = read(&db(&[
            ("BrushSize", "40"),
            ("BrushSizeEffector", &effector(OFFERED, 0x10, [30, 0, 0, 0])),
        ]))
        .settings;
        // 30% minimum size inverted through the engine's strength slider.
        assert_eq!(s.dynamics, Some(SizeDynamics { src: Source::Pressure, amount: 76.0, curve: None }));
        // And the plain columns beside it are untouched by any of this.
        assert_eq!(s.size, 40.0);
    }

    #[test]
    fn the_minimum_size_is_inverted_into_the_engines_strength_slider() {
        // The engine thins a stroke to `1 - amount/100 * (1 - MIN_W)` of its
        // size, so every row here is checked by walking that line BACK to the
        // minimum the file asked for. A mapping that set the two equal would
        // fail every one of them.
        for (minimum, amount) in [(0, 100.0), (10, 98.0), (30, 76.0), (50, 54.0), (100, 0.0)] {
            let s = read(&db(&[(
                "BrushSizeEffector",
                &effector(OFFERED, 0x10, [minimum, 0, 0, 0]),
            )]))
            .settings;
            let d = s.dynamics.expect("pressure is switched on");
            assert_eq!(d.amount, amount, "minimum {minimum}%");
            let thinnest = 1.0 - f64::from(d.amount) / 100.0 * (1.0 - ENGINE_MIN_W);
            // Within half a slider step of what CSP stored, except at 0 where
            // the engine's own floor stops it short and says so.
            let want = if minimum == 0 { ENGINE_MIN_W } else { f64::from(minimum) / 100.0 };
            assert!((thinnest - want).abs() < 0.005, "minimum {minimum}% landed at {thinnest}");
        }
    }

    #[test]
    fn the_source_the_engine_gets_follows_the_decoders_precedence() {
        let dynamics = |enabled, minimums| {
            read(&db(&[("BrushSizeEffector", &effector(OFFERED, enabled, minimums))]))
                .settings
                .dynamics
        };
        // Velocity alone, and its own minimum - not pressure's.
        assert_eq!(
            dynamics(0x40, [90, 0, 50, 0]),
            Some(SizeDynamics { src: Source::Velocity, amount: 54.0, curve: None })
        );
        // Pressure and velocity together: pressure carries the stroke.
        assert_eq!(dynamics(0x50, [30, 0, 50, 0]).map(|d| d.src), Some(Source::Pressure));
        // Random alone is still a driver.
        assert_eq!(
            dynamics(0x80, [0, 0, 0, 20]),
            Some(SizeDynamics { src: Source::Random, amount: 87.0, curve: None })
        );
        // A negative minimum is a signed parameter's, never a size's; read as
        // zero because the engine's width factor only scales a stamp down.
        assert_eq!(dynamics(0x80, [0, 0, 0, -100]).map(|d| d.amount), Some(100.0));
    }

    /// A drastic graph: full output by 1% input, then flat. The corpus really
    /// holds shapes like this, and it is the one the engine has to honour for an
    /// imported brush to behave like it does in CSP.
    const STEEP: [[f64; 2]; 3] = [[0.0, 0.0], [0.01, 1.0], [1.0, 1.0]];

    #[test]
    fn the_primary_sources_response_graph_rides_along_with_it() {
        let curve = |enabled, pressure: &[[f64; 2]], velocity: &[[f64; 2]]| {
            read(&db(&[(
                "BrushSizeEffector",
                &effector_curved(OFFERED, enabled, [30, 0, 30, 0], pressure, velocity),
            )]))
            .settings
            .dynamics
            .expect("a source is switched on")
            .curve
        };
        // Pressure drives, so it is the PRESSURE graph that arrives - handing
        // over the velocity graph would apply one source's response to another's
        // input, which is a different pen and a silent one.
        let gentle = [[0.0, 0.0], [0.5, 0.9], [1.0, 1.0]];
        assert_eq!(
            curve(0x10, &STEEP, &gentle),
            Some(vec![[0.0, 0.0], [0.01, 1.0], [1.0, 1.0]])
        );
        assert_eq!(
            curve(0x40, &STEEP, &gentle),
            Some(vec![[0.0, 0.0], [0.5, 0.9], [1.0, 1.0]]),
            "velocity drives, so velocity's graph is the one that ships"
        );
        // Both switched on: pressure wins the source, and takes its graph with
        // it rather than leaving velocity's behind.
        assert_eq!(
            curve(0x50, &STEEP, &gentle),
            Some(vec![[0.0, 0.0], [0.01, 1.0], [1.0, 1.0]])
        );
        // Random has no input axis to plot, so the format stores no graph for it
        // and none is invented from the slots that are there.
        assert_eq!(curve(0x80, &STEEP, &gentle), None);
        // A driver whose own slot is empty: the straight line, sent as absent.
        assert_eq!(curve(0x40, &STEEP, &[]), None);
    }

    #[test]
    fn a_straight_line_graph_is_omitted_rather_than_shipped() {
        let curve = |pressure: &[[f64; 2]]| {
            read(&db(&[(
                "BrushSizeEffector",
                &effector_curved(OFFERED, 0x10, [30, 0, 0, 0], pressure, &[]),
            )]))
            .settings
            .dynamics
            .and_then(|d| d.curve)
        };
        // y = x at two nodes and at four: identical to no curve at all, so it
        // must not travel as an array that changes nothing.
        assert_eq!(curve(&[[0.0, 0.0], [1.0, 1.0]]), None);
        assert_eq!(curve(&[[0.0, 0.0], [0.25, 0.25], [0.75, 0.75], [1.0, 1.0]]), None);
        // One node a hair off the diagonal is still the straight line: the
        // control points are `f64` on CSP's 1/110 grid and land here as `f32`.
        assert_eq!(curve(&[[0.0, 0.0], [0.5, 0.5 + 1e-9], [1.0, 1.0]]), None);
        // Visibly off it is a curve, and travels.
        assert!(curve(&[[0.0, 0.0], [0.5, 0.6], [1.0, 1.0]]).is_some());
    }

    #[test]
    fn the_curve_reaches_the_json_as_pairs_the_engine_can_read() {
        let v = serde_json::to_value(
            read(&db(&[(
                "BrushSizeEffector",
                &effector_curved(OFFERED, 0x10, [30, 0, 0, 0], &STEEP, &[]),
            )]))
            .settings,
        )
        .unwrap();
        assert_eq!(v["dyn"]["src"], "pressure");
        // An array of pairs, in order, in range - the shape `dynCurve` accepts.
        // Compared with a tolerance rather than exactly because the points pass
        // through `f32`, and 0.01 comes back out as 0.00999999977.
        let got = v["dyn"]["curve"].as_array().expect("an array of pairs");
        assert_eq!(got.len(), 3);
        for (pair, want) in got.iter().zip(STEEP) {
            let p = pair.as_array().expect("a pair");
            assert_eq!(p.len(), 2);
            for (n, w) in p.iter().zip(want) {
                let v = n.as_f64().expect("a number");
                assert!((0.0..=1.0).contains(&v) && (v - w).abs() < 1e-6, "{v} is not {w}");
            }
        }
        // And a brush with no graph carries no `curve` key, for the same reason
        // a brush with no dynamics carries no `dyn` key.
        let plain = serde_json::to_value(
            read(&db(&[("BrushSizeEffector", &effector(OFFERED, 0x10, [30, 0, 0, 0]))])).settings,
        )
        .unwrap();
        assert!(plain["dyn"].get("curve").is_none(), "no graph, no key");
    }

    #[test]
    fn a_brush_that_says_nothing_about_dynamics_sends_no_key_at_all() {
        // No column: the letterer's hand-set dynamics stand.
        assert_eq!(read(&db(&[("BrushSize", "40")])).settings.dynamics, None);
        // The column, but NULL in this row.
        assert_eq!(read(&db(&[("BrushSizeEffector", "null")])).settings.dynamics, None);
        // A blob that decodes and switches nothing on: the two corpus brushes
        // with no size dynamics at all.
        assert_eq!(
            read(&db(&[("BrushSizeEffector", &effector(OFFERED, 0, [50, 0, 0, 0]))]))
                .settings
                .dynamics,
            None
        );
        // Tilt only. It decodes, but the engine has no tilt and a pointer event
        // does not carry one, so it must not be mis-driven off pressure.
        assert_eq!(
            read(&db(&[("BrushSizeEffector", &effector(OFFERED, 0x20, [0, 40, 0, 0]))]))
                .settings
                .dynamics,
            None
        );
        // Bytes that are not the structure at all, and a column holding text.
        assert_eq!(read(&db(&[("BrushSizeEffector", &hex(&[0; 44]))])).settings.dynamics, None);
        assert_eq!(read(&db(&[("BrushSizeEffector", "'off'")])).settings.dynamics, None);
    }

    #[test]
    fn the_dynamics_key_is_absent_from_the_json_rather_than_null() {
        // The picker spreads these settings over the tool's, so an absent key is
        // the difference between "keep your dynamics" and "switch them off".
        let none = serde_json::to_value(BrushSettings::default()).unwrap();
        assert!(none.get("dyn").is_none(), "a brush with no dynamics carries no dyn key");
        let some = serde_json::to_value(BrushSettings {
            dynamics: Some(SizeDynamics { src: Source::Velocity, amount: 76.0, curve: None }),
            ..BrushSettings::default()
        })
        .unwrap();
        assert_eq!(some["dyn"]["src"], "velocity", "the name `src/lib/brush.js` reads");
        assert_eq!(some["dyn"]["amount"], 76.0);
    }

    #[test]
    fn a_brush_with_no_pattern_image_says_so() {
        assert!(!read(&db(&[("BrushUsePatternImage", "0")])).has_pattern_image);
        assert!(read(&db(&[("BrushUsePatternImage", "1")])).has_pattern_image);
    }
}
