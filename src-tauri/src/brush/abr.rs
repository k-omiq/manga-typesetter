//! Photoshop `.abr` brush files: the sampled tips and the settings beside them.
//!
//! Three shapes exist in the wild and this module reads two of them:
//!
//! * **v1 / v2** - big-endian `version`, `count`, then one record per brush.
//!   A record is `type` (1 computed, 2 sampled) and a block length, and a
//!   sampled block carries misc/spacing, a name (v2 only), the tip's bounds,
//!   its depth, and either raw or PackBits-per-scanline pixels.
//! * **v6 / v7 / v10** - `major`, `minor`, then 8BIM sections (`8BIM` + a
//!   four-character key + a big-endian length). `samp` holds the tip bitmaps,
//!   one length-prefixed block each, padded to four; `desc` holds a standard
//!   Photoshop descriptor with the per-brush settings.
//!
//! Computed brushes (type 1, and the `desc` entries with no sampled data) are
//! skipped by design: they have no stored bitmap, and the round tip the ladder
//! draws for a `.sut` with no pattern image would be a guess at a parametric
//! shape this build does not model. 16-bit tips are skipped for the same
//! reason - nothing above this module reads more than 8 bits per pixel.
//!
//! Unlike a `.sut`, an `.abr` ships no preview, so there is no answer key to
//! score a reading against (see [`super::score`]). Validation is structural
//! instead: the depth must be 8, the bounds must describe a non-empty image
//! inside this build's ceilings, the pixels must decompress to exactly
//! `width * height`, and a PackBits row must end exactly on the row's width
//! without reading past its own compressed length. A brush that fails any of
//! those is skipped; a file that yields no brush at all is one error on the
//! import's per-file error path, never a panic.
//!
//! Where the format is under-documented the uncertainty is encoded as
//! tolerance rather than as a constant: the id string in front of a `samp`
//! block and the legacy field behind it are read as a small ordered set of
//! candidate offsets, and the first one whose tip decodes cleanly is the one
//! that was right. Every offset and length is checked arithmetic over a
//! bounds-checked slice, and every ceiling is applied before the allocation it
//! guards.

use std::path::Path;

use image::GrayImage;

use super::variant::BrushSettings;

/// Biggest file this build will read into memory. An `.abr` is a brush set, not
/// a document; the largest published sets are tens of megabytes.
const MAX_FILE_BYTES: u64 = 1 << 28;

/// Biggest tip this build will allocate for, mirroring `sut.rs`'s
/// `MAX_PLANE_PIXELS` so both parsers refuse the same absurd header. The
/// largest real tip measured in the `.sut` corpus is 2352 x 11394.
const MAX_TIP_PIXELS: u64 = 1 << 28;

/// Ceiling on the brushes one file may yield, and on the items one descriptor
/// may hold. Both are counts read straight out of the file, so both are capped
/// before anything is reserved for them.
const MAX_BRUSHES: usize = 4096;
const MAX_ITEMS: usize = 4096;

/// A descriptor key or an id string longer than this is damage, not a name.
const MAX_KEY_BYTES: usize = 1024;

/// A descriptor string longer than this is damage too. Counted in UTF-16 code
/// units, which is what the length field counts.
const MAX_STR_CHARS: usize = 1 << 16;

/// How deep a descriptor may nest before this parser stops following it. The
/// descriptor walk is recursive and the nesting comes from the file, so the
/// depth is bounded rather than trusted.
const MAX_DESC_DEPTH: u32 = 32;

/// Size ceiling in px, and the spacing window, both matching what the rest of
/// the import already promises: `variant.rs` caps a `.sut`'s size at 1000 px
/// ("already a stroke as wide as a page"), and `sanitiseBrushSettings` in
/// `brush-library.svelte.js` clamps spacing to 1-200.
const MAX_SIZE_PX: f64 = 1000.0;
const MIN_SPACING: f64 = 1.0;
const MAX_SPACING: f64 = 200.0;

/// One sampled brush read out of an `.abr`.
#[derive(Debug, Clone)]
pub struct AbrBrush {
    /// The brush's own name, when the file carried one.
    pub name: Option<String>,
    /// 8-bit mask, 255 where the brush marks - the same polarity the `.sut`
    /// path ships.
    pub image: GrayImage,
    pub settings: AbrSettings,
}

/// The settings an `.abr` can answer for, each absent when the file did not say.
///
/// Deliberately partial: Photoshop's descriptor has no taper, no watercolour
/// edge and no stabilisation, so those keep [`BrushSettings::default`] rather
/// than being invented. Applied with [`AbrSettings::over`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AbrSettings {
    /// Page px, from `Dmtr` (a `UntF` in `#Pxl`).
    pub size: Option<f32>,
    /// Percent of the tip's size between stamps, from `Spcn` (`#Prc`).
    pub spacing: Option<f32>,
    /// Degrees, from `Angl` (`#Ang`), folded into one turn.
    pub angle: Option<f32>,
    /// Tip squash, 0.05-1, from `Rndn` (roundness as a percent).
    pub flatness: Option<f32>,
    /// 0-100, from `Hrdn` (`#Prc`).
    pub hardness: Option<f32>,
}

impl AbrSettings {
    /// These settings over a base, which is how a Photoshop brush arrives with
    /// the engine's own defaults for everything Photoshop did not say.
    pub fn over(&self, base: BrushSettings) -> BrushSettings {
        BrushSettings {
            size: self.size.unwrap_or(base.size),
            spacing: self.spacing.unwrap_or(base.spacing),
            angle: self.angle.unwrap_or(base.angle),
            flatness: self.flatness.unwrap_or(base.flatness),
            hardness: self.hardness.unwrap_or(base.hardness),
            ..base
        }
    }
}

/// Every sampled brush in the `.abr` at `path`, or why there were none.
///
/// The `Err` arm is the import's per-file error: a file that is not an `.abr`,
/// one this build cannot read a version number out of, and one whose brushes
/// all failed the structural checks all land there, and the rest of the import
/// carries on around it.
pub fn brushes(path: &Path) -> Result<Vec<AbrBrush>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("the file could not be read: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "the file is {} MB, past the {} MB a brush set is read at",
            meta.len() / 1_000_000,
            MAX_FILE_BYTES / 1_000_000
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("the file could not be read: {e}"))?;
    parse(&bytes)
}

/// The parser proper, over bytes already in memory.
pub fn parse(d: &[u8]) -> Result<Vec<AbrBrush>, String> {
    let mut r = Reader::new(d);
    let Some(major) = r.u16() else {
        return Err("not a Photoshop brush: the file is too short to hold a version".into());
    };
    let found = match major {
        1 | 2 => v12(d, major),
        // 6, 7 and 10 are the versions seen; the ones between share the layout,
        // and a file that does not is caught by the structural checks below
        // rather than by its version number.
        6..=10 => {
            // A minor other than 1 or 2 is read as 2, which only decides which
            // candidate header offset is tried first.
            let minor = r.u16().unwrap_or(2);
            v6(d, minor)
        }
        _ => {
            return Err(format!("not a Photoshop brush this build can read: version {major}"));
        }
    };
    if found.is_empty() {
        return Err("no sampled brush in the file this build could read".into());
    }
    Ok(found)
}

// --------------------------------------------------------------------------
// Bytes
// --------------------------------------------------------------------------

/// A cursor over the file's bytes. Every read is bounds-checked and every
/// offset is checked arithmetic, so a length out of a corrupt header ends a
/// read rather than indexing past the buffer.
struct Reader<'a> {
    d: &'a [u8],
    o: usize,
}

impl<'a> Reader<'a> {
    fn new(d: &'a [u8]) -> Self {
        Reader { d, o: 0 }
    }

    fn at(d: &'a [u8], o: usize) -> Self {
        Reader { d, o }
    }

    fn left(&self) -> usize {
        self.d.len().saturating_sub(self.o)
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.o.checked_add(n)?;
        let out = self.d.get(self.o..end)?;
        self.o = end;
        Some(out)
    }

    fn peek(&self, n: usize) -> Option<&'a [u8]> {
        self.d.get(self.o..self.o.checked_add(n)?)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes(self.take(2)?.try_into().ok()?))
    }

    fn i16(&mut self) -> Option<i16> {
        self.u16().map(|v| v as i16)
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }

    fn i32(&mut self) -> Option<i32> {
        self.u32().map(|v| v as i32)
    }

    fn f64(&mut self) -> Option<f64> {
        Some(f64::from_be_bytes(self.take(8)?.try_into().ok()?))
    }

    fn four(&mut self) -> Option<[u8; 4]> {
        self.take(4)?.try_into().ok()
    }
}

/// A Photoshop Unicode string: a count of UTF-16 code units, then that many
/// big-endian units, usually with a trailing null inside the count.
fn unicode(r: &mut Reader) -> Option<String> {
    let n = r.u32()? as usize;
    if n > MAX_STR_CHARS {
        return None;
    }
    let b = r.take(n.checked_mul(2)?)?;
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    Some(String::from_utf16_lossy(&units).trim_end_matches('\0').trim().to_owned())
}

/// A descriptor key: a length and that many bytes, where a length of zero means
/// the key is the four characters that follow.
fn key(r: &mut Reader) -> Option<String> {
    let n = r.u32()? as usize;
    let n = if n == 0 { 4 } else { n };
    if n > MAX_KEY_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(r.take(n)?).into_owned())
}

// --------------------------------------------------------------------------
// A sampled tip
// --------------------------------------------------------------------------

/// The tip whose header sits at `off`: bounds, depth, compression, pixels.
///
/// Returning `None` is how a candidate offset is rejected, so every check here
/// is also the structural validation the file gets: bounds that describe at
/// least one pixel and at most [`MAX_TIP_PIXELS`], a depth of exactly 8, a
/// known compression, and data that decodes to exactly `width * height`.
fn tip_at(block: &[u8], off: usize) -> Option<GrayImage> {
    let mut r = Reader::at(block, 0);
    r.skip(off)?;
    let top = r.i32()? as i64;
    let left = r.i32()? as i64;
    let bottom = r.i32()? as i64;
    let right = r.i32()? as i64;
    let w = right.checked_sub(left)?;
    let h = bottom.checked_sub(top)?;
    if w < 1 || h < 1 {
        return None;
    }
    // Widened to i64 before the multiply: both sides come straight out of the
    // file, and the product must be compared against the ceiling rather than
    // wrapped into it.
    if w.checked_mul(h)? as u64 > MAX_TIP_PIXELS {
        return None;
    }
    if depth(&mut r)? != 8 {
        // A 16-bit tip is skipped rather than truncated: nothing above this
        // module reads more than 8 bits per pixel.
        return None;
    }
    let compression = r.u8()?;
    let (w, h) = (usize::try_from(w).ok()?, usize::try_from(h).ok()?);
    let want = w.checked_mul(h)?;
    let px = match compression {
        0 => {
            if r.left() < want {
                return None;
            }
            r.take(want)?.to_vec()
        }
        1 => unpack(&mut r, w, h)?,
        _ => return None,
    };
    if px.len() != want {
        return None;
    }
    GrayImage::from_raw(w as u32, h as u32, as_ink(px, w, h))
}

/// The tip's bit depth. Photoshop writes it as a big-endian `i16`; a file that
/// wrote a four-byte one reads here as a zero followed by the real value, and
/// that is taken rather than refused.
fn depth(r: &mut Reader) -> Option<u16> {
    match r.u16()? {
        0 => r.u16(),
        v => Some(v),
    }
}

/// PackBits, one scanline at a time, the way Photoshop stores a compressed tip:
/// a table of `height` compressed row lengths, then the rows.
///
/// Bounded twice over. A row may only read the bytes its own declared length
/// covers, and may only write the `width` bytes of its own row: a run that
/// would overflow either end fails the whole tip rather than spilling into the
/// next row. A row that ends short of `width` fails too, because a tip that
/// decodes to less than its bounds is not a tip this build can trust.
fn unpack(r: &mut Reader, w: usize, h: usize) -> Option<Vec<u8>> {
    // The table is two bytes a row, so the buffer for it is only reserved once
    // the file has actually got that many bytes left to fill it with.
    if r.left() < h.checked_mul(2)? {
        return None;
    }
    let mut lens = Vec::with_capacity(h);
    for _ in 0..h {
        lens.push(r.u16()? as usize);
    }
    // PackBits cannot encode more than 128 pixels in two bytes, so a stream
    // shorter than this could never fill the image whatever it holds. Checked
    // before the image buffer is reserved, not after it is found wanting.
    let least = h.checked_mul(w.checked_add(127)? / 128 * 2)?;
    if r.left() < least {
        return None;
    }
    let mut out = vec![0u8; w.checked_mul(h)?];
    for (y, len) in lens.into_iter().enumerate() {
        let row = r.take(len)?;
        let dst = out.get_mut(y * w..(y + 1) * w)?;
        let mut i = 0usize;
        let mut written = 0usize;
        while i < row.len() {
            let n = row[i] as i8;
            i += 1;
            if n >= 0 {
                let count = n as usize + 1;
                let end = i.checked_add(count)?;
                let src = row.get(i..end)?;
                let at = written.checked_add(count)?;
                if at > w {
                    return None;
                }
                dst[written..at].copy_from_slice(src);
                written = at;
                i = end;
            } else if n != -128 {
                // -128 is a no-op in PackBits, not a run.
                let count = (-(n as i32)) as usize + 1;
                let v = *row.get(i)?;
                i += 1;
                let at = written.checked_add(count)?;
                if at > w {
                    return None;
                }
                dst[written..at].fill(v);
                written = at;
            }
        }
        if written != w {
            return None;
        }
    }
    Some(out)
}

/// The tip's pixels with ink at 255, whichever way round the file stored them.
///
/// Photoshop writes a sampled tip either as ink painted black on a white
/// ground or as a straight alpha mask, and the record says which nowhere. What
/// does say is the tip's own outermost ring: bounds are the ink's bounding box,
/// so the ring is background but for the few pixels the shape touches it at.
/// A ring that is mostly light is therefore a white ground and the image is
/// inverted; a ring that is mostly dark is already alpha and is left alone. A
/// tip inked solid to all four edges would be read the wrong way round, and no
/// brush tip in any format seen is one.
fn as_ink(mut px: Vec<u8>, w: usize, h: usize) -> Vec<u8> {
    let mut light = 0u64;
    let mut total = 0u64;
    let mut tally = |v: u8| {
        total += 1;
        if v > 127 {
            light += 1;
        }
    };
    for x in 0..w {
        tally(px[x]);
        if h > 1 {
            tally(px[(h - 1) * w + x]);
        }
    }
    for y in 1..h.saturating_sub(1) {
        tally(px[y * w]);
        if w > 1 {
            tally(px[y * w + w - 1]);
        }
    }
    if total > 0 && light * 2 > total {
        px.iter_mut().for_each(|p| *p = 255 - *p);
    }
    px
}

// --------------------------------------------------------------------------
// v1 and v2
// --------------------------------------------------------------------------

/// Every sampled brush of a v1 or v2 file.
fn v12(d: &[u8], version: u16) -> Vec<AbrBrush> {
    let mut r = Reader::new(d);
    let mut out = Vec::new();
    if r.skip(2).is_none() {
        return out;
    }
    let Some(count) = r.u16() else { return out };
    for _ in 0..(count as usize).min(MAX_BRUSHES) {
        let Some(kind) = r.i16() else { break };
        let Some(size) = r.i32() else { break };
        if size < 0 {
            break;
        }
        let start = r.o;
        // The declared block length is what walks the file, clamped to the
        // buffer: a length past the end is a truncated file, whose last block
        // is still worth reading before the walk stops.
        let end = match start.checked_add(size as usize) {
            Some(e) if e <= d.len() => e,
            _ => d.len(),
        };
        // Type 1 is a computed brush, which stores no bitmap: skipped by design.
        if kind == 2 {
            if let Some(b) = sampled_v12(d.get(start..end).unwrap_or_default(), version) {
                out.push(b);
            }
        }
        if end <= start {
            break;
        }
        r.o = end;
    }
    out
}

/// One sampled v1/v2 block: misc, spacing, a v2 name, then the tip.
///
/// Between the name and the bounds sit an antialiasing byte and a set of
/// 16-bit bounds that duplicate the 32-bit ones. Files disagree about whether
/// both are present, so the header offset is a short ordered list of candidates
/// and the first one whose tip decodes is taken - which also means a name read
/// out of a field that was not really there cannot be shipped, because the
/// offsets behind it will not decode.
fn sampled_v12(block: &[u8], version: u16) -> Option<AbrBrush> {
    let mut r = Reader::new(block);
    r.skip(4)?; // misc
    let spacing = r.i16()? as f64;
    let mut candidates: Vec<(Option<String>, usize)> = Vec::new();
    if version >= 2 {
        let mut nr = Reader::at(block, r.o);
        if let Some(name) = unicode(&mut nr) {
            candidates.push((Some(name).filter(|n| !n.is_empty()), nr.o));
        }
    }
    candidates.push((None, r.o));
    for (name, base) in candidates {
        // The antialiasing byte plus four 16-bit bounds, then the byte alone,
        // then neither.
        for extra in [9usize, 1, 0] {
            let Some(off) = base.checked_add(extra) else { continue };
            if let Some(image) = tip_at(block, off) {
                return Some(AbrBrush {
                    name,
                    image,
                    settings: AbrSettings {
                        spacing: (spacing > 0.0)
                            .then(|| spacing.clamp(MIN_SPACING, MAX_SPACING) as f32),
                        ..AbrSettings::default()
                    },
                });
            }
        }
    }
    None
}

// --------------------------------------------------------------------------
// v6 and later: 8BIM sections
// --------------------------------------------------------------------------

/// Every sampled brush of a v6/v7/v10 file, paired with its descriptor entry.
fn v6(d: &[u8], minor: u16) -> Vec<AbrBrush> {
    let mut r = Reader::new(d);
    let mut tips: Vec<(Option<String>, GrayImage)> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    if r.skip(4).is_none() {
        return Vec::new();
    }
    while r.left() >= 12 {
        let Some(tag) = r.four() else { break };
        if &tag != b"8BIM" {
            break;
        }
        let Some(name) = r.four() else { break };
        let Some(len) = r.u32() else { break };
        let Some(body) = r.take(len as usize) else { break };
        match &name {
            b"samp" => tips.extend(samp(body, minor)),
            b"desc" => entries.extend(desc(body)),
            _ => {}
        }
        // Sections are padded to an even length. The pad is only stepped over
        // when the next four bytes are not already a section tag, so a writer
        // that did not pad is followed too.
        if len % 2 == 1 && r.peek(4) != Some(&b"8BIM"[..]) {
            let _ = r.skip(1);
        }
    }
    pair(tips, entries)
}

/// The tips of one `samp` section, in file order, each with the id string it
/// was filed under when that could be read.
fn samp(body: &[u8], minor: u16) -> Vec<(Option<String>, GrayImage)> {
    let mut r = Reader::new(body);
    let mut out = Vec::new();
    while r.left() >= 4 && out.len() < MAX_BRUSHES {
        let Some(len) = r.u32() else { break };
        let len = len as usize;
        let Some(block) = r.take(len) else { break };
        // Blocks are padded out to a multiple of four. A last block that is not
        // padded simply ends the walk on the next turn.
        let _ = r.skip((4 - (len % 4)) % 4);
        if let Some(tip) = sampled_v6(block, minor) {
            out.push(tip);
        }
    }
    out
}

/// One `samp` block: an id string, a legacy field on some writers, then the
/// tip.
///
/// The id's encoding and the legacy field's size are the two details the format
/// notes are least sure of, so both are candidates rather than constants. The
/// tip decoder is the judge: it demands a depth of exactly 8, a known
/// compression, sane bounds and an exact decode, which no wrong offset in a
/// real file has to spare.
fn sampled_v6(block: &[u8], minor: u16) -> Option<(Option<String>, GrayImage)> {
    // Minor 1 writes a fixed legacy name field in front of the bounds; minor 2
    // does not. The other size is what GIMP's reader steps over, kept as a last
    // candidate rather than as a claim.
    let skips: [usize; 3] = if minor == 1 { [264, 0, 47] } else { [0, 264, 47] };
    for (id, after) in ids(block) {
        for extra in skips {
            let Some(off) = after.checked_add(extra) else { continue };
            if let Some(image) = tip_at(block, off) {
                return Some((id, image));
            }
        }
    }
    None
}

/// Candidate readings of the id string a `samp` block opens with, in the order
/// they are tried: a Pascal string, a four-byte-length string, or no id at all.
fn ids(block: &[u8]) -> Vec<(Option<String>, usize)> {
    let mut out = Vec::new();
    let mut push = |at: usize, n: usize| {
        if n > MAX_KEY_BYTES {
            return;
        }
        let Some(end) = at.checked_add(n) else { return };
        let Some(s) = block.get(at..end) else { return };
        if !s.is_empty() && s.iter().all(|c| (0x20..=0x7E).contains(c)) {
            out.push((Some(String::from_utf8_lossy(s).into_owned()), end));
        }
    };
    if let Some(&n) = block.first() {
        push(1, n as usize);
    }
    if let Some(n) = block.get(..4).and_then(|b| b.try_into().ok()).map(u32::from_be_bytes) {
        push(4, n as usize);
    }
    out.push((None, 0));
    out
}

/// Tips and descriptor entries as one list of brushes.
///
/// A `desc` entry names the tip it belongs to in `sampledData`, so pairing is
/// by that id where both sides have it. Where they do not - a writer that left
/// the id off, or a set whose entries this build could only partly read - the
/// fallback is document order, which is the order both sections are written in.
fn pair(tips: Vec<(Option<String>, GrayImage)>, entries: Vec<Entry>) -> Vec<AbrBrush> {
    tips.into_iter()
        .enumerate()
        .map(|(i, (id, image))| {
            let entry = id
                .as_deref()
                .and_then(|id| entries.iter().find(|e| e.id.as_deref() == Some(id)))
                .or_else(|| entries.get(i));
            AbrBrush {
                name: entry.and_then(|e| e.name.clone()),
                image,
                settings: entry.map(|e| e.settings.clone()).unwrap_or_default(),
            }
        })
        .collect()
}

// --------------------------------------------------------------------------
// The `desc` section: a Photoshop descriptor
// --------------------------------------------------------------------------

/// One value inside a descriptor. Types this build does not read are kept as
/// [`Value::Skipped`] so the item stream stays aligned behind them.
#[derive(Debug, Clone)]
enum Value {
    Desc(Descriptor),
    List(Vec<Value>),
    Num(f64),
    /// A unit float: its four-character unit and its value.
    Unit(String, f64),
    Text(String),
    Skipped,
}

#[derive(Debug, Clone, Default)]
struct Descriptor {
    items: Vec<(String, Value)>,
}

impl Descriptor {
    fn get(&self, k: &str) -> Option<&Value> {
        self.items.iter().find(|(key, _)| key == k).map(|(_, v)| v)
    }

    fn text(&self, k: &str) -> Option<String> {
        match self.get(k)? {
            Value::Text(t) if !t.trim().is_empty() => Some(t.trim().to_owned()),
            _ => None,
        }
    }

    /// A finite number, whatever numeric shape it was written in.
    fn num(&self, k: &str) -> Option<f64> {
        let v = match self.get(k)? {
            Value::Num(v) => *v,
            Value::Unit(_, v) => *v,
            _ => return None,
        };
        v.is_finite().then_some(v)
    }

    /// Whether a key was written as a percentage.
    fn is_percent(&self, k: &str) -> bool {
        matches!(self.get(k), Some(Value::Unit(u, _)) if u == "#Prc")
    }
}

/// The descriptor of a `desc` section, as the brush entries inside it.
fn desc(body: &[u8]) -> Vec<Entry> {
    // The section opens with a descriptor version, which is 16 in every file
    // seen. A file that skipped it is parsed from the front instead.
    for off in [4usize, 0] {
        let mut r = Reader::at(body, 0);
        if r.skip(off).is_none() {
            continue;
        }
        if let Some(d) = descriptor(&mut r, 0) {
            let mut out = Vec::new();
            walk(&d, None, &mut out);
            if !out.is_empty() {
                return out;
            }
        }
    }
    Vec::new()
}

/// A descriptor: a class name and id, an item count, then that many keyed
/// values. An item this parser cannot measure ends the list rather than
/// resuming at a guessed offset, so what was read before it is still kept.
fn descriptor(r: &mut Reader, depth: u32) -> Option<Descriptor> {
    if depth > MAX_DESC_DEPTH {
        return None;
    }
    unicode(r)?;
    key(r)?;
    let n = r.u32()? as usize;
    let mut items = Vec::new();
    for _ in 0..n.min(MAX_ITEMS) {
        let Some(k) = key(r) else { break };
        let Some(v) = value(r, depth + 1) else { break };
        items.push((k, v));
    }
    Some(Descriptor { items })
}

/// One typed value. `None` means the type carries a length this parser cannot
/// compute - an `obj ` reference, or something no version has shown yet - and
/// the only safe answer is to stop reading this item list.
fn value(r: &mut Reader, depth: u32) -> Option<Value> {
    if depth > MAX_DESC_DEPTH {
        return None;
    }
    let t = r.four()?;
    match &t {
        b"Objc" | b"GlbO" => descriptor(r, depth).map(Value::Desc),
        b"VlLs" => {
            let n = r.u32()? as usize;
            let mut items = Vec::new();
            for _ in 0..n.min(MAX_ITEMS) {
                let Some(v) = value(r, depth + 1) else { break };
                items.push(v);
            }
            Some(Value::List(items))
        }
        b"doub" => r.f64().map(Value::Num),
        b"UntF" => {
            let unit = String::from_utf8_lossy(&r.four()?).into_owned();
            Some(Value::Unit(unit, r.f64()?))
        }
        b"TEXT" => unicode(r).map(Value::Text),
        b"long" => r.i32().map(|v| Value::Num(v as f64)),
        b"bool" => r.u8().map(|_| Value::Skipped),
        b"comp" => r.skip(8).map(|_| Value::Skipped),
        b"enum" => {
            key(r)?;
            key(r)?;
            Some(Value::Skipped)
        }
        b"type" | b"GlbC" => {
            unicode(r)?;
            key(r)?;
            Some(Value::Skipped)
        }
        b"tdta" | b"alis" | b"Pth " => {
            let n = r.u32()? as usize;
            r.skip(n).map(|_| Value::Skipped)
        }
        _ => None,
    }
}

/// One brush's settings out of the descriptor, and the tip it names.
#[derive(Debug, Clone)]
struct Entry {
    /// `sampledData`, the id of the `samp` block this entry describes.
    id: Option<String>,
    name: Option<String>,
    settings: AbrSettings,
}

/// Every brush descriptor in the tree, in document order.
///
/// A brush is any descriptor carrying `Dmtr` or `sampledData`, found by walking
/// rather than by a fixed path: the settings live under `Brsh` in the files
/// seen, but the nesting around it differs between writers, and the keys
/// themselves do not. A name written on an enclosing descriptor - which is
/// where a preset's `Nm  ` usually sits - is inherited by the brush inside it.
fn walk(d: &Descriptor, inherited: Option<&str>, out: &mut Vec<Entry>) {
    if out.len() >= MAX_BRUSHES {
        return;
    }
    let name = d.text("Nm  ").or_else(|| inherited.map(str::to_owned));
    if d.get("Dmtr").is_some() || d.get("sampledData").is_some() {
        out.push(Entry {
            id: d.text("sampledData"),
            name: name.clone(),
            settings: settings(d),
        });
    }
    for (_, v) in &d.items {
        match v {
            Value::Desc(child) => walk(child, name.as_deref(), out),
            Value::List(items) => {
                for item in items {
                    if let Value::Desc(child) = item {
                        walk(child, name.as_deref(), out);
                    }
                }
            }
            _ => {}
        }
    }
}

/// One brush descriptor's settings, in the units `src/lib/brush.js` expects.
///
/// `Dmtr` is a diameter in pixels, `Spcn` and `Hrdn` percentages, `Angl`
/// degrees, and `Rndn` a roundness percentage that is this build's flatness
/// once divided down. A value written without its percent unit and no greater
/// than 1 is read as a ratio, because that is the only reading of `0.5`
/// roundness that is not a brush squashed to nothing.
fn settings(d: &Descriptor) -> AbrSettings {
    let ratio = |k: &str| -> Option<f64> {
        let v = d.num(k)?;
        Some(if d.is_percent(k) || v > 1.0 { v / 100.0 } else { v })
    };
    AbrSettings {
        // A diameter written as a percentage is a percentage of something this
        // file does not say, so it is left to the default rather than guessed.
        size: (!d.is_percent("Dmtr"))
            .then(|| d.num("Dmtr"))
            .flatten()
            .map(|v| v.clamp(1.0, MAX_SIZE_PX) as f32),
        spacing: d.num("Spcn").map(|v| v.clamp(MIN_SPACING, MAX_SPACING) as f32),
        angle: d.num("Angl").map(|v| v.rem_euclid(360.0) as f32),
        flatness: ratio("Rndn").map(|v| v.clamp(0.05, 1.0) as f32),
        hardness: ratio("Hrdn").map(|v| (v * 100.0).clamp(0.0, 100.0) as f32),
    }
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/// Synthesised `.abr` bytes, written from the format notes.
///
/// No `.abr` corpus exists to test against, so the fixtures are built here from
/// the documented layout rather than checked in as binaries - which also means
/// a test can state exactly which byte it is bending.
#[cfg(test)]
pub(crate) mod fixture {
    /// A big-endian byte buffer.
    #[derive(Default)]
    pub struct Buf(pub Vec<u8>);

    impl Buf {
        pub fn new() -> Self {
            Buf(Vec::new())
        }
        pub fn u8(&mut self, v: u8) {
            self.0.push(v);
        }
        pub fn u16(&mut self, v: u16) {
            self.0.extend_from_slice(&v.to_be_bytes());
        }
        pub fn i16(&mut self, v: i16) {
            self.0.extend_from_slice(&v.to_be_bytes());
        }
        pub fn u32(&mut self, v: u32) {
            self.0.extend_from_slice(&v.to_be_bytes());
        }
        pub fn i32(&mut self, v: i32) {
            self.0.extend_from_slice(&v.to_be_bytes());
        }
        pub fn f64(&mut self, v: f64) {
            self.0.extend_from_slice(&v.to_be_bytes());
        }
        pub fn raw(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
        /// A Photoshop Unicode string, trailing null inside the count.
        pub fn text(&mut self, s: &str) {
            let units: Vec<u16> = s.encode_utf16().collect();
            self.u32(units.len() as u32 + 1);
            for u in units {
                self.u16(u);
            }
            self.u16(0);
        }
        /// A descriptor key: four characters take the zero-length form.
        pub fn key(&mut self, k: &str) {
            if k.len() == 4 {
                self.u32(0);
            } else {
                self.u32(k.len() as u32);
            }
            self.raw(k.as_bytes());
        }
        pub fn take(self) -> Vec<u8> {
            self.0
        }
    }

    /// One tip to write into a fixture.
    pub struct Tip {
        pub name: String,
        pub id: String,
        pub w: u32,
        pub h: u32,
        /// Stored pixels, exactly as they go on the wire.
        pub px: Vec<u8>,
        pub rle: bool,
        pub spacing: i16,
        pub depth: u16,
    }

    impl Tip {
        /// A tip of `w` x `h` black ink on a white ground, with a diagonal.
        pub fn ink(name: &str, id: &str, w: u32, h: u32) -> Self {
            let mut px = vec![255u8; (w * h) as usize];
            for y in 0..h.min(w) {
                px[(y * w + y) as usize] = 0;
            }
            Tip {
                name: name.into(),
                id: id.into(),
                w,
                h,
                px,
                rle: false,
                spacing: 25,
                depth: 8,
            }
        }
    }

    /// PackBits one row: repeats of three or more, literals otherwise.
    pub fn packbits(row: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < row.len() {
            let mut run = 1usize;
            while i + run < row.len() && row[i + run] == row[i] && run < 128 {
                run += 1;
            }
            if run >= 3 {
                out.push((257 - run) as u8);
                out.push(row[i]);
                i += run;
            } else {
                let start = i;
                let mut lit = 0usize;
                while i < row.len() && lit < 128 {
                    let mut ahead = 1usize;
                    while i + ahead < row.len() && row[i + ahead] == row[i] && ahead < 3 {
                        ahead += 1;
                    }
                    if ahead >= 3 {
                        break;
                    }
                    i += 1;
                    lit += 1;
                }
                out.push((lit - 1) as u8);
                out.extend_from_slice(&row[start..start + lit]);
            }
        }
        out
    }

    /// A tip's pixel payload: raw, or the row table plus the packed rows.
    pub fn payload(t: &Tip) -> Vec<u8> {
        if !t.rle {
            return t.px.clone();
        }
        let w = t.w as usize;
        let rows: Vec<Vec<u8>> =
            (0..t.h as usize).map(|y| packbits(&t.px[y * w..(y + 1) * w])).collect();
        let mut b = Buf::new();
        for r in &rows {
            b.u16(r.len() as u16);
        }
        for r in &rows {
            b.raw(r);
        }
        b.take()
    }

    /// A whole v1/v2 file. `computed` prepends a type-1 record.
    pub fn v12(version: u16, tips: &[Tip], computed: bool) -> Vec<u8> {
        let mut f = Buf::new();
        f.u16(version);
        f.u16(tips.len() as u16 + computed as u16);
        if computed {
            let body = [0u8; 16];
            f.i16(1);
            f.i32(body.len() as i32);
            f.raw(&body);
        }
        for t in tips {
            let mut b = Buf::new();
            b.i32(0); // misc
            b.i16(t.spacing);
            if version >= 2 {
                b.text(&t.name);
            }
            b.u8(1); // antialiasing
            for _ in 0..4 {
                b.i16(0); // the 16-bit bounds
            }
            b.i32(0);
            b.i32(0);
            b.i32(t.h as i32);
            b.i32(t.w as i32);
            b.u16(t.depth);
            b.u8(t.rle as u8);
            b.raw(&payload(t));
            let body = b.take();
            f.i16(2);
            f.i32(body.len() as i32);
            f.raw(&body);
        }
        f.take()
    }

    /// An 8BIM section.
    pub fn section(f: &mut Buf, name: &[u8; 4], body: &[u8]) {
        f.raw(b"8BIM");
        f.raw(name);
        f.u32(body.len() as u32);
        f.raw(body);
        if body.len() % 2 == 1 {
            f.u8(0);
        }
    }

    /// The `samp` section for a set of tips.
    pub fn samp(minor: u16, tips: &[Tip]) -> Vec<u8> {
        let mut s = Buf::new();
        for t in tips {
            let mut b = Buf::new();
            b.u8(t.id.len() as u8);
            b.raw(t.id.as_bytes());
            if minor == 1 {
                b.raw(&[0u8; 264]);
            }
            b.i32(0);
            b.i32(0);
            b.i32(t.h as i32);
            b.i32(t.w as i32);
            b.u16(t.depth);
            b.u8(t.rle as u8);
            b.raw(&payload(t));
            let body = b.take();
            s.u32(body.len() as u32);
            s.raw(&body);
            s.raw(&vec![0u8; (4 - (body.len() % 4)) % 4]);
        }
        s.take()
    }

    /// One brush entry for the `desc` section.
    pub struct DescBrush {
        /// The `sampledData` id, or none for an entry paired by order.
        pub id: Option<String>,
        pub name: Option<String>,
        pub diameter: Option<f64>,
        pub spacing: Option<f64>,
        pub angle: Option<f64>,
        pub roundness: Option<f64>,
        pub hardness: Option<f64>,
        /// Write the roundness and hardness as plain doubles rather than as
        /// percentages, which is the other way writers store them.
        pub unitless: bool,
    }

    impl DescBrush {
        pub fn new(id: Option<&str>) -> Self {
            DescBrush {
                id: id.map(str::to_owned),
                name: None,
                diameter: None,
                spacing: None,
                angle: None,
                roundness: None,
                hardness: None,
                unitless: false,
            }
        }
    }

    /// A `desc` section: one `Brsh` list of brush descriptors.
    pub fn desc(brushes: &[DescBrush]) -> Vec<u8> {
        let mut d = Buf::new();
        d.u32(16); // descriptor version
        d.text("");
        d.key("null");
        d.u32(1);
        d.key("Brsh");
        d.raw(b"VlLs");
        d.u32(brushes.len() as u32);
        for b in brushes {
            let mut item = Buf::new();
            let mut n = 0u32;
            if let Some(name) = &b.name {
                item.key("Nm  ");
                item.raw(b"TEXT");
                item.text(name);
                n += 1;
            }
            let mut num = |item: &mut Buf, k: &str, u: Option<&[u8; 4]>, v: Option<f64>| {
                if let Some(v) = v {
                    item.key(k);
                    match u {
                        Some(u) => {
                            item.raw(b"UntF");
                            item.raw(u);
                        }
                        None => item.raw(b"doub"),
                    }
                    item.f64(v);
                    n += 1;
                }
            };
            let pct = (!b.unitless).then_some(b"#Prc");
            num(&mut item, "Dmtr", Some(b"#Pxl"), b.diameter);
            num(&mut item, "Spcn", Some(b"#Prc"), b.spacing);
            num(&mut item, "Angl", Some(b"#Ang"), b.angle);
            num(&mut item, "Rndn", pct, b.roundness);
            num(&mut item, "Hrdn", pct, b.hardness);
            if let Some(id) = &b.id {
                item.key("sampledData");
                item.raw(b"TEXT");
                item.text(id);
                n += 1;
            }
            d.raw(b"Objc");
            d.text("");
            d.key("Brsh");
            d.u32(n);
            d.raw(&item.take());
        }
        d.take()
    }

    /// A whole v6-family file.
    pub fn v6(major: u16, minor: u16, tips: &[Tip], brushes: Option<&[DescBrush]>) -> Vec<u8> {
        let mut f = Buf::new();
        f.u16(major);
        f.u16(minor);
        section(&mut f, b"samp", &samp(minor, tips));
        if let Some(b) = brushes {
            section(&mut f, b"desc", &desc(b));
        }
        f.take()
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{self, DescBrush, Tip};
    use super::*;

    /// The ink of a tip as it should arrive: the fixture's diagonal at 255 on
    /// a clear ground.
    fn expected_ink(w: u32, h: u32) -> Vec<u8> {
        let mut px = vec![0u8; (w * h) as usize];
        for y in 0..h.min(w) {
            px[(y * w + y) as usize] = 255;
        }
        px
    }

    #[test]
    fn a_v2_file_round_trips_both_its_tips_pixel_for_pixel() {
        let tips = [Tip::ink("Ink Pen", "a", 6, 4), Tip::ink("Dry Brush", "b", 3, 3)];
        let out = parse(&fixture::v12(2, &tips, false)).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name.as_deref(), Some("Ink Pen"));
        assert_eq!(out[1].name.as_deref(), Some("Dry Brush"));
        assert_eq!(out[0].image.dimensions(), (6, 4));
        assert_eq!(out[1].image.dimensions(), (3, 3));
        // Stored black on white, shipped as ink at 255.
        assert_eq!(out[0].image.as_raw(), &expected_ink(6, 4));
        assert_eq!(out[1].image.as_raw(), &expected_ink(3, 3));
        // v1/v2 records carry a spacing and nothing else this build reads.
        assert_eq!(out[0].settings.spacing, Some(25.0));
        assert_eq!(out[0].settings.size, None);
    }

    #[test]
    fn a_v1_file_has_no_name_field_and_still_yields_its_tip() {
        let mut t = Tip::ink("ignored", "a", 5, 2);
        t.spacing = 0; // a zero spacing is no spacing, not a spacing of nothing
        let out = parse(&fixture::v12(1, &[t], false)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, None);
        assert_eq!(out[0].settings.spacing, None);
        assert_eq!(out[0].image.as_raw(), &expected_ink(5, 2));
    }

    #[test]
    fn a_tip_stored_as_alpha_keeps_the_polarity_it_arrived_in() {
        // Ink high on a clear ground: the border ring is dark, so nothing is
        // inverted and the ink stays where it was.
        let mut t = Tip::ink("Alpha", "a", 8, 8);
        t.px = expected_ink(8, 8);
        let out = parse(&fixture::v12(2, &[t], false)).unwrap();
        assert_eq!(out[0].image.as_raw(), &expected_ink(8, 8));
    }

    #[test]
    fn a_computed_brush_is_skipped_and_the_sampled_one_beside_it_survives() {
        let out = parse(&fixture::v12(2, &[Tip::ink("Sampled", "a", 4, 4)], true)).unwrap();
        assert_eq!(out.len(), 1, "the type-1 record contributes nothing");
        assert_eq!(out[0].name.as_deref(), Some("Sampled"));
    }

    #[test]
    fn a_v6_file_pairs_its_samp_tips_with_its_desc_settings_by_id() {
        let mut wide = Tip::ink("", "tip-wide", 9, 5);
        wide.rle = true;
        let mut tall = Tip::ink("", "tip-tall", 4, 7);
        tall.rle = true;

        // Written in the other order, so a pass here is id pairing rather than
        // two lists that happened to line up.
        let mut tall_desc = DescBrush::new(Some("tip-tall"));
        tall_desc.name = Some("Tall".into());
        tall_desc.diameter = Some(48.0);
        let mut wide_desc = DescBrush::new(Some("tip-wide"));
        wide_desc.name = Some("Wide".into());
        wide_desc.diameter = Some(120.0);
        wide_desc.spacing = Some(17.5);
        wide_desc.angle = Some(-30.0);
        wide_desc.roundness = Some(40.0);
        wide_desc.hardness = Some(80.0);

        let bytes = fixture::v6(6, 2, &[wide, tall], Some(&[tall_desc, wide_desc]));
        let out = parse(&bytes).unwrap();
        assert_eq!(out.len(), 2);

        assert_eq!(out[0].name.as_deref(), Some("Wide"));
        assert_eq!(out[0].image.dimensions(), (9, 5));
        assert_eq!(out[0].image.as_raw(), &expected_ink(9, 5), "RLE rows decode exactly");
        assert_eq!(out[0].settings.size, Some(120.0));
        assert_eq!(out[0].settings.spacing, Some(17.5));
        assert_eq!(out[0].settings.angle, Some(330.0), "a bearing folded into one turn");
        assert_eq!(out[0].settings.flatness, Some(0.4));
        assert_eq!(out[0].settings.hardness, Some(80.0));

        assert_eq!(out[1].name.as_deref(), Some("Tall"));
        assert_eq!(out[1].image.dimensions(), (4, 7));
        assert_eq!(out[1].settings.size, Some(48.0));
        assert_eq!(out[1].settings.spacing, None, "what the file did not say stays unsaid");
    }

    #[test]
    fn a_v6_minor_one_steps_over_the_legacy_name_field() {
        let bytes = fixture::v6(6, 1, &[Tip::ink("", "tip", 5, 5)], None);
        let out = parse(&bytes).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].image.as_raw(), &expected_ink(5, 5));
        assert_eq!(out[0].settings, AbrSettings::default(), "no desc, no settings");
    }

    #[test]
    fn desc_entries_with_no_sampled_data_pair_by_order() {
        let tips = [Tip::ink("", "one", 4, 4), Tip::ink("", "two", 5, 5)];
        let mut first = DescBrush::new(None);
        first.name = Some("First".into());
        first.diameter = Some(10.0);
        let mut second = DescBrush::new(None);
        second.name = Some("Second".into());
        second.diameter = Some(20.0);
        let out = parse(&fixture::v6(10, 2, &tips, Some(&[first, second]))).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name.as_deref(), Some("First"));
        assert_eq!(out[1].name.as_deref(), Some("Second"));
        assert_eq!(out[1].settings.size, Some(20.0));
    }

    #[test]
    fn packbits_reads_literal_runs_repeat_runs_and_the_no_op() {
        // Row of 8: three literals, a run of four, one literal.
        let mut b = fixture::Buf::new();
        b.u16(9); // the compressed length of the one row
        let row = [2u8, 1, 2, 3, 253, 9, 0, 4, 128];
        b.raw(&row);
        let bytes = b.take();
        let mut r = Reader::new(&bytes);
        assert_eq!(unpack(&mut r, 8, 1).unwrap(), vec![1, 2, 3, 9, 9, 9, 9, 4]);

        // And the fixture's own encoder round-trips through it.
        let src: Vec<u8> = vec![7, 7, 7, 7, 1, 2, 3, 3, 9, 9, 9, 9, 9, 5];
        let packed = fixture::packbits(&src);
        let mut b = fixture::Buf::new();
        b.u16(packed.len() as u16);
        b.raw(&packed);
        let bytes = b.take();
        let mut r = Reader::new(&bytes);
        assert_eq!(unpack(&mut r, src.len(), 1).unwrap(), src);
    }

    #[test]
    fn a_packbits_row_that_misses_its_width_either_way_is_refused() {
        // A row is exactly `width` pixels: neither a run that spills past it
        // nor a stream that stops short of it is a row this build will take.
        let one_row = |row: &[u8], w: usize| {
            let mut b = fixture::Buf::new();
            b.u16(row.len() as u16);
            b.raw(row);
            let bytes = b.take();
            unpack(&mut Reader::new(&bytes), w, 1)
        };
        assert!(one_row(&[254, 9], 2).is_none(), "a repeat of three into a row of two");
        assert!(one_row(&[3, 1, 2, 3, 4], 2).is_none(), "four literals into a row of two");
        assert!(one_row(&[0, 1], 2).is_none(), "one pixel written into a row of two");
        // The exact fit is the one that is taken.
        assert_eq!(one_row(&[1, 1, 2], 2), Some(vec![1, 2]));
    }

    #[test]
    fn a_row_never_reads_past_its_own_compressed_length() {
        // The row claims two bytes; the literal header asks for four. The
        // bytes that follow belong to the next row and must not be taken.
        let mut b = fixture::Buf::new();
        b.u16(2);
        b.u16(6);
        b.raw(&[3u8, 1]); // "four literals" with one byte behind it
        b.raw(&[0u8, 9, 0, 9, 0, 9]);
        let bytes = b.take();
        assert!(unpack(&mut Reader::new(&bytes), 4, 2).is_none());
    }

    #[test]
    fn a_truncated_compressed_tip_is_skipped_rather_than_read_short() {
        let mut t = Tip::ink("Cut", "a", 8, 8);
        t.rle = true;
        let whole = fixture::v12(2, &[t], false);
        // Cut into the packed rows: the header still promises 8 x 8.
        let cut = &whole[..whole.len() - 6];
        assert!(parse(cut).is_err(), "a tip that cannot decode in full is not shipped");
    }

    #[test]
    fn a_file_truncated_at_any_length_parses_or_declines_but_never_panics() {
        let mut rle = Tip::ink("RLE", "tip-rle", 7, 5);
        rle.rle = true;
        let files = [
            fixture::v12(2, &[Tip::ink("A", "a", 6, 4), Tip::ink("B", "b", 3, 3)], true),
            fixture::v12(1, &[Tip::ink("A", "a", 6, 4)], false),
            fixture::v6(6, 1, &[Tip::ink("", "tip", 5, 5)], None),
            fixture::v6(
                6,
                2,
                &[rle],
                Some(&[{
                    let mut b = DescBrush::new(Some("tip-rle"));
                    b.name = Some("RLE".into());
                    b.diameter = Some(64.0);
                    b.spacing = Some(12.0);
                    b
                }]),
            ),
        ];
        for whole in &files {
            for n in 0..=whole.len() {
                // Every prefix, which covers every section and record boundary
                // and every offset between them.
                let _ = parse(&whole[..n]);
            }
            // And every single-byte corruption of the header region, where the
            // lengths and counts this parser walks on live.
            for i in 0..whole.len().min(96) {
                let mut bent = whole.clone();
                bent[i] = bent[i].wrapping_add(0x7F);
                let _ = parse(&bent);
            }
        }
    }

    #[test]
    fn absurd_bounds_are_refused_before_anything_is_allocated() {
        // 65536 x 65536 is 2^32 pixels, sixteen times the ceiling, declared by
        // a file only a few hundred bytes long.
        let mut t = Tip::ink("Huge", "a", 4, 4);
        t.px = vec![255; 16];
        let mut bytes = fixture::v12(2, &[t], false);
        // The 32-bit bounds sit at the end of the record header; rewrite the
        // bottom and right of the only brush in the file.
        let at = bytes.len() - 16 - 3 - 8;
        bytes[at..at + 4].copy_from_slice(&65536i32.to_be_bytes());
        bytes[at + 4..at + 8].copy_from_slice(&65536i32.to_be_bytes());
        assert!(parse(&bytes).is_err(), "the ceiling refused it");
    }

    #[test]
    fn a_sixteen_bit_tip_is_skipped_by_design() {
        let mut t = Tip::ink("Deep", "a", 4, 4);
        t.depth = 16;
        assert!(parse(&fixture::v12(2, &[t], false)).is_err());

        let mut deep = Tip::ink("", "tip", 4, 4);
        deep.depth = 16;
        assert!(parse(&fixture::v6(6, 2, &[deep], None)).is_err());
    }

    #[test]
    fn a_file_with_no_readable_brush_is_one_error_not_a_panic() {
        // A well-formed header promising two brushes, and nothing behind it.
        let mut b = fixture::Buf::new();
        b.u16(2);
        b.u16(2);
        assert!(parse(&b.take()).is_err());
        // A version this build does not read.
        let mut b = fixture::Buf::new();
        b.u16(42);
        b.u16(1);
        let err = parse(&b.take()).unwrap_err();
        assert!(err.contains("42"), "the version is named in the error, got {err}");
        // And nothing at all.
        assert!(parse(&[]).is_err());
        assert!(parse(&[0]).is_err());
    }

    #[test]
    fn noise_is_walked_without_panicking() {
        let mut seed = 0x243F_6A88_85A3_08D3u64;
        let mut noise = Vec::with_capacity(1 << 14);
        for _ in 0..1 << 14 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            noise.push(seed as u8);
        }
        for version in [1u16, 2, 6, 7, 10] {
            noise[0..2].copy_from_slice(&version.to_be_bytes());
            for start in [0usize, 1, 777, 4096] {
                let _ = parse(&noise[start.min(noise.len())..]);
            }
        }
    }

    #[test]
    fn a_descriptor_stops_at_a_type_it_cannot_measure_and_keeps_the_rest() {
        let mut d = fixture::Buf::new();
        d.u32(16);
        d.text("");
        d.key("null");
        d.u32(3);
        d.key("Dmtr");
        d.raw(b"UntF");
        d.raw(b"#Pxl");
        d.f64(33.0);
        // An `obj ` reference, whose length this parser cannot compute.
        d.key("Rfrn");
        d.raw(b"obj ");
        d.raw(&[0u8; 8]);
        d.key("Spcn");
        d.raw(b"UntF");
        d.raw(b"#Prc");
        d.f64(50.0);
        let entries = desc(&d.take());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].settings.size, Some(33.0), "what came first is kept");
        assert_eq!(entries[0].settings.spacing, None, "what came after it is not guessed");
    }

    #[test]
    fn the_settings_are_clamped_into_the_windows_the_engine_offers() {
        let mut wild = DescBrush::new(Some("tip"));
        wild.diameter = Some(9_000.0); // past the 1000 px cap
        wild.spacing = Some(1_000.0); // past the 200% cap
        wild.angle = Some(725.0); // two turns and five degrees
        wild.roundness = Some(0.0); // squashed to nothing
        wild.hardness = Some(140.0);
        let out = parse(&fixture::v6(7, 2, &[Tip::ink("", "tip", 4, 4)], Some(&[wild]))).unwrap();
        let s = &out[0].settings;
        assert_eq!(s.size, Some(1000.0));
        assert_eq!(s.spacing, Some(200.0));
        assert_eq!(s.angle, Some(5.0));
        assert_eq!(s.flatness, Some(0.05));
        assert_eq!(s.hardness, Some(100.0));

        // A roundness written as a bare ratio rather than as a percentage.
        let mut ratio = DescBrush::new(Some("tip"));
        ratio.unitless = true;
        ratio.roundness = Some(0.5);
        ratio.hardness = Some(0.25);
        let out = parse(&fixture::v6(7, 2, &[Tip::ink("", "tip", 4, 4)], Some(&[ratio]))).unwrap();
        assert_eq!(out[0].settings.flatness, Some(0.5));
        assert_eq!(out[0].settings.hardness, Some(25.0));
    }

    #[test]
    fn partial_settings_land_over_the_engines_defaults_and_nothing_else() {
        let d = BrushSettings::default();
        let merged = AbrSettings { size: Some(64.0), hardness: Some(20.0), ..Default::default() }
            .over(d.clone());
        assert_eq!(merged.size, 64.0);
        assert_eq!(merged.hardness, 20.0);
        assert_eq!(merged.spacing, d.spacing);
        assert_eq!(merged.taper_in, d.taper_in, "an .abr says nothing about taper");
        assert_eq!(merged.water_edge, d.water_edge);
        assert_eq!(merged.stabilise, d.stabilise);
        assert_eq!(AbrSettings::default().over(d.clone()), d);
    }

    #[test]
    fn a_missing_file_is_an_error_rather_than_a_read() {
        let missing = Path::new("/nonexistent/brush-set.abr");
        assert!(brushes(missing).is_err());
    }
}
