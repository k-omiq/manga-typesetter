#!/usr/bin/env bash
# One-command release. Bumps the version, tags, pushes, watches the Release
# workflow on GitHub Actions, and verifies the published manifest.
#
#   ./scripts/ship.sh 0.2.0 "Fixed the drag flinch, faster exports"
#   ./scripts/ship.sh 0.2.0 "notes" --dry-run   # stop before pushing anything
#
# Steps it performs:
#   1. Preflight: gh auth, clean tree, on main, synced with origin, secrets set.
#   2. Bump version in src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
#   3. Commit "release: vX.Y.Z", push main.
#   4. Annotated tag vX.Y.Z (message = release notes shown in the app), push it.
#   5. Watch the Release run; on failure print the failing step's log and exit 1.
#   6. Verify https://typesetter.komiq.cc/latest.json serves the new version
#      and count the published platforms.
#
# scripts/release.sh is the OTHER path: it builds and publishes from THIS
# machine only (current platform). Use ship.sh for normal releases.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
NOTES="${2:-}"
DRY_RUN="${3:-}"
REPO="gecallidryas/manga-typesetter"
BASE_URL="https://typesetter.komiq.cc"

fail() { echo "ERROR: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: ship.sh X.Y.Z \"notes\" [--dry-run] (got '${VERSION}')"
[ -n "$NOTES" ] || fail "release notes required; users see them in the update dialog"

echo "== preflight =="
command -v gh >/dev/null || fail "gh CLI not installed"
gh auth status >/dev/null 2>&1 || fail "gh not authenticated; run: gh auth login"
[ "$(git branch --show-current)" = "main" ] || fail "not on main"
# Untracked files don't block a release; modified tracked files do.
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "working tree has uncommitted changes; commit or stash first"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not synced with origin/main; push or pull first"
git rev-parse "v$VERSION" >/dev/null 2>&1 && fail "tag v$VERSION already exists"

CURRENT=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
python3 -c "
import sys
def key(v): return [int(x) for x in v.split('.')]
sys.exit(0 if key('$VERSION') > key('$CURRENT') else 1)
" || fail "version $VERSION is not greater than current $CURRENT"

# One fetch, then grep the string: `gh | grep -q` under pipefail dies of
# SIGPIPE whenever the match is not the last line grep reads.
SECRETS=$(gh secret list --repo "$REPO")
for s in TAURI_SIGNING_PRIVATE_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  grep -q "^$s" <<<"$SECRETS" || fail "repo secret $s missing"
done
echo "preflight ok: $CURRENT -> $VERSION"

echo "== bump version =="
python3 - "$VERSION" <<'PY'
import json, sys
v = sys.argv[1]
p = 'src-tauri/tauri.conf.json'
c = json.load(open(p))
c['version'] = v
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
PY
python3 - "$VERSION" <<'PY'
import re, sys
v = sys.argv[1]
p = 'src-tauri/Cargo.toml'
text = open(p).read()
open(p, 'w').write(re.sub(r'^version = "[^"]+"', f'version = "{v}"', text, count=1, flags=re.M))
PY
# Keep Cargo.lock's own entry in sync so the release build does not dirty the tree.
(cd src-tauri && cargo update -q --package app 2>/dev/null) || true
git diff --stat | sed 's/^/  /'

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "== dry run: reverting bump, nothing pushed =="
  git checkout -- src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
  exit 0
fi

echo "== commit and tag =="
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
git commit -m "release: v$VERSION"
git tag -a "v$VERSION" -m "$NOTES"
git push origin main
git push origin "v$VERSION"

echo "== waiting for the Release workflow to start =="
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID=$(gh run list --repo "$REPO" --workflow Release --event push --limit 5 \
    --json databaseId,headBranch --jq ".[] | select(.headBranch == \"v$VERSION\") | .databaseId" | head -1)
  [ -n "$RUN_ID" ] && break
  sleep 10
done
[ -n "$RUN_ID" ] || fail "release run for v$VERSION never appeared; check: gh run list --repo $REPO"
echo "run: https://github.com/$REPO/actions/runs/$RUN_ID"

echo "== watching (mac + windows builds, usually 10-25 min) =="
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status --interval 30; then
  echo ""
  echo "== RELEASE FAILED — failing step log =="
  gh run view "$RUN_ID" --repo "$REPO" --log-failed | tail -60
  fail "workflow failed; tag v$VERSION is pushed but nothing was published. Fix the cause, delete the tag (git push origin :refs/tags/v$VERSION && git tag -d v$VERSION), and re-run ship.sh"
fi

echo "== verifying published manifest =="
sleep 5
MANIFEST=$(curl -sf "$BASE_URL/latest.json") || fail "workflow succeeded but $BASE_URL/latest.json is unreachable"
MANIFEST_JSON="$MANIFEST" python3 - "$VERSION" <<'PY' || fail "manifest verification failed"
import json, os, sys
m = json.loads(os.environ["MANIFEST_JSON"])
want = sys.argv[1]
assert m.get("version") == want, f"manifest has {m.get('version')}, expected {want}"
plats = sorted(m.get("platforms", {}).keys())
print(f"published v{want} with platforms: {', '.join(plats)}")
missing = {"darwin-aarch64", "darwin-x86_64", "windows-x86_64"} - set(plats)
if missing:
    print(f"WARNING: missing platforms: {', '.join(sorted(missing))}", file=sys.stderr)
PY

echo "== done: v$VERSION is live; apps see it on next launch =="
