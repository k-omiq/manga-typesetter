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
/// `select *` keeps every `Effector` blob but the three below out of the query.
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
    "BrushWaterEdgeValuePower",
    "BrushWaterEdgeBlur",
    "BrushWaterEdgeBlurUnit",
    // Stabilization proper. `FlickerReduction` is CSP's 手ブレ補正 - the live
    // smoothing slider - and `BrushRevision` is 後補正, Post correction, which
    // is why the two below it (`BrushRevisionBySpeed`, `BrushRevisionBezier`)
    // are the Post correction sub-options in the manual.
    "FlickerReduction",
    "BrushRevisionBySpeed",
    "BrushRotationEffector",
    "BrushRibbon",
    "BrushBlendPatternByDarken",
    "BrushInOutType",
    "BrushInOutBySpeed",
    "BrushPatternOrderType",
    "BrushPatternReverseHorizontal",
    "BrushPatternReverseVertical",
    "CompositeMode",
    "FlickerReductionBySpeed",
    "BrushRevisionBezier",
    "TextureDensity",
    "TextureScale2",
    "TextureStressDensity",
];

/// The BLOB column holding the dynamics that modulate `BrushSize`, in the
/// format [`super::effector`] decodes.
const SIZE_EFFECTOR: &str = "BrushSizeEffector";

/// The same for `Opacity`: how hard the stroke inks as the source moves.
const OPACITY_EFFECTOR: &str = "BrushOpacityEffector";

/// And for `BrushThickness`, CSP's tip squash across its short axis. Every
/// other `Effector` column names a parameter the engine does not have.
const THICK_EFFECTOR: &str = "BrushThicknessEffector";

/// The three of them in the order they are appended to the select, which is the
/// order [`Row`] keeps them in. One list rather than three copies of the same
/// "does the file have this column, and where did it land" bookkeeping, because
/// that bookkeeping is where an off-by-one would hand the engine another
/// parameter's dynamics without any test noticing the swap.
const EFFECTORS: [&str; 3] = [SIZE_EFFECTOR, OPACITY_EFFECTOR, THICK_EFFECTOR];

/// The BLOB column that is CSP's texture switch. It is not an image: in every
/// corpus file that has one it is a UTF-16 reference naming a material in
/// CSP's own library by id (`ノイズテクスチャ`, the stock noise), so the pixels
/// are not in the file. Its presence is what says the brush is textured, and
/// the columns beside it say how.
const TEXTURE_IMAGE: &str = "TextureImage";

/// CSP's Compare density as `CompositeMode` stores it. Measured, not looked
/// up: twenty corpus brushes carry it, seventeen of them with Blend brush tips
/// with Darken and anti-aliasing off beside it - the outlined pens, whose
/// stamps must not stack - and no other non-zero code appears anywhere.
const COMPOSITE_DENSITY: i64 = 34;

/// The engine's floor on the width factor - `MIN_W` in `src/lib/brush.js`. A
/// source that bottoms out still draws at 8% of the size rather than breaking
/// the stroke into beads, and that floor is what the conversion below inverts
/// through.
const ENGINE_MIN_W: f64 = 0.08;

/// A taper: how far into the stroke it runs and how thin it gets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Taper {
    pub on: bool,
    /// Page px, or percent of the brush size when `mode` is `pct`.
    pub len: f32,
    /// Percent of full width the end tapers away, 0-100.
    pub ratio: f32,
    /// CSP's Specification method: `px` is Specify length, `pct` is By
    /// percentage. Fade is read as a percentage taper over the whole stroke.
    pub mode: TaperMode,
}

/// CSP's Repeat method: the order a brush with several tip images cycles
/// through them. `BrushPatternOrderType` in the order the manual lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TipOrder {
    /// 0: left to right, round and round.
    Repeat,
    /// 1: left to right then back.
    Reverse,
    /// 2: Do not repeat - the last tip stays once the run is used up.
    Once,
    /// 3: Random.
    Random,
}

impl TipOrder {
    fn from_code(code: i64) -> Option<Self> {
        match code {
            0 => Some(TipOrder::Repeat),
            1 => Some(TipOrder::Reverse),
            2 => Some(TipOrder::Once),
            3 => Some(TipOrder::Random),
            _ => None,
        }
    }
}

/// How a taper's length is stated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaperMode {
    Px,
    Pct,
}

/// CSP's Flip horizontal / Flip vertical under Brush tip: the
/// `BrushPatternReverse*` columns. 0 is off in all 64 corpus files, and no
/// other value has been seen, so 1 is read as always and anything past it as
/// per stamp - the two options the manual lists after None.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlipMode {
    Off,
    On,
    Random,
}

impl FlipMode {
    fn from_code(code: i64) -> Self {
        match code {
            0 => FlipMode::Off,
            1 => FlipMode::On,
            _ => FlipMode::Random,
        }
    }
}

/// How the finished stroke lands on the ink under it - `BLEND_MODES` in
/// `src/lib/brush.js`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlendMode {
    /// Plain alpha compositing.
    Over,
    /// CSP's Compare density: the denser of the stroke and what is there wins.
    Density,
}

/// CSP's Texture category, on the engine's own grain - `normalizeTexture` in
/// `src/lib/brush.js`. Present only for a brush whose file names a texture.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Texture {
    pub on: bool,
    /// 0-1, CSP's Density.
    pub density: f32,
    /// Percent, CSP's Scale.
    pub scale: f32,
    /// CSP's Emphasize density.
    pub stress: bool,
}

/// Corner preservation: vertices turning by more than `deg` are exempt from the
/// post-stroke smoothing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SharpAngles {
    pub on: bool,
    /// Degrees.
    pub deg: f32,
}

/// What drives a parameter along a stroke, and how hard.
///
/// One shape serves all three of the dynamics a `.sut` can answer for - size,
/// opacity and thickness - because CSP stores them in the same `Effector`
/// structure and the engine drives them off the same three sliders. The name is
/// historical: size was the first one read.
///
/// `defaultBrushSettings().dyn` in `src/lib/brush.js`, field for field: `src` is
/// one of that file's `DYN_SOURCES` (never `off` - a brush with no dynamics for
/// a parameter omits the whole struct rather than switching the letterer's off)
/// and `amount` is its 0-100 strength slider.
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
    /// CSP's Direction "Direction of line". Never set from a file: the low
    /// bits of `BrushRotationEffector` are 3 in every corpus brush, tip
    /// shape regardless, so they cannot be the switch, and a dry brush with a
    /// fixed bearing would be wrecked by a guess. The letterer's toggle.
    pub follow_dir: bool,
    /// CSP's Stroke "Ribbon": the tip laid along the stroke as one band.
    pub ribbon: bool,
    /// CSP's Stroke "Blend brush tips with Darken".
    pub darken_tips: bool,
    /// Every tip image the sub tool cycles through, as the ids of the brushes
    /// they were installed as, in file order and including this one. Empty -
    /// and then absent from the JSON - for a brush with one tip, which is what
    /// the picker's spread wants: a single-tip brush must not carry an empty
    /// list that stomps nothing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tips: Vec<String>,
    /// CSP's Repeat method for those tips.
    pub tip_order: TipOrder,
    /// CSP's Flip horizontal and Flip vertical under Brush tip.
    pub flip_x: FlipMode,
    pub flip_y: FlipMode,
    /// Tip squash across its short axis, 0-1, where 1 is unsquashed.
    pub flatness: f32,
    /// CSP's grade: 0 None, 1 Weak, 2 Middle, 3 Strong.
    pub antialias: u8,
    /// How the finished stroke lands on the ink under it.
    pub blend: BlendMode,
    /// CSP's Texture category. Omitted for a brush whose file names no
    /// texture, so the letterer's own grain setting stands when it is picked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture: Option<Texture>,
    pub taper_in: Taper,
    pub taper_out: Taper,
    /// CSP's Starting and ending by speed.
    pub taper_by_speed: bool,
    pub water_edge: bool,
    /// Px, 1-20.
    pub water_edge_width: f32,
    /// 0-1, CSP's Opacity.
    pub water_edge_power: f32,
    /// 0-1, CSP's Darkness.
    pub water_edge_dark: f32,
    /// Px, 0-20, CSP's Blurring width.
    pub water_edge_blur: f32,
    /// Stabilisation window, 0-100: CSP's Stabilization (`FlickerReduction`).
    pub stabilise: f32,
    /// CSP's Adjust by speed under Stabilization.
    pub stabilise_by_speed: bool,
    /// Post correction, 0-100: CSP's `BrushRevision`. Optional the way `dyn`
    /// is - a file that has the column sends it, one that does not sends no
    /// key and leaves the letterer's own slider alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_correct: Option<f32>,
    /// CSP's Adjust by speed under Post correction.
    pub post_by_speed: bool,
    /// CSP's Bezier under Post correction.
    pub post_bezier: bool,
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
    /// The opacity dynamics, out of the `BrushOpacityEffector` blob. Optional
    /// for exactly the reason `dyn` is, and read the same way: a file that says
    /// nothing sends no key and the letterer keeps their own.
    #[serde(rename = "dynOpacity", skip_serializing_if = "Option::is_none")]
    pub dyn_opacity: Option<SizeDynamics>,
    /// The thickness dynamics, out of the `BrushThicknessEffector` blob - what
    /// squashes the tip along the stroke rather than scaling it.
    #[serde(rename = "dynThick", skip_serializing_if = "Option::is_none")]
    pub dyn_thick: Option<SizeDynamics>,
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
            follow_dir: false,
            ribbon: false,
            darken_tips: false,
            tips: Vec::new(),
            tip_order: TipOrder::Repeat,
            flip_x: FlipMode::Off,
            flip_y: FlipMode::Off,
            flatness: 1.0,
            antialias: 3,
            blend: BlendMode::Over,
            texture: None,
            taper_in: Taper { on: true, len: 20.0, ratio: 60.0, mode: TaperMode::Px },
            taper_out: Taper { on: true, len: 20.0, ratio: 60.0, mode: TaperMode::Px },
            taper_by_speed: false,
            water_edge: false,
            water_edge_width: 4.0,
            water_edge_power: 0.5,
            water_edge_dark: 0.0,
            water_edge_blur: 0.0,
            stabilise: 12.0,
            stabilise_by_speed: false,
            post_correct: None,
            post_by_speed: false,
            post_bezier: false,
            sharp_angles: SharpAngles { on: false, deg: 45.0 },
            // NOT `defaultBrushSettings().dyn`: the default here is "the file
            // said nothing", which the JS side reads as "keep what you have".
            dynamics: None,
            dyn_opacity: None,
            dyn_thick: None,
        }
    }
}

/// The engine's dynamics for one decoded `Effector` blob, or `None` when the
/// brush drives that parameter off nothing the engine has.
///
/// Two numbers cross here, and neither is the other's unit:
///
/// * CSP stores a MINIMUM - "at zero pressure the tip is 30% of its size".
/// * The engine has a STRENGTH - `widthFactors` fades the source's whole effect
///   back towards full width, so `amount` of 0 is no dynamics and 100 is all of
///   them, and the thinnest the stroke gets is `1 - amount/100 * (1 - floor)`.
///
/// So the strength is the minimum inverted through that line: setting the two
/// equal would make a brush authored at a 30% minimum draw at 70% of its size,
/// which is a visibly different pen. It is rounded to a whole percent because
/// that is the step the panel's slider offers - the letterer must be able to
/// land back on the imported value by hand.
///
/// `floor` is the lowest factor the engine will apply to this parameter, and it
/// is not the same for all three. Size and thickness both come out of the tip's
/// geometry, where the engine holds a stamp at `MIN_W` rather than letting it
/// collapse into a row of beads, so they invert through that floor. Opacity has
/// no such problem - a stroke that inks at nothing is simply not there yet, and
/// that is a pen a letterer can legitimately want - so it fades all the way to
/// 0 and inverts through a floor of 0.
///
/// A size minimum of 0 therefore asks for a strength of 108.7, past the slider,
/// so it clamps to 100 and the stroke bottoms out at the engine's own `MIN_W`
/// instead of at nothing; the same minimum on opacity lands exactly on 100. A
/// NEGATIVE minimum - which only the signed parameters (hue, saturation, value)
/// ever store, never one of these three in the corpus - is read as 0 for the
/// same reason: the engine's factor only ever scales a stamp down.
///
/// The response graph rides along with them, for the PRIMARY source only.
/// [`EffectorDynamics::curve`] keeps one graph per source and the engine drives
/// a parameter off one source, so handing over the other source's graph would
/// apply a velocity response to pressure input. Random has no graph in the
/// format and therefore sends none.
///
/// An identity graph - every node on `y = x` - is omitted rather than sent. It
/// is what the engine does with no curve at all, so sending it would put an
/// array in the settings, in the index on disk and in every equality check to
/// say precisely nothing.
fn dynamics_of(d: &EffectorDynamics, floor: f64) -> Option<SizeDynamics> {
    let src = d.primary()?;
    let minimum = f64::from(d.minimum(src)).clamp(0.0, 100.0);
    let amount = ((100.0 - minimum) / (1.0 - floor)).round().clamp(0.0, 100.0);
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

/// One `Variant` row, as the numbers this module reads out of it, plus the
/// blobs it reads.
///
/// Every wanted column is numeric in every file seen, and SQLite converts
/// integers to `f64` losslessly at this magnitude, so one map covers them all.
/// A column that holds something else is dropped rather than coerced.
struct Row {
    nums: HashMap<&'static str, f64>,
    /// `BrushSizeEffector`, undecoded. Absent when the file has no such column,
    /// the row holds `NULL`, or the value is not a blob - and the same for the
    /// two below it.
    size_effector: Option<Vec<u8>>,
    opacity_effector: Option<Vec<u8>>,
    thick_effector: Option<Vec<u8>>,
    /// Whether `TextureImage` holds anything: the texture switch.
    textured: bool,
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
    // The blobs ride in the same select, past the numbers, so a file that
    // predates a column costs nothing and one that has it needs no second
    // query. Celsys added the three at different times and half the corpus is
    // missing at least one, so which of them are in the select - and therefore
    // which result index each one landed on - is worked out per file rather
    // than assumed. The names come from `WANTED` and the blob constants, never
    // from the file, so the only thing the quoting guards against is a future
    // column name that needs it.
    let mut list: Vec<String> = cols.iter().map(|c| format!("\"{c}\"")).collect();
    let mut at = [None; EFFECTORS.len()];
    for (slot, name) in at.iter_mut().zip(EFFECTORS) {
        if have.contains(name) {
            *slot = Some(list.len());
            list.push(format!("\"{name}\""));
        }
    }
    // `length()` rather than the bytes: presence is all that is read of it.
    let texture_at = have.contains(TEXTURE_IMAGE).then(|| {
        list.push(format!("length(\"{TEXTURE_IMAGE}\")"));
        list.len() - 1
    });
    if list.is_empty() {
        return Vec::new();
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
        let blob = |slot: Option<usize>| -> Option<Vec<u8>> {
            slot.and_then(|i| r.get::<_, Option<Vec<u8>>>(i).ok().flatten())
        };
        let textured = texture_at
            .and_then(|i| r.get::<_, Option<i64>>(i).ok().flatten())
            .is_some_and(|n| n > 0);
        Ok(Row {
            nums,
            size_effector: blob(at[0]),
            opacity_effector: blob(at[1]),
            thick_effector: blob(at[2]),
            textured,
        })
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

    // `BrushInOutType` is CSP's Specification method for both ends: 0 Specify
    // length, 1 By percentage (of the brush size), 2 Fade. A percentage is a
    // plain number in the length column, whatever unit its sibling names, and
    // Fade is read as a percentage taper running the whole stroke, which is
    // what "reach the minimum value from the beginning" draws as.
    let in_out_type = r.int("BrushInOutType").unwrap_or(0);
    let taper = |used: &str, length: &str, unit: &str, ratio: &str, dflt: Taper| match in_out_type {
        1 => Taper {
            on: r.on(used).unwrap_or(dflt.on),
            len: r.num(length).map(|v| v.clamp(0.0, 500.0) as f32).unwrap_or(dflt.len),
            ratio: pct(ratio).unwrap_or(dflt.ratio),
            mode: TaperMode::Pct,
        },
        2 => Taper {
            on: r.on(used).unwrap_or(dflt.on),
            len: 500.0,
            ratio: pct(ratio).unwrap_or(dflt.ratio),
            mode: TaperMode::Pct,
        },
        _ => Taper {
            on: r.on(used).unwrap_or(dflt.on),
            len: len(length, unit, 4000.0).unwrap_or(dflt.len),
            ratio: pct(ratio).unwrap_or(dflt.ratio),
            mode: TaperMode::Px,
        },
    };
    // The random rotation slider only counts when the Random source is
    // switched on in the Direction dynamics: `BrushRotationRandomScale` sits
    // at 100 in forty corpus brushes and Random is on in twelve of them.
    let rotation_random = r.int("BrushRotationEffector").map(|m| m & 0x80 != 0);

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
        angle_jitter: match rotation_random {
            Some(false) => 0.0,
            _ => pct("BrushRotationRandomScale").unwrap_or(d.angle_jitter),
        },
        follow_dir: d.follow_dir,
        ribbon: r.on("BrushRibbon").unwrap_or(d.ribbon),
        darken_tips: r.on("BrushBlendPatternByDarken").unwrap_or(d.darken_tips),
        // Filled in by the importer once it knows the ids.
        tips: Vec::new(),
        tip_order: r.int("BrushPatternOrderType").and_then(TipOrder::from_code).unwrap_or(d.tip_order),
        // `BrushThickness` is a percent, but the corpus holds values up to 153,
        // so it is clamped rather than trusted: past 100 the tip is round, and
        // an unsquashed tip is what 1.0 means here.
        flip_x: r.int("BrushPatternReverseHorizontal").map(FlipMode::from_code).unwrap_or(d.flip_x),
        flip_y: r.int("BrushPatternReverseVertical").map(FlipMode::from_code).unwrap_or(d.flip_y),
        flatness: r
            .num("BrushThickness")
            .map(|v| (v / 100.0).clamp(0.05, 1.0) as f32)
            .unwrap_or(d.flatness),
        // CSP's four grades, 0 None to 3 Strong, which are the engine's too.
        antialias: r.int("AntiAlias").map(|v| v.clamp(0, 3) as u8).unwrap_or(d.antialias),
        blend: match r.int("CompositeMode") {
            Some(COMPOSITE_DENSITY) => BlendMode::Density,
            _ => d.blend,
        },
        // Textured only when the file names a texture. Density and scale are
        // read as CSP stores them; `TextureScale2` is the live one of the two
        // scale columns (`TextureScale` is the older, dual-brush-era name).
        texture: r.textured.then(|| Texture {
            on: true,
            density: pct("TextureDensity").map(|v| v / 100.0).unwrap_or(0.5),
            scale: r.num("TextureScale2").map(|v| v.clamp(10.0, 1000.0) as f32).unwrap_or(100.0),
            stress: r.on("TextureStressDensity").unwrap_or(false),
        }),
        taper_in: taper("BrushUseIn", "BrushInLength", "BrushInLengthUnit", "BrushInRatio", d.taper_in),
        taper_out: taper(
            "BrushUseOut",
            "BrushOutLength",
            "BrushOutLengthUnit",
            "BrushOutRatio",
            d.taper_out,
        ),
        taper_by_speed: r.on("BrushInOutBySpeed").unwrap_or(d.taper_by_speed),
        water_edge: r.on("BrushUseWaterEdge").unwrap_or(d.water_edge),
        // The engine's edge is a band a few px wide, so the radius is clamped
        // into the range its slider offers.
        water_edge_width: len("BrushWaterEdgeRadius", "BrushWaterEdgeRadiusUnit", 20.0)
            .map(|v| v.max(1.0))
            .unwrap_or(d.water_edge_width),
        water_edge_power: pct("BrushWaterEdgeAlphaPower")
            .map(|v| v / 100.0)
            .unwrap_or(d.water_edge_power),
        water_edge_dark: pct("BrushWaterEdgeValuePower")
            .map(|v| v / 100.0)
            .unwrap_or(d.water_edge_dark),
        water_edge_blur: len("BrushWaterEdgeBlur", "BrushWaterEdgeBlurUnit", 20.0)
            .unwrap_or(d.water_edge_blur),
        // CSP's Stabilization slider is `FlickerReduction`, and it has no
        // switch: zero is off.
        stabilise: pct("FlickerReduction").unwrap_or(d.stabilise),
        stabilise_by_speed: r.on("FlickerReductionBySpeed").unwrap_or(d.stabilise_by_speed),
        // Post correction off means none, not the engine's default: the brush
        // was authored to leave the finished line as drawn.
        post_correct: match r.on("BrushUseRevision") {
            Some(false) => Some(0.0),
            Some(true) => pct("BrushRevision").or(Some(d.stabilise)),
            None => None,
        },
        post_by_speed: r.on("BrushRevisionBySpeed").unwrap_or(d.post_by_speed),
        post_bezier: r.on("BrushRevisionBezier").unwrap_or(d.post_bezier),
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
            .and_then(|d| dynamics_of(d, ENGINE_MIN_W)),
        // Opacity fades to nothing rather than to the width floor, so it is the
        // one of the three that inverts through 0.
        dyn_opacity: r
            .opacity_effector
            .as_deref()
            .and_then(decode_effector)
            .as_ref()
            .and_then(|d| dynamics_of(d, 0.0)),
        dyn_thick: r
            .thick_effector
            .as_deref()
            .and_then(decode_effector)
            .as_ref()
            .and_then(|d| dynamics_of(d, ENGINE_MIN_W)),
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
        assert_eq!(s.taper_in, Taper { on: true, len: 20.0, ratio: 16.3, mode: TaperMode::Px });
        assert!(!s.taper_out.on);
        // 1 mm at 600 dpi is 23.6 px.
        assert!((s.taper_out.len - 23.62).abs() < 0.01, "got {}", s.taper_out.len);
        assert_eq!(s.taper_out.ratio, 100.0);
    }

    #[test]
    fn a_percentage_taper_is_read_as_one_and_fade_runs_the_whole_stroke() {
        let s = read(&db(&[
            ("BrushInOutType", "1"),
            ("BrushUseIn", "1"),
            ("BrushInLength", "30.0"),
            ("BrushInLengthUnit", "2"),
            ("BrushInRatio", "30.0"),
        ]))
        .settings;
        assert_eq!(s.taper_in, Taper { on: true, len: 30.0, ratio: 30.0, mode: TaperMode::Pct });
        let fade = read(&db(&[("BrushInOutType", "2"), ("BrushUseOut", "1"), ("BrushOutLength", "3")])).settings;
        assert_eq!(fade.taper_out.mode, TaperMode::Pct);
        assert_eq!(fade.taper_out.len, 500.0);
        assert!(read(&db(&[("BrushInOutBySpeed", "1")])).settings.taper_by_speed);
    }

    #[test]
    fn stabilisation_is_flicker_reduction_and_revision_is_post_correction() {
        let s = read(&db(&[
            ("FlickerReduction", "17"),
            ("BrushUseRevision", "1"),
            ("BrushRevision", "40"),
            ("BrushRevisionBySpeed", "1"),
        ]))
        .settings;
        assert_eq!(s.stabilise, 17.0);
        assert_eq!(s.post_correct, Some(40.0));
        assert!(s.post_by_speed);
        // Post correction switched off is none at all, and a file that says
        // nothing sends no key.
        assert_eq!(
            read(&db(&[("BrushUseRevision", "0"), ("BrushRevision", "10")])).settings.post_correct,
            Some(0.0)
        );
        assert_eq!(read(&db(&[("Opacity", "100")])).settings.post_correct, None);
        // No stabilisation column: the engine's default stands.
        assert_eq!(read(&db(&[("Opacity", "100")])).settings.stabilise, 12.0);
    }

    #[test]
    fn random_rotation_counts_only_when_the_random_source_is_on() {
        let off = read(&db(&[("BrushRotationEffector", "3"), ("BrushRotationRandomScale", "100")])).settings;
        assert_eq!(off.angle_jitter, 0.0);
        let on = read(&db(&[("BrushRotationEffector", "131"), ("BrushRotationRandomScale", "100")])).settings;
        assert_eq!(on.angle_jitter, 100.0);
        // No effector column at all: the slider is taken at its word.
        assert_eq!(read(&db(&[("BrushRotationRandomScale", "50")])).settings.angle_jitter, 50.0);
    }

    #[test]
    fn the_stroke_switches_and_the_edges_darkness_and_blur_arrive() {
        let s = read(&db(&[
            ("BrushRibbon", "1"),
            ("BrushBlendPatternByDarken", "1"),
            ("BrushWaterEdgeValuePower", "20"),
            ("BrushWaterEdgeBlur", "0.76"),
            ("BrushWaterEdgeBlurUnit", "0"),
        ]))
        .settings;
        assert!(s.ribbon);
        assert!(s.darken_tips);
        assert_eq!(read(&db(&[("BrushPatternOrderType", "3")])).settings.tip_order, TipOrder::Random);
        assert_eq!(read(&db(&[("BrushPatternOrderType", "0")])).settings.tip_order, TipOrder::Repeat);
        assert_eq!(read(&db(&[("BrushPatternOrderType", "9")])).settings.tip_order, TipOrder::Repeat);
        assert!(!s.follow_dir, "never guessed from a file");
        assert!((s.water_edge_dark - 0.2).abs() < 1e-6);
        assert!((s.water_edge_blur - 0.76).abs() < 1e-6);
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
    fn antialias_is_graded_in_csp_and_here() {
        for (code, level) in [("0", 0u8), ("1", 1), ("2", 2), ("3", 3), ("9", 3), ("-1", 0)] {
            assert_eq!(read(&db(&[("AntiAlias", code)])).settings.antialias, level, "code {code}");
        }
        assert_eq!(read(&db(&[("Opacity", "100")])).settings.antialias, 3, "no column is Strong");
    }

    #[test]
    fn compare_density_is_read_and_every_other_composite_is_plain() {
        assert_eq!(read(&db(&[("CompositeMode", "34")])).settings.blend, BlendMode::Density);
        assert_eq!(read(&db(&[("CompositeMode", "0")])).settings.blend, BlendMode::Over);
        assert_eq!(read(&db(&[("CompositeMode", "2")])).settings.blend, BlendMode::Over);
        assert_eq!(read(&db(&[("Opacity", "100")])).settings.blend, BlendMode::Over);
    }

    #[test]
    fn the_flips_and_the_speed_and_bezier_switches_arrive() {
        let s = read(&db(&[
            ("BrushPatternReverseHorizontal", "1"),
            ("BrushPatternReverseVertical", "2"),
            ("FlickerReductionBySpeed", "1"),
            ("BrushRevisionBezier", "1"),
        ]))
        .settings;
        assert_eq!(s.flip_x, FlipMode::On);
        assert_eq!(s.flip_y, FlipMode::Random);
        assert!(s.stabilise_by_speed);
        assert!(s.post_bezier);
        let off = read(&db(&[("BrushPatternReverseHorizontal", "0")])).settings;
        assert_eq!(off.flip_x, FlipMode::Off);
        assert!(!off.stabilise_by_speed);
        assert!(!off.post_bezier);
    }

    #[test]
    fn a_texture_is_read_only_when_the_file_names_one() {
        // The corpus's reference blob, in spirit: any bytes at all.
        let on = read(&db(&[
            ("TextureImage", "x'0000000800000001'"),
            ("TextureDensity", "100"),
            ("TextureScale2", "300.0"),
            ("TextureStressDensity", "1"),
        ]))
        .settings;
        assert_eq!(on.texture, Some(Texture { on: true, density: 1.0, scale: 300.0, stress: true }));
        // The columns without the image: no texture. Two corpus brushes hold
        // a full set of texture numbers and no image, and draw untextured.
        let numbers = read(&db(&[("TextureDensity", "100"), ("TextureScale2", "10.0")])).settings;
        assert_eq!(numbers.texture, None);
        assert_eq!(read(&db(&[("TextureImage", "null")])).settings.texture, None);
        assert_eq!(read(&db(&[("TextureImage", "x''")])).settings.texture, None);
        // Density and scale missing beside an image: CSP's own defaults.
        let bare = read(&db(&[("TextureImage", "x'01'")])).settings.texture.unwrap();
        assert_eq!((bare.density, bare.scale, bare.stress), (0.5, 100.0, false));
        // And the key is absent from the JSON, not null, for the same reason
        // `dyn` is: the picker spreads these over the tool's settings.
        let v = serde_json::to_value(BrushSettings::default()).unwrap();
        assert!(v.get("texture").is_none());
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
    fn the_thickness_effector_is_read_through_the_same_width_floor_as_size() {
        // Random alone, a 30% minimum thickness. Thickness squashes the tip
        // rather than scaling it, but it is still the tip's geometry, so it
        // inverts through the engine's `MIN_W`: 70 / 0.92 is 76.09, and the
        // slider takes whole percents.
        let s = read(&db(&[
            ("BrushThickness", "100"),
            ("BrushThicknessEffector", &effector(OFFERED, 0x80, [0, 0, 0, 30])),
        ]))
        .settings;
        assert_eq!(s.dyn_thick, Some(SizeDynamics { src: Source::Random, amount: 76.0, curve: None }));
        // The plain column beside it, and the other two parameters, are its
        // business alone.
        assert_eq!(s.flatness, 1.0);
        assert_eq!((s.dynamics, s.dyn_opacity), (None, None));
    }

    #[test]
    fn the_opacity_effector_fades_all_the_way_down_and_so_inverts_through_zero() {
        let opacity = |minimum| {
            read(&db(&[("BrushOpacityEffector", &effector(OFFERED, 0x10, [minimum, 0, 0, 0]))]))
                .settings
                .dyn_opacity
        };
        // A 20% minimum opacity is an 80% strength, not the 87 the width floor
        // would give: the engine lets a stroke ink at nothing, so there is no
        // floor to invert through and the two numbers are plain complements.
        assert_eq!(opacity(20), Some(SizeDynamics { src: Source::Pressure, amount: 80.0, curve: None }));
        // And a minimum of 0 lands exactly on the top of the slider rather than
        // clamping onto it from 108.7 the way a size minimum of 0 does.
        assert_eq!(opacity(0).map(|d| d.amount), Some(100.0));
        assert_eq!(opacity(100).map(|d| d.amount), Some(0.0));
    }

    #[test]
    fn a_file_with_no_opacity_or_thickness_columns_sends_neither_key() {
        // The common case: the columns are a later CSP's, and their absence
        // must leave the letterer's own dynamics alone without disturbing the
        // size dynamics the file does carry.
        let s = read(&db(&[
            ("BrushSize", "40"),
            ("BrushSizeEffector", &effector(OFFERED, 0x10, [30, 0, 0, 0])),
        ]))
        .settings;
        assert_eq!(s.dyn_opacity, None);
        assert_eq!(s.dyn_thick, None);
        assert_eq!(s.dynamics.map(|d| d.amount), Some(76.0), "size read as it always was");
        // The columns present but NULL in this row is the same answer.
        let null = read(&db(&[("BrushOpacityEffector", "null"), ("BrushThicknessEffector", "null")]))
            .settings;
        assert_eq!((null.dyn_opacity, null.dyn_thick), (None, None));
    }

    #[test]
    fn one_undecodable_blob_does_not_cost_the_others() {
        // Bytes that are not the structure at all in the opacity column: it
        // comes back as no key, exactly like a missing column, and the size
        // blob beside it is read as though nothing had happened. There is no
        // guessing rung here for any of the three.
        let s = read(&db(&[
            ("BrushSizeEffector", &effector(OFFERED, 0x10, [30, 0, 0, 0])),
            ("BrushOpacityEffector", &hex(b"abc")),
        ]))
        .settings;
        assert_eq!(s.dyn_opacity, None);
        assert_eq!(s.dynamics, Some(SizeDynamics { src: Source::Pressure, amount: 76.0, curve: None }));
    }

    #[test]
    fn all_three_effectors_land_on_their_own_field() {
        // Three different sources, so a select that lost track of which blob
        // sat at which index would swap two of them loudly rather than hand
        // over another parameter's dynamics under the right name.
        let s = read(&db(&[
            ("BrushSize", "40"),
            ("BrushSizeEffector", &effector(OFFERED, 0x10, [30, 0, 0, 0])),
            ("BrushOpacityEffector", &effector(OFFERED, 0x40, [0, 0, 20, 0])),
            ("BrushThicknessEffector", &effector(OFFERED, 0x80, [0, 0, 0, 30])),
        ]))
        .settings;
        assert_eq!(s.dynamics, Some(SizeDynamics { src: Source::Pressure, amount: 76.0, curve: None }));
        assert_eq!(s.dyn_opacity, Some(SizeDynamics { src: Source::Velocity, amount: 80.0, curve: None }));
        assert_eq!(s.dyn_thick, Some(SizeDynamics { src: Source::Random, amount: 76.0, curve: None }));
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
