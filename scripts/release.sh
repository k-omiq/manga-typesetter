#!/usr/bin/env bash
# Build, sign, and publish an update to R2 (typesetter.komiq.cc).
# Usage: ./scripts/release.sh ["release notes"]
# Run on mac -> publishes darwin entry. Run on windows (git-bash) -> publishes windows entry.
# latest.json is merged, so platforms built on other machines are preserved.
set -euo pipefail
cd "$(dirname "$0")/.."

NOTES="${1:-}"
BASE_URL="https://typesetter.komiq.cc"
BUCKET="typesetter-updates"
KEY_PATH="$HOME/.tauri/typesetter-updater.key"

[ -f "$KEY_PATH" ] || { echo "signing key missing: $KEY_PATH"; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY_PATH="$KEY_PATH"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
echo "== building v$VERSION =="
npm run tauri build

# platform key + updater artifact
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Darwin-arm64)  PLATFORM="darwin-aarch64" ;;
  Darwin-x86_64) PLATFORM="darwin-x86_64" ;;
  MINGW*-*|MSYS*-*) PLATFORM="windows-x86_64" ;;
  *) echo "unsupported platform $OS-$ARCH"; exit 1 ;;
esac

BUNDLE_DIR="src-tauri/target/release/bundle"
case "$PLATFORM" in
  darwin-*)
    ARTIFACT=$(ls "$BUNDLE_DIR"/macos/*.app.tar.gz | head -1)
    EXTRA=$(ls "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -1 || true)
    ;;
  windows-*)
    ARTIFACT=$(ls "$BUNDLE_DIR"/nsis/*-setup.exe | head -1)
    EXTRA=""
    ;;
esac
SIG="$ARTIFACT.sig"
[ -f "$SIG" ] || { echo "signature missing: $SIG (is bundle.createUpdaterArtifacts true?)"; exit 1; }

FNAME=$(basename "$ARTIFACT")
REMOTE="releases/v$VERSION/$FNAME"
echo "== uploading $FNAME =="
npx wrangler r2 object put "$BUCKET/$REMOTE" --file "$ARTIFACT" --remote
if [ -n "$EXTRA" ]; then
  npx wrangler r2 object put "$BUCKET/releases/v$VERSION/$(basename "$EXTRA")" --file "$EXTRA" --remote
fi

echo "== merging latest.json =="
EXISTING=$(curl -sf "$BASE_URL/latest.json" || echo '{}')
LATEST=$(EXISTING_JSON="$EXISTING" python3 - "$VERSION" "$PLATFORM" "$BASE_URL/$REMOTE" "$SIG" "$NOTES" <<'PY'
import json, sys, os, datetime
version, platform, url, sig_path, notes = sys.argv[1:6]
try:
    data = json.loads(os.environ.get("EXISTING_JSON", "{}"))
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
same_version = data.get("version") == version
platforms = data.get("platforms", {}) if same_version else {}
platforms[platform] = {"signature": open(sig_path).read().strip(), "url": url}
out = {
    "version": version,
    "notes": notes or (data.get("notes", "") if same_version else ""),
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
print(json.dumps(out, indent=2))
PY
)
echo "$LATEST" > /tmp/latest.json
npx wrangler r2 object put "$BUCKET/latest.json" --file /tmp/latest.json --remote

echo "== done =="
echo "$LATEST"
echo "check: curl $BASE_URL/latest.json"
