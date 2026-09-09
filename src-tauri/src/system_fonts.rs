//! The fonts installed on this machine, by family, with which of the four faces
//! the app distinguishes (regular, bold, italic, bold italic) are really there.
//!
//! The webview draws an installed family by name - `font-family: 'Name'` needs
//! no bytes handed over - so all the frontend wants from here is the list of
//! names and, per family, which faces it can count on being real rather than
//! synthesised. fontdb parses only the tables it needs to answer that, which is
//! why a scan of several hundred families is a fraction of a second; it is
//! still run off the main thread, because the webview asks at boot.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
pub struct Faces {
    pub regular: bool,
    pub bold: bool,
    pub italic: bool,
    #[serde(rename = "boldItalic")]
    pub bold_italic: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct SystemFont {
    pub name: String,
    pub faces: Faces,
}

/// CSS `font-weight: bold` is 700, and the browser's bold matching picks the
/// nearest face at or above 600 (the "semibold or heavier counts as bold" rule
/// of the CSS font matching algorithm). Anything under that renders as the
/// family's regular for a normal-weight request.
const BOLD_FROM: u16 = 600;

/// Fold one face into its family's entry. Shared by the scan and the tests so
/// the grouping rule is exercised without a font directory.
fn fold(map: &mut BTreeMap<String, Faces>, family: &str, weight: u16, italic: bool) {
    // Families whose name begins with a dot are the OS's own UI faces on macOS
    // (".SF NS", ".Keyboard"), not installed for documents and not offered by
    // any font menu the user has seen.
    if family.is_empty() || family.starts_with('.') {
        return;
    }
    let e = map.entry(family.to_string()).or_default();
    match (weight >= BOLD_FROM, italic) {
        (false, false) => e.regular = true,
        (true, false) => e.bold = true,
        (false, true) => e.italic = true,
        (true, true) => e.bold_italic = true,
    }
}

fn scan() -> Vec<SystemFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut map: BTreeMap<String, Faces> = BTreeMap::new();
    for face in db.faces() {
        // The first family name is the one the file itself leads with, which is
        // the English name on every font that has one.
        let Some((family, _)) = face.families.first() else { continue };
        let italic = matches!(face.style, fontdb::Style::Italic | fontdb::Style::Oblique);
        fold(&mut map, family, face.weight.0, italic);
    }
    map.into_iter().map(|(name, faces)| SystemFont { name, faces }).collect()
}

#[tauri::command]
pub async fn system_fonts() -> Vec<SystemFont> {
    tauri::async_runtime::spawn_blocking(scan).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_faces_under_their_family_by_weight_and_slant() {
        let mut map = BTreeMap::new();
        fold(&mut map, "Wild Words", 400, false);
        fold(&mut map, "Wild Words", 700, false);
        fold(&mut map, "Wild Words", 400, true);
        fold(&mut map, "Anime Ace", 400, false);
        assert_eq!(
            map.get("Wild Words"),
            Some(&Faces { regular: true, bold: true, italic: true, bold_italic: false })
        );
        assert_eq!(map.get("Anime Ace"), Some(&Faces { regular: true, ..Default::default() }));
    }

    #[test]
    fn semibold_counts_as_bold_and_light_as_regular() {
        let mut map = BTreeMap::new();
        fold(&mut map, "F", 600, true);
        fold(&mut map, "F", 300, false);
        assert_eq!(map.get("F"), Some(&Faces { regular: true, bold_italic: true, ..Default::default() }));
    }

    #[test]
    fn skips_the_os_private_ui_faces() {
        let mut map = BTreeMap::new();
        fold(&mut map, ".SF NS", 400, false);
        fold(&mut map, "", 400, false);
        assert!(map.is_empty());
    }
}
