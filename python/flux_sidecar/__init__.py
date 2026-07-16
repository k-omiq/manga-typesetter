"""Out-of-process FLUX inpainting sidecar (opt-in, heavy).

This is a *separate* loopback HTTP service from the base ``mt-sidecar``. It hosts
only the FLUX redraw path — MangaTranslator's ``FluxKleinInpainter`` /
``FluxKontextInpainter`` and the diffusers/sdnq (or sdcpp) stack they need — so
that heavy dependency tree never has to live inside the frozen base app.

The base sidecar spawns this process on demand (see ``sidecar/flux_proxy.py``)
and proxies region crops to it over loopback. The process runs under an
*external*, user-provisioned Python environment (see ``sidecar/flux.py``'s uv
provisioning), which is why a packaged/frozen base app can host FLUX at all: the
deps are installed into a real interpreter, not the frozen one.

Model choice (family / variant / backend / quant / HF token) is passed in via
the environment at spawn time — see :mod:`flux_sidecar.config`.
"""
