#!/usr/bin/env bash
# Builds the Linux AppImage from the .deb that `tauri build --bundles deb`
# produced, and signs it for the updater when a signing key is in the
# environment.
#
# Why not Tauri's own AppImage? Its linuxdeploy step bundles the whole desktop
# stack (GTK, GLib, WebKitGTK and its JavaScriptCore, ICU, GStreamer) from the
# build host. WebKitGTK then spawns its helper processes (WebKitWebProcess,
# WebKitNetworkProcess) from the path compiled into the library, which is the
# host's, and a release build of WebKit ignores WEBKIT_EXEC_PATH. So the UI
# process ran the bundled WebKit while the helpers ran whatever the host had,
# and on any distro but the build host's the two disagreed: blank window on
# Debian, Fedora, Arch, and a hard failure on hosts whose helpers live under
# another path (/usr/libexec, /usr/lib/webkit2gtk-4.1). Mixing a host WebKit
# with bundled GTK/GLib is no better, the symbol versions drift the other way.
#
# This AppImage bundles nothing from the desktop stack. The app links the
# host's GTK and WebKitGTK 4.1 exactly like the .deb does, so UI process,
# helpers and injected bundle are always one version, on every distro. The
# price is that the host must have webkit2gtk-4.1 installed; AppRun checks
# for it and prints the install command when it is missing.
#
# Usage: scripts/build-appimage.sh <app.deb> <out.AppImage>
# Env:   TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) -> also writes <out>.sig
#        APPIMAGETOOL: path to an appimagetool binary (downloaded when unset)
set -euo pipefail

DEB=${1:?deb path}
OUT=${2:?output AppImage path}
OUT=$(realpath -m "$OUT")

# Pinned so a build is reproducible; bump on purpose.
APPIMAGETOOL_VERSION=1.9.0
ARCH=$(uname -m)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APPDIR="$WORK/AppDir"

dpkg-deb -x "$DEB" "$APPDIR"

# The deb ships one desktop entry and hicolor icons; appimagetool wants the
# entry and a same-named icon at the AppDir root.
DESKTOP=$(ls "$APPDIR"/usr/share/applications/*.desktop | head -1)
ICON_NAME=$(sed -n 's/^Icon=//p' "$DESKTOP" | head -1)
cp "$DESKTOP" "$APPDIR/"
ICON=$(ls -S "$APPDIR"/usr/share/icons/hicolor/*/apps/"$ICON_NAME".png | head -1)
cp "$ICON" "$APPDIR/$ICON_NAME.png"
ln -sf "$ICON_NAME.png" "$APPDIR/.DirIcon"

BIN=$(sed -n 's/^Exec=//p' "$DESKTOP" | head -1 | cut -d' ' -f1)

cat > "$APPDIR/AppRun" <<EOF
#!/bin/sh
# Runs the app against the host's GTK and WebKitGTK; see scripts/build-appimage.sh.
HERE=\$(dirname "\$(readlink -f "\$0")")
if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1.so.0'; then
  MSG="Manga Typesetter needs WebKitGTK 4.1 from your distribution.

Install it and run the AppImage again:
  Debian / Ubuntu / Mint:  sudo apt install libwebkit2gtk-4.1-0
  Fedora:                  sudo dnf install webkit2gtk4.1
  Arch / Manjaro:          sudo pacman -S webkit2gtk-4.1
  openSUSE:                sudo zypper install libwebkit2gtk-4_1-0"
  echo "\$MSG" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --no-wrap --text="\$MSG" 2>/dev/null; fi
  exit 1
fi
exec "\$HERE/usr/bin/$BIN" "\$@"
EOF
chmod +x "$APPDIR/AppRun"

if [ -z "${APPIMAGETOOL:-}" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/appimagetool"
  APPIMAGETOOL="$CACHE/appimagetool-$APPIMAGETOOL_VERSION-$ARCH.AppImage"
  if [ ! -x "$APPIMAGETOOL" ]; then
    mkdir -p "$CACHE"
    curl -fsSL -o "$APPIMAGETOOL" \
      "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-$ARCH.AppImage"
    chmod +x "$APPIMAGETOOL"
  fi
fi

mkdir -p "$(dirname "$OUT")"
# --no-appstream: no metainfo shipped. Extract-and-run: CI runners have no FUSE.
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$ARCH" "$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # Reads TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  # from the environment; writes <out>.sig, which latest.json publishes.
  npx tauri signer sign "$OUT"
fi
ls -la "$OUT"*
