# Releasing

One command releases the app to all users:

```bash
./scripts/ship.sh 0.2.0 "What changed, shown to users in the update dialog"
```

It bumps the version, commits, tags, pushes, watches the GitHub Actions
Release workflow (mac arm + intel + windows builds), prints the failing log
if anything breaks, and verifies https://typesetter.komiq.cc/latest.json
serves the new version. Add `--dry-run` as a third argument to rehearse the
preflight and version bump without pushing.

Installed apps check that URL on launch and show an "Update available"
badge; release notes come from the tag message ship.sh creates.

## Requirements

- `gh` authenticated with push access to gecallidryas/manga-typesetter.
- Repo secrets already set: `TAURI_SIGNING_PRIVATE_KEY`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (ship.sh checks).
- Clean working tree on an up-to-date `main`.

## If the workflow fails

ship.sh prints the failing step's log. The tag is already pushed but nothing
was published; after fixing the cause, delete and re-ship:

```bash
git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
./scripts/ship.sh X.Y.Z "notes"
```

## Alternate path

`./scripts/release.sh "notes"` builds and publishes from the local machine
only (current platform only, no CI). Use it only when CI is unavailable.
The updater signing key must exist at `~/.tauri/typesetter-updater.key`.
