//! Brush import: reading brush tips out of the files a letterer already owns.
//!
//! [`sut`] is the parser for Clip Studio Paint `.sut` files; [`score`] grades
//! what it read against the preview image CSP ships inside the same file;
//! [`variant`] normalises the brush settings out of the outer database, and
//! [`effector`] reads the size dynamics out of the blobs beside them.
//! [`abr`] is the parser for Photoshop brush sets, which ship no preview and so
//! are validated structurally instead. This module is the [`brush_import`]
//! command, the extension dispatch, and the fallback ladder over them.
//!
//! Nothing here may fail the whole import because one file was bad. A path that
//! is neither a `.sut` nor an `.abr`, or is one this build cannot read, comes
//! back as an entry in [`ImportResult::errors`] beside the brushes that did
//! import.

pub mod abr;
pub mod effector;
pub mod score;
pub mod sut;
pub mod variant;

use std::io::Read;
use std::path::Path;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, GrayImage, ImageEncoder};
use serde::Serialize;

use variant::BrushSettings;

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

// --------------------------------------------------------------------------
// The imported brush
// --------------------------------------------------------------------------

/// Where a shipped brush's tip came from, which is [`TipSource`] plus the rung
/// below it: a tip this build drew itself because the file had none.
///
/// Separate from [`TipSource`] because that one is the parser's answer about
/// pixels it read, and the parser never synthesises anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrushSource {
    /// Full resolution, out of the material's pixel blob.
    Pixels,
    /// CSP's own preview, capped at 300 px. Shown as "preview quality".
    Thumbnail,
    /// No tip image in the file at all, so a round one was drawn from
    /// `BrushHardness`.
    Round,
}

impl From<TipSource> for BrushSource {
    fn from(s: TipSource) -> Self {
        match s {
            TipSource::Pixels => BrushSource::Pixels,
            TipSource::Thumbnail => BrushSource::Thumbnail,
        }
    }
}

/// One brush, ready for the library to install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBrush {
    /// Stable across a rename or a move: it is hashed from the file's bytes and
    /// the material's index, never from its path. See [`brush_id`].
    pub id: String,
    pub name: String,
    /// 8-bit greyscale PNG, ink at 255, which is the tip's alpha.
    pub tip_png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source: BrushSource,
    /// Mean absolute difference from CSP's preview, 0-255. Absent for a tip
    /// that had nothing to be graded against.
    pub diff: Option<f32>,
    pub settings: BrushSettings,
}

/// One path that yielded nothing, and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub error: String,
}

/// What one `brush_import` call produced.
///
/// Brushes and failures come back together rather than as an `Err`: importing
/// six files of which one is a JPEG must install the five, and the picker's
/// toast needs to say so. Only the command's own machinery can fail the call.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub brushes: Vec<ImportedBrush>,
    pub errors: Vec<ImportFailure>,
}

/// Side of the round tip drawn when a file has no tip image. Large enough that
/// the engine scales it down rather than up at ordinary brush sizes.
const ROUND_TIP_PX: u32 = 64;

/// 128-bit FNV-1a, whose constants are fixed by the specification.
///
/// A brush id has to survive an app update, so it cannot come from
/// `DefaultHasher`, whose output Rust is explicitly free to change between
/// releases. FNV is a few lines, is the same everywhere forever, and a personal
/// brush library is nowhere near the size where 128 bits collide.
const FNV_OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
const FNV_PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;

fn fnv1a(mut h: u128, bytes: &[u8]) -> u128 {
    for &b in bytes {
        h = (h ^ b as u128).wrapping_mul(FNV_PRIME);
    }
    h
}

/// The hash of a file's contents, read in chunks so a large `.sut` is never
/// held whole just to be hashed.
fn hash_file(path: &Path) -> std::io::Result<u128> {
    let mut f = std::fs::File::open(path)?;
    let mut h = FNV_OFFSET;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(h);
        }
        h = fnv1a(h, &buf[..n]);
    }
}

/// A brush id from the source file's hash and the material's index.
///
/// Deliberately not a function of the path: a letterer who renames or moves the
/// `.sut` they imported from still has the same brush, and a project that
/// stored the id still finds it.
fn brush_id(file_hash: u128, index: usize) -> String {
    format!("{:032x}", fnv1a(file_hash, &(index as u64).to_le_bytes()))
}

/// A soft round tip, the way CSP builds one from `BrushHardness`.
///
/// Opaque out to `hardness` percent of the radius, then a linear ramp to
/// nothing at the edge. The core is held a pixel inside the rim even at
/// hardness 100 so the circle is always antialiased rather than stair-stepped.
fn round_tip(hardness: f32) -> GrayImage {
    let n = ROUND_TIP_PX;
    let r = n as f32 / 2.0;
    let core = ((hardness.clamp(0.0, 100.0) / 100.0) * r).min(r - 1.0).max(0.0);
    let mut px = vec![0u8; (n * n) as usize];
    for y in 0..n {
        for x in 0..n {
            let dx = x as f32 + 0.5 - r;
            let dy = y as f32 + 0.5 - r;
            let d = (dx * dx + dy * dy).sqrt();
            let a = if d <= core {
                1.0
            } else if d >= r {
                0.0
            } else {
                1.0 - (d - core) / (r - core)
            };
            px[(y * n + x) as usize] = (a * 255.0).round() as u8;
        }
    }
    // The dimensions are this function's own, so the buffer always fits.
    GrayImage::from_raw(n, n, px).expect("a n*n buffer is an n by n image")
}

/// An 8-bit greyscale PNG of a tip mask.
///
/// `CompressionType::Fast`: the largest tip in the corpus is 2352 x 11394, and
/// the extra seconds of deflate buy a file the library writes once and reads
/// from disk forever after.
fn encode_png(img: &GrayImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::L8)
        .map_err(|e| format!("the tip could not be encoded: {e}"))?;
    Ok(out)
}

/// Reads a brush file at `path`, or says why it could not.
///
/// The extension picks the parser, because the two formats share nothing but
/// their purpose: a `.sut` is a SQLite database and an `.abr` is a big-endian
/// record stream. Anything else is reported rather than sniffed - a file the
/// letterer did not mean to import is a line in the toast, not a parse attempt.
pub fn import_file(path: &Path) -> Result<Vec<ImportedBrush>, String> {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "brush".to_owned());

    let hash = hash_file(path).map_err(|e| format!("the file could not be read: {e}"))?;

    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "sut" => import_sut(path, stem, hash),
        "abr" => import_abr(path, stem, hash),
        _ => Err("not a Clip Studio or Photoshop brush: a .sut or .abr file was expected".into()),
    }
}

/// Reads a `.sut`, or says why it could not.
///
/// The ladder, per material: the pixels if they matched CSP's own preview, else
/// that preview, else - for a brush with no pattern image at all - a round tip
/// drawn from `BrushHardness`. The first two rungs are [`score::Scorer`]'s; the
/// third is here, because it is the only one that invents anything.
fn import_sut(path: &Path, stem: String, hash: u128) -> Result<Vec<ImportedBrush>, String> {
    let con = sut::open_read_only(path).map_err(|e| format!("not a Clip Studio brush: {e}"))?;
    // SQLite opens lazily, so a JPEG opens fine and only fails on the first
    // read. This is that read, and it is also the check that the tables a `.sut`
    // has are the tables this file has.
    let tables: i64 = con
        .query_row(
            "select count(*) from sqlite_master where type = 'table' \
             and name in ('Variant', 'Node', 'MaterialFile')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("not a Clip Studio brush: {e}"))?;
    if tables == 0 {
        return Err("not a Clip Studio brush: no Variant, Node or MaterialFile table".into());
    }

    let meta = variant::read(&con);
    // The connection is not needed past here, and the parser opens its own.
    drop(con);

    let materials = sut::materials_from_sut(path);
    let base = meta.name.clone().unwrap_or(stem);
    // A file holding several materials is one sub tool with several pattern
    // images, so they share the sub tool's name and are told apart by number.
    let numbered = materials.len() > 1;
    let name_at = |i: usize| if numbered { format!("{base} {}", i + 1) } else { base.clone() };

    let mut out = Vec::new();
    if materials.is_empty() {
        // No material rows at all. For a brush with no pattern image that is
        // correct and the round tip is the whole brush; for anything else it is
        // still better than refusing the file, and the source says which.
        out.push(round_brush(brush_id(hash, 0), base, &meta.settings)?);
        return Ok(out);
    }
    for m in materials {
        let id = brush_id(hash, m.index);
        let name = name_at(m.index);
        match m.tip {
            Some(tip) => out.push(ImportedBrush {
                id,
                name,
                width: tip.image.width(),
                height: tip.image.height(),
                tip_png: encode_png(&tip.image)?,
                source: tip.source.into(),
                diff: tip.diff,
                settings: meta.settings.clone(),
            }),
            None => out.push(round_brush(id, name, &meta.settings)?),
        }
    }
    Ok(out)
}

/// Reads an `.abr`, or says why it could not.
///
/// Photoshop ships no preview inside the file, so there is nothing to grade a
/// reading against and nothing to fall back to: a tip that passes [`abr`]'s
/// structural checks is pixel source with no `diff`, and one that does not is
/// simply not there. A file whose brushes all failed comes back as this file's
/// one error, the way an unreadable `.sut` does.
fn import_abr(path: &Path, stem: String, hash: u128) -> Result<Vec<ImportedBrush>, String> {
    let found = abr::brushes(path)?;
    // As with a `.sut` holding several materials: one file, one name, told
    // apart by number - except where Photoshop named the brush itself.
    let numbered = found.len() > 1;
    let mut out = Vec::with_capacity(found.len());
    for (index, brush) in found.into_iter().enumerate() {
        let name = brush
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                if numbered {
                    format!("{stem} {}", index + 1)
                } else {
                    stem.clone()
                }
            });
        out.push(ImportedBrush {
            id: brush_id(hash, index),
            name,
            width: brush.image.width(),
            height: brush.image.height(),
            tip_png: encode_png(&brush.image)?,
            source: BrushSource::Pixels,
            diff: None,
            settings: brush.settings.over(BrushSettings::default()),
        });
    }
    Ok(out)
}

/// The bottom rung: a brush whose tip this build drew.
fn round_brush(id: String, name: String, settings: &BrushSettings) -> Result<ImportedBrush, String> {
    let image = round_tip(settings.hardness);
    Ok(ImportedBrush {
        id,
        name,
        width: image.width(),
        height: image.height(),
        tip_png: encode_png(&image)?,
        source: BrushSource::Round,
        diff: None,
        settings: settings.clone(),
    })
}

/// Import every path, keeping what worked and reporting what did not.
///
/// The `Err` arm is for the command's own machinery only - a blocking task that
/// failed to join. Nothing a file contains can reach it.
#[tauri::command]
pub async fn brush_import(paths: Vec<String>) -> Result<ImportResult, String> {
    // Parsing is CPU-bound and a corpus-sized import is seconds of it, so it
    // does not run on the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = ImportResult::default();
        for path in paths {
            match import_file(Path::new(&path)) {
                Ok(brushes) => result.brushes.extend(brushes),
                Err(error) => result.errors.push(ImportFailure { path, error }),
            }
        }
        result
    })
    .await
    .map_err(|e| format!("the import task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

    /// `(width, height, bit depth, colour type)` out of a PNG's IHDR, or `None`
    /// when the bytes are not a PNG. Cheaper than decoding 124 tips of up to
    /// 27 megapixels, and it is the header that has to agree with the struct.
    fn ihdr(png: &[u8]) -> Option<(u32, u32, u8, u8)> {
        if png.get(..8)? != b"\x89PNG\r\n\x1a\n" || png.get(12..16)? != b"IHDR" {
            return None;
        }
        let n = |o: usize| -> Option<u32> {
            Some(u32::from_be_bytes(png.get(o..o + 4)?.try_into().ok()?))
        };
        Some((n(16)?, n(20)?, *png.get(24)?, *png.get(25)?))
    }

    #[test]
    fn an_id_follows_the_bytes_and_the_index_and_nothing_else() {
        let a = fnv1a(FNV_OFFSET, b"the same brush file");
        let b = fnv1a(FNV_OFFSET, b"a different brush file");
        assert_eq!(brush_id(a, 3), brush_id(a, 3), "same bytes, same index, same id");
        assert_ne!(brush_id(a, 3), brush_id(a, 4), "a second material is a second brush");
        assert_ne!(brush_id(a, 0), brush_id(b, 0), "different files are different brushes");
        assert_eq!(brush_id(a, 0).len(), 32, "128 bits of hex");
        assert!(brush_id(a, 0).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_same_file_under_a_different_name_keeps_its_ids() {
        let dir = std::env::temp_dir().join(format!("mt-brush-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let one = dir.join("Battle Letter Pen.sut");
        let two = dir.join("renamed.sut");
        std::fs::write(&one, b"pretend this is a .sut").unwrap();
        std::fs::copy(&one, &two).unwrap();
        assert_eq!(hash_file(&one).unwrap(), hash_file(&two).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hard_round_tip_is_solid_in_the_middle_and_clear_outside_it() {
        let hard = round_tip(100.0);
        assert_eq!(hard.dimensions(), (ROUND_TIP_PX, ROUND_TIP_PX));
        let mid = ROUND_TIP_PX / 2;
        assert_eq!(hard.get_pixel(mid, mid).0[0], 255, "the centre is full ink");
        assert_eq!(hard.get_pixel(0, 0).0[0], 0, "the corner is outside the circle");
        // Even at hardness 100 the rim is a ramp, not a staircase.
        let rim = hard.get_pixel(mid, 0).0[0];
        assert!(rim > 0 && rim < 255, "the rim is antialiased, got {rim}");
    }

    #[test]
    fn a_soft_round_tip_falls_off_from_the_middle() {
        let soft = round_tip(0.0);
        let mid = ROUND_TIP_PX / 2;
        // Not quite 255: with no core at all the ramp starts at the very centre.
        assert!(soft.get_pixel(mid, mid).0[0] >= 245, "the centre is nearly full ink");
        let half = soft.get_pixel(mid, ROUND_TIP_PX / 4).0[0];
        assert!((100..=160).contains(&half), "halfway out is about half ink, got {half}");
        assert!(half > soft.get_pixel(mid, 1).0[0], "and thinner still nearer the rim");
    }

    #[test]
    fn a_tip_encodes_to_an_eight_bit_greyscale_png() {
        let png = encode_png(&round_tip(100.0)).unwrap();
        // Colour type 0 is greyscale; anything else would not be an alpha mask.
        assert_eq!(ihdr(&png), Some((ROUND_TIP_PX, ROUND_TIP_PX, 8, 0)));
        let back = image::load_from_memory(&png).unwrap().to_luma8();
        assert_eq!(back.as_raw(), round_tip(100.0).as_raw());
    }

    /// The shape `brush-library.svelte.js` reads. Pinned because it is a
    /// contract across the Tauri boundary, where a renamed field is not a
    /// compile error but a brush that silently loses a setting.
    #[test]
    fn the_json_the_library_receives_is_camel_case_and_complete() {
        let brush = round_brush("abc".into(), "round".into(), &BrushSettings::default()).unwrap();
        let v = serde_json::to_value(ImportResult {
            brushes: vec![brush],
            errors: vec![ImportFailure { path: "/tmp/x.jpg".into(), error: "not a .sut".into() }],
        })
        .unwrap();

        let b = &v["brushes"][0];
        let mut keys: Vec<&str> = b.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["diff", "height", "id", "name", "settings", "source", "tipPng", "width"]
        );
        assert_eq!(b["source"], "round");
        assert!(b["diff"].is_null());

        let mut set: Vec<&str> =
            b["settings"].as_object().unwrap().keys().map(|k| k.as_str()).collect();
        set.sort();
        assert_eq!(
            set,
            [
                "angle",
                "angleJitter",
                "antialias",
                "flatness",
                "hardness",
                "opacity",
                "sharpAngles",
                "size",
                "spacing",
                "stabilise",
                "taperIn",
                "taperOut",
                "waterEdge",
                "waterEdgePower",
                "waterEdgeWidth",
            ]
        );
        assert_eq!(b["settings"]["taperIn"]["on"], true);
        assert_eq!(b["settings"]["taperIn"]["len"], 20.0);
        assert_eq!(b["settings"]["taperIn"]["ratio"], 60.0);
        assert_eq!(b["settings"]["sharpAngles"]["deg"], 45.0);
        assert_eq!(v["errors"][0]["path"], "/tmp/x.jpg");
        assert_eq!(v["errors"][0]["error"], "not a .sut");
    }

    #[test]
    fn a_file_that_is_not_a_sut_is_reported_rather_than_thrown() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for bad in ["Cargo.toml", "no-such-file.sut", "no-such-file.abr"] {
            let err = import_file(&manifest.join(bad)).unwrap_err();
            assert!(!err.is_empty(), "{bad} came back with an empty reason");
        }
        // The dispatch names both formats, because either is now a file the
        // letterer could reasonably have picked.
        let err = import_file(&manifest.join("Cargo.toml")).unwrap_err();
        assert!(err.contains(".sut") && err.contains(".abr"), "the reason was {err}");
    }

    /// A two-brush `.abr` in a temp file: one RLE tip with settings in the
    /// descriptor, one raw tip with none.
    fn temp_abr(dir: &Path) -> PathBuf {
        use abr::fixture::{self, DescBrush, Tip};
        let mut inked = Tip::ink("", "tip-rle", 12, 9);
        inked.rle = true;
        let plain = Tip::ink("", "tip-raw", 5, 5);
        let mut named = DescBrush::new(Some("tip-rle"));
        named.name = Some("Sumi Round".into());
        named.diameter = Some(88.0);
        named.spacing = Some(15.0);
        named.angle = Some(45.0);
        named.roundness = Some(60.0);
        named.hardness = Some(70.0);
        let bytes = fixture::v6(6, 2, &[inked, plain], Some(&[named]));
        let path = dir.join("Inky Set.abr");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn an_abr_file_arrives_through_the_same_command_the_sut_files_do() {
        let dir = std::env::temp_dir().join(format!("mt-abr-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = temp_abr(&dir);

        let result = tauri::async_runtime::block_on(brush_import(vec![
            path.to_string_lossy().into_owned(),
            dir.join("not-a-brush.abr").to_string_lossy().into_owned(),
        ]))
        .unwrap();

        assert_eq!(result.errors.len(), 1, "only the missing path failed");
        assert_eq!(result.brushes.len(), 2);
        let ids: std::collections::HashSet<&String> = result.brushes.iter().map(|b| &b.id).collect();
        assert_eq!(ids.len(), 2, "two brushes, two ids");
        for b in &result.brushes {
            assert_eq!(b.source, BrushSource::Pixels, "an .abr tip is never a fallback");
            assert_eq!(b.diff, None, "there is no preview in the file to grade against");
            assert_eq!(b.id.len(), 32);
            assert_eq!(ihdr(&b.tip_png), Some((b.width, b.height, 8, 0)));
            assert!(image::load_from_memory(&b.tip_png).is_ok(), "the PNG decodes");
        }

        // The first tip is the one the descriptor named, in its own units; the
        // second was unnamed and falls back to the file's stem plus its number.
        let named = &result.brushes[0];
        assert_eq!(named.name, "Sumi Round");
        assert_eq!((named.width, named.height), (12, 9));
        assert_eq!(named.settings.size, 88.0);
        assert_eq!(named.settings.spacing, 15.0);
        assert_eq!(named.settings.angle, 45.0);
        assert_eq!(named.settings.flatness, 0.6);
        assert_eq!(named.settings.hardness, 70.0);
        // Nothing an .abr cannot speak for moved off the engine's own default.
        let d = BrushSettings::default();
        assert_eq!(named.settings.taper_in, d.taper_in);
        assert_eq!(named.settings.taper_out, d.taper_out);
        assert_eq!(named.settings.water_edge, d.water_edge);
        assert_eq!(named.settings.stabilise, d.stabilise);
        assert_eq!(named.settings.opacity, d.opacity);

        assert_eq!(result.brushes[1].name, "Inky Set 2");
        assert_eq!(result.brushes[1].settings, d, "no descriptor entry, no settings");

        // The id follows the bytes, so the same file under another name keeps
        // the brushes the library already installed.
        let moved = dir.join("renamed.abr");
        std::fs::copy(&path, &moved).unwrap();
        let again = import_file(&moved).unwrap();
        assert_eq!(again[0].id, result.brushes[0].id);
        assert_eq!(again[0].name, "Sumi Round", "a named brush ignores the stem");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_abr_holding_nothing_readable_is_one_error_beside_the_good_files() {
        let dir = std::env::temp_dir().join(format!("mt-abr-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("junk.abr");
        std::fs::write(&bad, b"this is a JPEG, honest").unwrap();
        let good = temp_abr(&dir);

        let result = tauri::async_runtime::block_on(brush_import(vec![
            bad.to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
        ]))
        .unwrap();
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].path, bad.to_string_lossy());
        assert!(!result.errors[0].error.is_empty());
        assert_eq!(result.brushes.len(), 2, "the readable set still imported");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_bad_path_does_not_cost_the_good_ones() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let good = corpus().into_iter().next().expect("the corpus is present");
        let paths = vec![
            manifest.join("Cargo.toml").to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
            manifest.join("no-such-file.sut").to_string_lossy().into_owned(),
        ];
        let mut result = ImportResult::default();
        for path in paths {
            match import_file(Path::new(&path)) {
                Ok(b) => result.brushes.extend(b),
                Err(error) => result.errors.push(ImportFailure { path, error }),
            }
        }
        assert_eq!(result.errors.len(), 2);
        assert!(!result.brushes.is_empty(), "the one real file still imported");
    }

    #[test]
    fn a_brush_with_no_pattern_image_still_arrives_as_a_round_tip() {
        // The one corpus file with `BrushUsePatternImage = 0`: it has no
        // `MaterialFile` table at all, so there is nothing to extract and the
        // bottom rung of the ladder is what it must land on.
        let path = corpus()
            .into_iter()
            .find(|p| p.file_stem().is_some_and(|s| s == "5d5136e19ee3f431"))
            .expect("the no-pattern-image brush is in the corpus");
        let brushes = import_file(&path).unwrap();
        assert_eq!(brushes.len(), 1);
        assert_eq!(brushes[0].source, BrushSource::Round);
        assert_eq!(brushes[0].diff, None);
        assert_eq!((brushes[0].width, brushes[0].height), (ROUND_TIP_PX, ROUND_TIP_PX));
        assert_eq!(brushes[0].name, "バトル文字ペン", "the name came from the Node table");
    }

    #[test]
    fn every_corpus_brush_imports_with_settings_and_a_readable_tip() {
        let files = corpus();
        assert_eq!(files.len(), 64, "the corpus is 64 .sut files under external/");

        let mut brushes = 0;
        let mut pixels = 0;
        let mut round = 0;
        let mut ids: Vec<String> = Vec::new();
        let mut png_bytes = 0usize;
        let mut widest = 0u32;
        for path in &files {
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let imported = import_file(path)
                .unwrap_or_else(|e| panic!("{name}: the corpus must import clean, got {e}"));
            assert!(!imported.is_empty(), "{name}: yielded no brush at all");
            for b in imported {
                brushes += 1;
                png_bytes += b.tip_png.len();
                widest = widest.max(b.width);
                match b.source {
                    BrushSource::Pixels => pixels += 1,
                    BrushSource::Round => round += 1,
                    BrushSource::Thumbnail => {
                        panic!("{name}: fell back to the preview")
                    }
                }
                assert_eq!(
                    ihdr(&b.tip_png),
                    Some((b.width, b.height, 8, 0)),
                    "{name}: the tip is not an 8-bit greyscale PNG matching its size"
                );
                assert!(b.width > 0 && b.height > 0, "{name}: an empty tip");
                assert!(!b.name.trim().is_empty(), "{name}: an unnamed brush");
                assert!(b.settings.size >= 1.0, "{name}: size {}", b.settings.size);
                assert!((0.0..=1.0).contains(&b.settings.opacity));
                assert!((0.0..=100.0).contains(&b.settings.hardness));
                assert!((0.0..360.0).contains(&b.settings.angle));
                assert!((0.05..=1.0).contains(&b.settings.flatness));
                assert!((1.0..=20.0).contains(&b.settings.water_edge_width));
                assert!((0.0..=1.0).contains(&b.settings.water_edge_power));
                assert!((0.0..=100.0).contains(&b.settings.stabilise));
                ids.push(b.id);
            }
        }

        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "two brushes claimed the same id");
        assert_eq!(pixels, 124, "124 tips at pixel source, as phase 2.1 measured");
        assert_eq!(round, 1, "the one BrushUsePatternImage = 0 brush");
        assert_eq!(brushes, 125);
        println!(
            "corpus: {} files, {brushes} brushes ({pixels} pixels, {round} round), \
             {} MB of PNG, widest tip {widest} px",
            files.len(),
            png_bytes / 1_000_000
        );
    }
}
