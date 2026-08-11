# The cleaner moved

The standalone Manga Cleaner application — design docs, prototype, and all future
implementation — now lives in its own repository:

    ~/dev/manga-cleaner

It was split out so that cleaning is a complete product rather than a mode. This
repository (the typesetter) is unaffected: its Clean mode is not removed, not
refactored, and not maintained.

Some cleaner docs cite files here as historical references — `src/lib/exporter.js`,
`python/sidecar/detect.py`, `docs/flux-ab/`. Those are references, not dependencies;
the two projects share no build.

One item in the cleaner's plan applies to **this** repository and does not wait for
it: `docs/07-build-plan.md` Phase −1 records that a GPL-3.0 detector ships in-process
here while the repo declares no licence, has no `license` field, and gives no
attribution.
