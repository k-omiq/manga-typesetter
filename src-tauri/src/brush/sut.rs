//! Clip Studio Paint `.sut` brush files, from the outer database down to the
//! tip pixels.
//!
//! A `.sut` is a SQLite database. Its `MaterialFile.FileData` column holds a TAR
//! archive; inside that, `data/material_N.layer` is a C2F container (`\x89C2F`,
//! chunks `HEAD` / `dATA` / `TAIL`) whose body is a 1024-byte page space
//! beginning at byte 52, holding several SQLite databases whose 100-byte file
//! headers have been stripped - which is why searching for the SQLite magic
//! finds nothing. One of them has an `Offscreen` table. Its `Attribute` blob is
//! a keyed UTF-16BE structure whose `Parameter` section gives the image size,
//! the block grid, and the plane size; its `BlockData` blob is a run of tiles,
//! each a plain zlib stream. A tile holds several planes. Large brushes store
//! 8 bits per pixel, small ones 1 bit, bit-packed.
//!
//! Nothing about that chain is documented, and Celsys changes it between
//! versions, so this module never trusts a constant it can measure instead. The
//! page grid is found by scanning, the schema page by walking, the pixel depth
//! by dividing the plane size by the tile area. Each candidate reading is then
//! scored against the thumbnail CSP itself stored in the same TAR (see
//! [`super::score`]), and the best-scoring one wins. A file this module has
//! never seen either imports correctly or reports how far off it was - it does
//! not guess silently.
//!
//! Every step returns `Option`/`Result` and the caller falls back: a malformed
//! file must never panic, and files are opened read-only and never written.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use image::GrayImage;
use rusqlite::{Connection, OpenFlags};

use super::score::{as_ink, Scorer};
use super::Tip;

/// The page space every file to date puts at byte 52 with 1024-byte pages.
/// Checked first so the usual import costs one scan, not a search.
const FAST_BASE: usize = 52;
const FAST_PAGE: usize = 1024;

/// Biggest tile and biggest assembled plane this parser will allocate for. The
/// largest real tip measured is 2352 x 11394, so these only ever stop a
/// corrupted header from asking for an absurd buffer.
const MAX_TILE_PIXELS: u64 = 1 << 24;
const MAX_PLANE_PIXELS: u64 = 1 << 28;
/// Ceiling on one inflated tile, for the same reason.
const MAX_INFLATED: u64 = 1 << 28;

/// One material inside a `.sut`, and the best tip read out of it.
///
/// `index` is the row's position in `MaterialFile`, which is what a stable brush
/// id is hashed from, so it is kept even for a material that yielded nothing.
#[derive(Debug)]
pub struct Material {
    pub index: usize,
    pub tip: Option<Tip>,
}

/// Opens a `.sut` read-only. Callers that want the `Variant` or `Node` tables
/// (the brush settings and its name) go through this so the file is never
/// opened any other way.
pub fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// Every material in a `.sut`, in file order. Never raises on a malformed file:
/// a brush with no pattern image has no `MaterialFile` table and yields nothing.
pub fn materials_from_sut(path: &Path) -> Vec<Material> {
    let blobs = match material_blobs(path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    blobs
        .into_iter()
        .enumerate()
        .map(|(index, blob)| Material {
            index,
            tip: blob.as_deref().and_then(tip_from_material),
        })
        .collect()
}

/// Every tip in a `.sut`, largest first. Never raises on a malformed file.
pub fn tips_from_sut(path: &Path) -> Vec<Tip> {
    let mut out: Vec<Tip> = materials_from_sut(path).into_iter().filter_map(|m| m.tip).collect();
    out.sort_by(|a, b| b.area().cmp(&a.area()));
    out
}

/// The `MaterialFile.FileData` blobs, one per row, `None` where the row has no
/// blob. Row order is the material index, so a skipped row still costs a slot.
fn material_blobs(path: &Path) -> rusqlite::Result<Vec<Option<Vec<u8>>>> {
    let con = open_read_only(path)?;
    let mut stmt = con.prepare("select FileData from MaterialFile")?;
    let rows = stmt.query_map([], |r| r.get::<_, Option<Vec<u8>>>(0))?;
    Ok(rows.map(|r| r.unwrap_or(None)).collect())
}

/// Best tip from one material TAR, falling back rather than failing.
fn tip_from_material(blob: &[u8]) -> Option<Tip> {
    let (layer, thumb) = tar_members(blob);
    let mut scorer = Scorer::new(thumb.as_deref().and_then(as_ink));
    if let Some(layer) = layer {
        each_plane(&layer, &mut |img| scorer.offer(img));
    }
    scorer.finish()
}

/// The first `.layer` and the first `thumbnail.png` of a material archive.
fn tar_members(blob: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let mut layer = None;
    let mut thumb = None;
    let mut ar = tar::Archive::new(std::io::Cursor::new(blob));
    let Ok(entries) = ar.entries() else { return (layer, thumb) };
    for entry in entries {
        let Ok(mut entry) = entry else { break };
        let name = match entry.path() {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => continue,
        };
        let slot = if name.ends_with(".layer") && layer.is_none() {
            &mut layer
        } else if name.ends_with("thumbnail.png") && thumb.is_none() {
            &mut thumb
        } else {
            continue;
        };
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() {
            *slot = Some(buf);
        }
    }
    (layer, thumb)
}

// --------------------------------------------------------------------------
// SQLite, without the file header
// --------------------------------------------------------------------------

/// One decoded column of a record.
#[derive(Debug)]
enum Value {
    Null,
    Int(i64),
    /// A float column's eight bytes are stepped over, not kept: nothing above
    /// this decoder reads one, and the brush settings come from the outer
    /// database through rusqlite.
    Real,
    Blob(Vec<u8>),
    Text(String),
}

impl Value {
    fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(v) => Some(*v),
            _ => None,
        }
    }

    fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(v) => Some(v),
            _ => None,
        }
    }

    fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Value::Blob(v) => Some(v),
            _ => None,
        }
    }
}

fn be_u16(b: &[u8], o: usize) -> Option<u16> {
    let end = o.checked_add(2)?;
    Some(u16::from_be_bytes(b.get(o..end)?.try_into().ok()?))
}

fn be_u32(b: &[u8], o: usize) -> Option<u32> {
    let end = o.checked_add(4)?;
    Some(u32::from_be_bytes(b.get(o..end)?.try_into().ok()?))
}

/// SQLite's big-endian variable-length integer. Nine bytes at most, so the
/// value always fits a `u64`.
fn varint(b: &[u8], o: usize) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    for i in 0..9 {
        let c = *b.get(o.checked_add(i)?)?;
        if i == 8 {
            return Some(((v << 8) | c as u64, o + 9));
        }
        v = (v << 7) | (c & 0x7F) as u64;
        if c & 0x80 == 0 {
            return Some((v, o + i + 1));
        }
    }
    None
}

/// B-tree reader for a SQLite database that has lost its 100-byte header.
struct Pages<'a> {
    d: &'a [u8],
    base: usize,
    ps: usize,
}

impl<'a> Pages<'a> {
    /// Byte offset of a 1-based page number, or `None` when it falls outside
    /// the buffer.
    fn off(&self, pno: i64) -> Option<usize> {
        let i = pno.checked_sub(1)?.checked_mul(self.ps as i64)?;
        let o = i.checked_add(self.base as i64)?;
        if o < 0 {
            return None;
        }
        let o = o as usize;
        if o >= self.d.len() {
            return None;
        }
        Some(o)
    }

    /// One cell's record body, following the overflow chain when it has one.
    fn payload(&self, abso: usize) -> Option<Vec<u8>> {
        let d = self.d;
        let (plen, a) = varint(d, abso)?;
        let (_rowid, b) = varint(d, a)?;
        // A length past the end of the buffer is garbage; clamping it keeps the
        // arithmetic below in range without changing any well-formed read.
        let plen = (plen as usize).min(d.len());
        // SQLite's smallest page, which is also the smallest [`find_grid`] can
        // report. Below it the cell-overflow arithmetic has no meaning.
        if self.ps < 512 {
            return None;
        }
        let u = self.ps;
        let x = u - 35;
        if plen <= x {
            let end = b.checked_add(plen)?.min(d.len());
            return Some(d.get(b..end)?.to_vec());
        }
        let m = ((u - 12) * 32 / 255) - 23;
        let k = m + ((plen - m) % (u - 4));
        let loc = if k <= x { k } else { m };
        let split = b.checked_add(loc)?;
        let mut out = d.get(b..split.min(d.len()))?.to_vec();
        let mut nxt = be_u32(d, split)?;
        while nxt != 0 && out.len() < plen {
            let Some(po) = self.off(nxt as i64) else { break };
            if po + self.ps > d.len() {
                break;
            }
            nxt = be_u32(d, po)?;
            let take = (self.ps - 4).min(plen - out.len());
            out.extend_from_slice(d.get(po + 4..po + 4 + take)?);
        }
        Some(out)
    }

    /// A record body split into its columns.
    fn values(&self, rec: &[u8]) -> Option<Vec<Value>> {
        let (hs, mut o) = varint(rec, 0)?;
        let hs = hs as usize;
        let mut types = Vec::new();
        while o < hs {
            let (s, next) = varint(rec, o)?;
            types.push(s);
            o = next;
        }
        let mut vo = hs;
        let mut out = Vec::with_capacity(types.len());
        for s in types {
            let (v, n) = match s {
                0 => (Value::Null, 0),
                1..=6 => {
                    let n = [1usize, 2, 3, 4, 6, 8][(s - 1) as usize];
                    let bytes = rec.get(vo..vo.checked_add(n)?)?;
                    let mut acc: i64 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
                    for &byte in bytes {
                        acc = (acc << 8) | byte as i64;
                    }
                    (Value::Int(acc), n)
                }
                7 => {
                    rec.get(vo..vo.checked_add(8)?)?;
                    (Value::Real, 8)
                }
                8 => (Value::Int(0), 0),
                9 => (Value::Int(1), 0),
                // 10 and 11 are SQLite's internal-use serial types; a record
                // carrying one is not a record this parser can read.
                10 | 11 => return None,
                // A serial type is a `u64` on the wire; on a 32-bit target one
                // too large to be a length is a length this parser cannot read.
                _ if s % 2 == 0 => {
                    let n = usize::try_from(s).ok()?.checked_sub(12)? / 2;
                    (Value::Blob(rec.get(vo..vo.checked_add(n)?)?.to_vec()), n)
                }
                _ => {
                    let n = usize::try_from(s).ok()?.checked_sub(13)? / 2;
                    let bytes = rec.get(vo..vo.checked_add(n)?)?;
                    (Value::Text(String::from_utf8_lossy(bytes).into_owned()), n)
                }
            };
            out.push(v);
            vo = vo.checked_add(n)?;
        }
        Some(out)
    }

    /// Every record under one b-tree page, appended to `acc`.
    fn rows(&self, pno: i64, acc: &mut Vec<Vec<Value>>) {
        let mut seen = HashSet::new();
        self.walk(pno, acc, &mut seen, 0);
    }

    fn walk(&self, pno: i64, acc: &mut Vec<Vec<Value>>, seen: &mut HashSet<i64>, depth: u32) {
        if depth > 16 || !seen.insert(pno) {
            return;
        }
        let d = self.d;
        let Some(o) = self.off(pno) else { return };
        if o + 12 > d.len() {
            return;
        }
        let kind = d[o];
        // 0x0D is a table leaf, 0x05 a table interior. Index pages carry no
        // rows this parser wants.
        if kind == 0x0D {
            let Some(n) = be_u16(d, o + 3) else { return };
            let n = n as usize;
            if o + 8 + n * 2 > d.len() {
                return;
            }
            for i in 0..n {
                let Some(p) = be_u16(d, o + 8 + i * 2) else { return };
                let p = p as usize;
                if (8..self.ps).contains(&p) {
                    if let Some(rec) = self.payload(o + p) {
                        if let Some(v) = self.values(&rec) {
                            acc.push(v);
                        }
                    }
                }
            }
        } else if kind == 0x05 {
            let Some(n) = be_u16(d, o + 3) else { return };
            let n = n as usize;
            if o + 12 + n * 2 > d.len() {
                return;
            }
            for i in 0..n {
                let Some(p) = be_u16(d, o + 12 + i * 2) else { return };
                let p = p as usize;
                if (12..self.ps).contains(&p) {
                    if let Some(child) = be_u32(d, o + p) {
                        self.walk(child as i64, acc, seen, depth + 1);
                    }
                }
            }
            if let Some(right) = be_u32(d, o + 8) {
                if right != 0 {
                    self.walk(right as i64, acc, seen, depth + 1);
                }
            }
        }
    }
}

/// How many page-aligned offsets look like real b-tree pages.
fn grid_score(buf: &[u8], base: usize, page: usize) -> u32 {
    let mut ok = 0;
    let mut o = base;
    while o.saturating_add(page) <= buf.len() {
        let t = buf[o];
        if matches!(t, 2 | 5 | 10 | 13) {
            let hdr = if t == 2 || t == 5 { 12 } else { 8 };
            if let (Some(ncell), Some(content)) = (be_u16(buf, o + 3), be_u16(buf, o + 5)) {
                let ncell = ncell as usize;
                let content = content as usize;
                if ncell <= (page - hdr) / 2 && (content == 0 || (hdr..=page).contains(&content)) {
                    ok += 1;
                }
            }
        }
        o += page;
    }
    ok
}

/// Base offset and page size of the page space, measured rather than assumed.
fn find_grid(buf: &[u8]) -> (usize, usize) {
    if grid_score(buf, FAST_BASE, FAST_PAGE) > 8 {
        return (FAST_BASE, FAST_PAGE);
    }
    let mut best = (0, FAST_BASE, FAST_PAGE);
    for page in [1024usize, 2048, 4096, 512] {
        for base in 0..buf.len().min(4096) {
            let s = grid_score(buf, base, page);
            if s > best.0 {
                best = (s, base, page);
            }
        }
    }
    (best.1, best.2)
}

/// Root page of every `Offscreen` table, found by walking each schema page.
fn offscreen_roots(pg: &Pages) -> Vec<i64> {
    let mut roots = Vec::new();
    if pg.base >= pg.d.len() || pg.ps == 0 {
        return roots;
    }
    let npages = (pg.d.len() - pg.base) / pg.ps;
    for pno in 1..=npages as i64 {
        let Some(o) = pg.off(pno) else { continue };
        if o + 8 > pg.d.len() || pg.d[o] != 0x0D {
            continue;
        }
        let mut acc = Vec::new();
        pg.rows(pno, &mut acc);
        for v in acc {
            if v.len() >= 5
                && v[0].as_text() == Some("table")
                && v[1].as_text() == Some("Offscreen")
            {
                if let Some(root) = v[3].as_int() {
                    roots.push(root);
                }
            }
        }
    }
    roots
}

// --------------------------------------------------------------------------
// Offscreen blobs
// --------------------------------------------------------------------------

/// A UTF-16BE key equals this ASCII name.
fn is_key(bytes: &[u8], name: &str) -> bool {
    bytes.len() == name.len() * 2
        && bytes.chunks_exact(2).zip(name.bytes()).all(|(c, n)| c[0] == 0 && c[1] == n)
}

/// `(width, height, cols, rows, plane bytes)` from an Offscreen `Attribute`.
fn attribute(att: &[u8]) -> Option<(u32, u32, u32, u32, usize)> {
    let hdr_len = be_u32(att, 0)? as usize;
    if !(8..=att.len()).contains(&hdr_len) {
        return None;
    }
    let count = hdr_len / 4;
    let mut o = hdr_len;
    for i in 1..count {
        let size = be_u32(att, i * 4)? as usize;
        if o + 4 > att.len() {
            break;
        }
        let nl = be_u32(att, o)? as usize;
        let name_end = o.checked_add(4)?.checked_add(nl.checked_mul(2)?)?;
        let name = att.get(o + 4..name_end.min(att.len()))?;
        if is_key(name, "Parameter") {
            let used = 4usize.checked_add(nl.checked_mul(2)?)?;
            let n = size.checked_sub(used)? / 4;
            if n < 9 {
                return None;
            }
            let p = |k: usize| be_u32(att, name_end.checked_add(k.checked_mul(4)?)?);
            return Some((p(0)?, p(1)?, p(2)?, p(3)?, p(8)? as usize));
        }
        o = o.checked_add(size)?;
    }
    None
}

/// One tile of one plane, as 8-bit pixels.
struct Tile {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

/// One tile plane as 8-bit pixels, whatever depth it was stored at.
///
/// The depth is found by dividing the plane size by the tile area, never
/// hardcoded: large brushes store 8 bits per pixel and small ones 1, and the
/// only reliable way to tell them apart is to measure.
fn tile(seg: &[u8], tw: u32, th: u32, plane: usize) -> Option<Tile> {
    let area = tw as u64 * th as u64;
    if area == 0 {
        return None;
    }
    let bits = plane as u64 * 8 / area;
    if bits == 8 {
        if plane as u64 != area {
            return None;
        }
        return Some(Tile { w: tw, h: th, px: seg.get(..plane)?.to_vec() });
    }
    if bits == 1 {
        let (tw, th) = (tw as usize, th as usize);
        if plane % th != 0 {
            return None;
        }
        let stride = plane / th;
        if stride * 8 < tw {
            return None;
        }
        let mut px = vec![0u8; tw * th];
        for y in 0..th {
            let row = seg.get(y * stride..y * stride + stride)?;
            for x in 0..tw {
                px[y * tw + x] = ((row[x / 8] >> (7 - (x % 8))) & 1) * 255;
            }
        }
        return Some(Tile { w: tw as u32, h: th as u32, px });
    }
    None
}

/// One zlib stream, with a ceiling on what it is allowed to inflate to.
fn inflate(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut dec = flate2::read::ZlibDecoder::new(body).take(MAX_INFLATED);
    dec.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Every plane of one Offscreen row, assembled and handed over one at a time.
fn planes(att: &[u8], blk: &[u8], f: &mut dyn FnMut(GrayImage)) {
    let Some((w, h, cols, rows, plane)) = attribute(att) else { return };
    if w == 0 || h == 0 || cols == 0 || rows == 0 || plane == 0 {
        return;
    }
    // Plane index -> tile index -> tile, both in the order they were met, which
    // is the order the reference extractor picks a winner in.
    let mut grids: Vec<(usize, Vec<(u32, Tile)>)> = Vec::new();
    let mut o = 0usize;
    while o + 8 <= blk.len() {
        let Some(size) = be_u32(blk, o) else { break };
        let size = size as usize;
        if size < 8 || o + size > blk.len() {
            break;
        }
        let Some(nl) = be_u32(blk, o + 4) else { break };
        let name_end = (o + 8).saturating_add((nl as usize).saturating_mul(2));
        let Some(name) = blk.get(o + 8..name_end.min(blk.len())) else { break };
        if !is_key(name, "BlockDataBeginChunk") {
            break;
        }
        if name_end <= o + size {
            collect_tiles(&blk[name_end..o + size], plane, &mut grids);
        }
        o += size;
    }
    for (_pi, tiles) in grids {
        if let Some(img) = assemble(&tiles, w, h, cols, rows) {
            f(img);
        }
    }
}

/// One `BlockDataBeginChunk` body's tiles, filed under their plane index.
///
/// A filled tile carries a zlib stream; an empty one is header only.
fn collect_tiles(body: &[u8], plane: usize, grids: &mut Vec<(usize, Vec<(u32, Tile)>)>) {
    if body.len() < 32 || body[28..30] != [0x78, 0x01] {
        return;
    }
    let (Some(idx), Some(usz), Some(tw), Some(th), Some(clen)) = (
        be_u32(body, 0),
        be_u32(body, 4),
        be_u32(body, 8),
        be_u32(body, 12),
        be_u32(body, 20),
    ) else {
        return;
    };
    if tw == 0 || th == 0 || tw as u64 * th as u64 > MAX_TILE_PIXELS {
        return;
    }
    let end = (28usize).saturating_add(clen as usize).min(body.len());
    let Some(raw) = inflate(&body[28..end]) else { return };
    if raw.len() < plane {
        return;
    }
    let count = (usz as usize / plane).clamp(1, 4);
    for pi in 0..count {
        let Some(seg) = raw.get(pi * plane..(pi + 1) * plane) else { break };
        let Some(t) = tile(seg, tw, th, plane) else { continue };
        let at = match grids.iter().position(|(p, _)| *p == pi) {
            Some(at) => at,
            None => {
                grids.push((pi, Vec::new()));
                grids.len() - 1
            }
        };
        let slot = &mut grids[at].1;
        match slot.iter_mut().find(|(i, _)| *i == idx) {
            Some(existing) => existing.1 = t,
            None => slot.push((idx, t)),
        }
    }
}

/// The tiles of one plane laid into the block grid and cropped to the image.
///
/// The crop is applied while blitting rather than after, so a page-sized strip
/// never allocates the full `cols * rows` canvas on top of the image itself.
fn assemble(tiles: &[(u32, Tile)], w: u32, h: u32, cols: u32, rows: u32) -> Option<GrayImage> {
    let first = tiles.first()?;
    let (bw, bh) = (first.1.w, first.1.h);
    if bw == 0 || bh == 0 {
        return None;
    }
    let ow = (w as u64).min(cols as u64 * bw as u64) as u32;
    let oh = (h as u64).min(rows as u64 * bh as u64) as u32;
    if ow == 0 || oh == 0 || ow as u64 * oh as u64 > MAX_PLANE_PIXELS {
        return None;
    }
    let mut px = vec![0u8; ow as usize * oh as usize];
    for (idx, t) in tiles {
        if t.w != bw || t.h != bh {
            continue;
        }
        let (r, c) = (idx / cols, idx % cols);
        if r >= rows || c >= cols {
            continue;
        }
        // Widened before the multiply, not after: `cols` and the tile size are
        // both read straight out of the file, and a corrupted pair whose product
        // leaves `u32` must land outside the image rather than wrap into it.
        let x0 = c as u64 * bw as u64;
        let y0 = r as u64 * bh as u64;
        if x0 >= ow as u64 || y0 >= oh as u64 {
            continue;
        }
        let (x0, y0) = (x0 as usize, y0 as usize);
        let n = (bw as usize).min(ow as usize - x0);
        for ty in 0..bh as usize {
            let y = y0 + ty;
            if y >= oh as usize {
                break;
            }
            let dst = y * ow as usize + x0;
            px[dst..dst + n].copy_from_slice(&t.px[ty * bw as usize..ty * bw as usize + n]);
        }
    }
    if px.iter().all(|&v| v == 0) {
        return None;
    }
    GrayImage::from_raw(ow, oh, px)
}

/// Every plane of every Offscreen row of one `.layer`, one at a time.
///
/// A callback, not a list: a page-sized brush strip is tens of megabytes per
/// plane, and a brush can hold several rows of several planes. Holding them all
/// at once to pick one was costing hundreds of megabytes.
fn each_plane(layer: &[u8], f: &mut dyn FnMut(GrayImage)) {
    let (base, ps) = find_grid(layer);
    let pg = Pages { d: layer, base, ps };
    for root in offscreen_roots(&pg) {
        let mut acc = Vec::new();
        pg.rows(root, &mut acc);
        for v in acc {
            if v.len() < 6 {
                continue;
            }
            let (Some(att), Some(blk)) = (v[4].as_blob(), v[5].as_blob()) else { continue };
            if blk.len() <= 8 {
                continue;
            }
            planes(att, blk, f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::{TipSource, TRUST_MAX_DIFF};
    use std::path::PathBuf;

    /// The 64 `.sut` files under `external/` are the import regression suite.
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

    #[test]
    fn the_corpus_yields_its_tips_at_full_resolution() {
        let files = corpus();
        assert_eq!(files.len(), 64, "the corpus is 64 .sut files under external/");

        let mut with_tips = 0;
        let mut total = 0;
        let mut max_diff = 0f32;
        let mut fallbacks: Vec<String> = Vec::new();
        let mut empty: Vec<String> = Vec::new();
        for path in &files {
            let tips = tips_from_sut(path);
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            if tips.is_empty() {
                empty.push(name.clone());
            } else {
                with_tips += 1;
            }
            total += tips.len();
            for t in &tips {
                match t.source {
                    TipSource::Pixels => {
                        let d = t.diff.unwrap_or(f32::MAX);
                        max_diff = max_diff.max(d);
                        assert!(
                            d <= TRUST_MAX_DIFF,
                            "{name}: a pixel-source tip shipped at diff {d}, over the trust bar"
                        );
                    }
                    TipSource::Thumbnail => fallbacks.push(name.clone()),
                }
            }
        }

        // The one failure is a brush with `BrushUsePatternImage = 0`: it has no
        // tip image to extract, and failing cleanly is correct.
        assert_eq!(with_tips, 63, "63 of 64 files yield a tip; the empties were {empty:?}");
        assert_eq!(total, 124, "124 tips across the corpus");
        assert!(fallbacks.is_empty(), "every corpus tip is pixel source; fell back: {fallbacks:?}");
        assert!(max_diff <= TRUST_MAX_DIFF, "worst agreement with CSP's preview was {max_diff}");
        println!(
            "corpus: {} files, {with_tips} yielding, {total} tips, worst diff {max_diff:.3}",
            files.len()
        );
    }

    #[test]
    fn a_file_that_is_not_a_sut_yields_nothing_rather_than_failing() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert!(tips_from_sut(&manifest.join("Cargo.toml")).is_empty());
        assert!(tips_from_sut(&manifest.join("no-such-file.sut")).is_empty());
        assert!(materials_from_sut(&manifest.join("no-such-file.sut")).is_empty());
    }

    #[test]
    fn a_damaged_page_space_is_walked_without_panicking() {
        // Page grid shifted, truncated, filled with leaf-page markers, and pure
        // noise: the parser reports what it found, and never faults.
        let mut cases: Vec<Vec<u8>> = vec![
            Vec::new(),
            vec![0u8; 64],
            vec![0x0Du8; 8192],
            vec![0xFFu8; 4096],
        ];
        let mut seed = 0x243F_6A88_85A3_08D3u64;
        let mut noise = Vec::with_capacity(16384);
        for _ in 0..16384 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            noise.push(seed as u8);
        }
        cases.push(noise.clone());
        cases.push(noise[777..].to_vec());
        for case in &cases {
            let mut seen = 0;
            each_plane(case, &mut |_| seen += 1);
        }
    }

    #[test]
    fn a_record_with_an_internal_serial_type_is_declined() {
        let pg = Pages { d: &[], base: 0, ps: 1024 };
        // Header of 2 bytes, one column of serial type 10 (internal use).
        assert!(pg.values(&[0x02, 0x0A]).is_none());
    }

    #[test]
    fn a_records_columns_come_back_in_order_and_signed() {
        let pg = Pages { d: &[], base: 0, ps: 1024 };
        // Header 5 bytes: NULL, 1-byte int, 4-char text, 2-byte blob.
        let rec = [0x05, 0x00, 0x01, 0x15, 0x10, 0xFF, b't', b'a', b'b', b'l', 0xDE, 0xAD];
        let v = pg.values(&rec).unwrap();
        assert_eq!(v.len(), 4);
        assert!(matches!(v[0], Value::Null));
        assert_eq!(v[1].as_int(), Some(-1));
        assert_eq!(v[2].as_text(), Some("tabl"));
        assert_eq!(v[3].as_blob(), Some(&[0xDE, 0xAD][..]));
    }

    #[test]
    fn a_tile_origin_past_u32_lands_outside_the_image_rather_than_wrapping() {
        // 90_000 columns of 50_000 px is 4.5e9, past `u32::MAX`: multiplied at
        // u32 that panics in debug and wraps to 205_032_704 in release, which
        // would blit a tile into the middle of a 16 px image.
        let big = vec![(90_000u32, Tile { w: 50_000, h: 1, px: vec![255; 50_000] })];
        assert!(assemble(&big, 16, 16, 100_000, 1).is_none(), "nothing was written");

        // The ordinary grid still lands where it should.
        let ok = vec![
            (0u32, Tile { w: 2, h: 2, px: vec![1, 2, 3, 4] }),
            (1u32, Tile { w: 2, h: 2, px: vec![5, 6, 7, 8] }),
        ];
        let img = assemble(&ok, 4, 2, 2, 1).unwrap();
        assert_eq!(img.dimensions(), (4, 2));
        assert_eq!(img.into_raw(), vec![1, 2, 5, 6, 3, 4, 7, 8]);
    }

    #[test]
    fn the_pixel_depth_is_divided_out_not_assumed() {
        // 8 bits per pixel: one byte per pixel of a 4x2 tile.
        let eight = tile(&[1, 2, 3, 4, 5, 6, 7, 8], 4, 2, 8).unwrap();
        assert_eq!((eight.w, eight.h), (4, 2));
        assert_eq!(eight.px, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        // 1 bit per pixel: one byte per 8-pixel row, unpacked to 0 or 255.
        let one = tile(&[0b1010_0000, 0b0101_0000], 8, 2, 2).unwrap();
        assert_eq!((one.w, one.h), (8, 2));
        assert_eq!(
            one.px,
            vec![255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0]
        );
        // Anything else is declined rather than guessed at.
        assert!(tile(&[0; 24], 4, 2, 24).is_none());
        assert!(tile(&[0; 8], 0, 2, 8).is_none());
    }
}
