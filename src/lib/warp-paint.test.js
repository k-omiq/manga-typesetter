import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  warpPlan,
  warpBoxCanvas,
  expandTriangle,
  WARP_PAD,
  WARP_SUB,
  SEAM_OVERDRAW,
} from './warp-paint.js';
import { identityMesh, warpPoint, solveHomography, applyHomography } from './warp.js';
import { renderPageCanvas, paintWarpedBox } from './exporter.js';
import { loadProjectPages, app } from './store.svelte.js';
import { normalizeStyle } from './data.js';

// ===========================================================================
// A canvas that actually rasterises
// ===========================================================================
// The warp pass is only visible in pixels, and node has no canvas, so this is
// the smallest renderer the pass can be driven through: a transform stack, a
// clip stack, and a drawImage that SUPERSAMPLES its coverage. The
// supersampling is the point - a seam is an antialiasing artefact, two clipped
// triangles each covering half of the pixels along their shared edge and
// compositing to three quarters, and a renderer that snapped coverage to 0 or
// 1 could not show it at all.
//
// Colour is premultiplied float, which is what makes "is there a pinhole here"
// a question about one number.

const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
const inv = (m) => {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
};
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

// #rgb, #rrggbb and rgba() - everything the styles under test can produce.
function parseColor(css) {
  if (typeof css !== 'string') return [0, 0, 0, 1];
  const s = css.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const n = h.length === 3 ? h.split('').map((c) => c + c) : h.match(/../g) ?? ['00', '00', '00'];
    return [parseInt(n[0], 16) / 255, parseInt(n[1], 16) / 255, parseInt(n[2], 16) / 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [(p[0] ?? 0) / 255, (p[1] ?? 0) / 255, (p[2] ?? 0) / 255, p[3] ?? 1];
}

// Pixel centres per axis inside one destination pixel. Sixteen samples is
// enough to see a half-covered pixel as a half and not as a quantisation step.
const SUB = 4;

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function canvasOf(w0, h0) {
  // `width`/`height` reallocate and clear, exactly as a real canvas element's
  // do: every canvas in the exporter is minted empty and sized afterwards, and
  // the memory discipline in there hands pixels back by setting them to zero.
  const cnv = {
    _w: 0,
    _h: 0,
    px: new Float64Array(0),
    get width() {
      return this._w;
    },
    set width(v) {
      this._w = Math.max(0, Math.round(v) || 0);
      this.px = new Float64Array(this._w * this._h * 4);
    },
    get height() {
      return this._h;
    },
    set height(v) {
      this._h = Math.max(0, Math.round(v) || 0);
      this.px = new Float64Array(this._w * this._h * 4);
    },
  };
  cnv.width = w0;
  cnv.height = h0;
  const ctx = {
    m: { ...IDENT },
    clips: [],
    stack: [],
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 0,
    lineJoin: '',
    miterLimit: 0,
    font: '10px sans',
    textAlign: 'left',
    textBaseline: 'top',
    letterSpacing: '0px',
    filter: 'none',
    globalCompositeOperation: 'source-over',
    imageSmoothingQuality: '',
    get canvas() {
      return cnv;
    },
    save() {
      this.stack.push({
        m: { ...this.m },
        clips: this.clips.slice(),
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        filter: this.filter,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    },
    restore() {
      const s = this.stack.pop();
      if (s) Object.assign(this, s);
    },
    getTransform() {
      return { ...this.m };
    },
    setTransform(a, b, c, d, e, f) {
      this.m = typeof a === 'object' ? { ...a } : { a, b, c, d, e, f };
    },
    transform(a, b, c, d, e, f) {
      this.m = mul(this.m, { a, b, c, d, e, f });
    },
    scale(x, y) {
      this.m = mul(this.m, { ...IDENT, a: x, d: y });
    },
    translate(x, y) {
      this.m = mul(this.m, { ...IDENT, e: x, f: y });
    },
    rotate(r) {
      this.m = mul(this.m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
    },
    beginPath() {
      this.path = [];
    },
    moveTo(x, y) {
      this.path = [apply(this.m, x, y)];
    },
    lineTo(x, y) {
      (this.path ??= []).push(apply(this.m, x, y));
    },
    rect(x, y, rw, rh) {
      this.path = [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]].map(([qx, qy]) =>
        apply(this.m, qx, qy),
      );
    },
    arc() {},
    closePath() {},
    clip() {
      if (this.path?.length >= 3) this.clips = [...this.clips, this.path];
    },
    fill() {},
    createPattern() {
      return null;
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    // Every painted pixel goes through here: `cover` answers, for one device
    // pixel, how much of it this draw covers and in what colour.
    paint(x0, y0, x1, y1, cover) {
      // Clipped away before it is sampled: a warped box draws its whole texture
      // through every triangle, and rasterising each of those over the full
      // footprint rather than over the clip is the difference between this file
      // running in a second and running in a minute.
      let lo = x0;
      let to = y0;
      let hi = x1;
      let bo = y1;
      for (const poly of this.clips) {
        lo = Math.max(lo, Math.min(...poly.map((q) => q[0])));
        to = Math.max(to, Math.min(...poly.map((q) => q[1])));
        hi = Math.min(hi, Math.max(...poly.map((q) => q[0])));
        bo = Math.min(bo, Math.max(...poly.map((q) => q[1])));
      }
      const ax = Math.max(0, Math.floor(lo));
      const ay = Math.max(0, Math.floor(to));
      const bx = Math.min(cnv.width - 1, Math.ceil(hi));
      const by = Math.min(cnv.height - 1, Math.ceil(bo));
      for (let py = ay; py <= by; py++) {
        for (let pxi = ax; pxi <= bx; pxi++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const dx = pxi + (sx + 0.5) / SUB;
              const dy = py + (sy + 0.5) / SUB;
              let clipped = false;
              for (const poly of this.clips) {
                if (!inPoly(poly, dx, dy)) {
                  clipped = true;
                  break;
                }
              }
              if (clipped) continue;
              const c = cover(dx, dy);
              if (!c) continue;
              r += c[0] * c[3];
              g += c[1] * c[3];
              b += c[2] * c[3];
              a += c[3];
            }
          }
          if (a <= 0) continue;
          const n = SUB * SUB;
          const sa = (a / n) * this.globalAlpha;
          const i = (py * cnv.width + pxi) * 4;
          const keep = 1 - sa;
          cnv.px[i] = (r / n) * this.globalAlpha + cnv.px[i] * keep;
          cnv.px[i + 1] = (g / n) * this.globalAlpha + cnv.px[i + 1] * keep;
          cnv.px[i + 2] = (b / n) * this.globalAlpha + cnv.px[i + 2] * keep;
          cnv.px[i + 3] = sa + cnv.px[i + 3] * keep;
        }
      }
    },
    box(x, y, bw, bh) {
      const corners = [[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]].map(([qx, qy]) =>
        apply(this.m, qx, qy),
      );
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      return { corners, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    },
    fillRect(x, y, bw, bh) {
      const [r, g, b, a] = parseColor(typeof this.fillStyle === 'string' ? this.fillStyle : '#000000');
      const q = this.box(x, y, bw, bh);
      this.paint(q.x0, q.y0, q.x1, q.y1, (dx, dy) => (inPoly(q.corners, dx, dy) ? [r, g, b, a] : null));
    },
    clearRect(x, y, bw, bh) {
      const q = this.box(x, y, bw, bh);
      for (let py = Math.max(0, Math.floor(q.y0)); py <= Math.min(cnv.height - 1, Math.ceil(q.y1) - 1); py++) {
        for (let pxi = Math.max(0, Math.floor(q.x0)); pxi <= Math.min(cnv.width - 1, Math.ceil(q.x1) - 1); pxi++) {
          const i = (py * cnv.width + pxi) * 4;
          cnv.px[i] = cnv.px[i + 1] = cnv.px[i + 2] = cnv.px[i + 3] = 0;
        }
      }
    },
    // Glyphs stand in as one block per line: what is under test is where the
    // picture goes, and a font would only make that harder to read off.
    fillText(text, x, y) {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10');
      const wid = String(text).length * size * 0.6;
      const left = this.textAlign === 'center' ? x - wid / 2 : this.textAlign === 'right' ? x - wid : x;
      const top = this.textBaseline === 'middle' ? y - size / 2 : y;
      this.fillRect(left, top, wid, size);
    },
    strokeText() {},
    drawImage(src, dx = 0, dy = 0, dw = src.width, dh = src.height) {
      if (!src?.width || !src?.height) return;
      const back = inv(this.m);
      const q = this.box(dx, dy, dw, dh);
      this.paint(q.x0, q.y0, q.x1, q.y1, (px2, py2) => {
        const [lx, ly] = apply(back, px2, py2);
        const u = Math.floor(((lx - dx) / dw) * src.width);
        const v = Math.floor(((ly - dy) / dh) * src.height);
        if (u < 0 || v < 0 || u >= src.width || v >= src.height) return null;
        const j = (v * src.width + u) * 4;
        const a = src.px[j + 3];
        if (a <= 0) return null;
        // Back to straight colour: `paint` premultiplies again.
        return [src.px[j] / a, src.px[j + 1] / a, src.px[j + 2] / a, a];
      });
    },
    getImageData(x, y, gw, gh) {
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const s = ((y + j) * cnv.width + (x + i)) * 4;
          const t = (j * gw + i) * 4;
          const a = cnv.px[s + 3];
          data[t] = a > 0 ? (cnv.px[s] / a) * 255 : 0;
          data[t + 1] = a > 0 ? (cnv.px[s + 1] / a) * 255 : 0;
          data[t + 2] = a > 0 ? (cnv.px[s + 2] / a) * 255 : 0;
          data[t + 3] = a * 255;
        }
      }
      return { width: gw, height: gh, data };
    },
    createImageData(gw, gh) {
      return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
    },
    putImageData(img, x = 0, y = 0) {
      for (let j = 0; j < img.height; j++) {
        for (let i = 0; i < img.width; i++) {
          const s = (j * img.width + i) * 4;
          const t = ((y + j) * cnv.width + (x + i)) * 4;
          const a = img.data[s + 3] / 255;
          cnv.px[t] = (img.data[s] / 255) * a;
          cnv.px[t + 1] = (img.data[s + 1] / 255) * a;
          cnv.px[t + 2] = (img.data[s + 2] / 255) * a;
          cnv.px[t + 3] = a;
        }
      }
    },
  };
  cnv.getContext = () => ctx;
  return cnv;
}

const at = (cnv, x, y) => {
  const i = (Math.round(y) * cnv.width + Math.round(x)) * 4;
  const a = cnv.px[i + 3];
  return a > 0 ? [cnv.px[i] / a, cnv.px[i + 1] / a, cnv.px[i + 2] / a, a] : [0, 0, 0, 0];
};
const alphaAt = (cnv, x, y) => cnv.px[(Math.round(y) * cnv.width + Math.round(x)) * 4 + 3];

// The box, and the four quadrant colours a probe reads back. The texture is the
// exporter's own shape: a footprint with the box rect inside it, `ox`/`oy` in
// from its top-left corner.
const W = 100;
const H = 100;
const PAD = 20;
const RED = [1, 0, 0];
const GREEN = [0, 1, 0];
const BLUE = [0, 0, 1];
const YELLOW = [1, 1, 0];

function quadTexture(ss = 1) {
  const cnv = canvasOf((W + PAD * 2) * ss, (H + PAD * 2) * ss);
  const ctx = cnv.getContext('2d');
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.translate(PAD, PAD); // box-local (0,0)
  const put = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, W / 2, H / 2);
  };
  put(0, 0, '#ff0000');
  put(W / 2, 0, '#00ff00');
  put(0, H / 2, '#0000ff');
  put(W / 2, H / 2, '#ffff00');
  return cnv;
}

function flatTexture(ss = 1, color = '#101010') {
  const cnv = canvasOf((W + PAD * 2) * ss, (H + PAD * 2) * ss);
  const ctx = cnv.getContext('2d');
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.translate(PAD, PAD);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return cnv;
}

const warpArgs = (warp, extra = {}) => ({
  warp,
  w: W,
  h: H,
  ox: PAD,
  oy: PAD,
  cw: W + PAD * 2,
  ch: H + PAD * 2,
  makeCanvas: canvasOf,
  ...extra,
});

// The bottom-right corner dragged to (120, 140) - the same worked example
// warp.test.js hand-computes its triangles from.
const DRAG = { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [0, 100], [120, 140]] };

// ===========================================================================

describe('expandTriangle', () => {
  // How far a point is from the line through a and b, signed towards `away`.
  const dist = (a, b, away, p) => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    let nx = ey / len;
    let ny = -ex / len;
    if (nx * (away[0] - a[0]) + ny * (away[1] - a[1]) > 0) {
      nx = -nx;
      ny = -ny;
    }
    return nx * (p[0] - a[0]) + ny * (p[1] - a[1]);
  };

  it('pushes every EDGE out by exactly `pad`, which is what closes a seam', () => {
    // Half a cell, cut along its diagonal: the shape the painter actually
    // draws, and the one a centroid-relative expansion moves the diagonal of by
    // less than it moves the legs.
    const tri = [[0, 0], [10, 0], [10, 10]];
    const out = expandTriangle(tri, 0.75);
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const away = tri[(i + 2) % 3];
      // Both endpoints of the grown edge sit 0.75 outside the original line.
      expect(dist(a, b, away, out[i])).toBeCloseTo(0.75, 10);
      expect(dist(a, b, away, out[(i + 1) % 3])).toBeCloseTo(0.75, 10);
    }
  });

  it('contains the triangle it grew from', () => {
    const tri = [[0, 0], [10, 0], [10, 10]];
    const out = expandTriangle(tri, 0.75);
    for (const p of tri) expect(inPoly(out, p[0], p[1])).toBe(true);
  });

  it('leaves the triangle alone when there is nothing to grow it by', () => {
    expect(expandTriangle([[0, 0], [10, 0], [0, 10]], 0)).toEqual([[0, 0], [10, 0], [0, 10]]);
  });

  it('hands a triangle with no area back untouched rather than dividing by zero', () => {
    expect(expandTriangle([[0, 0], [0, 0], [0, 0]], 1)).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(expandTriangle([[0, 0], [5, 5], [10, 10]], 1)).toEqual([[0, 0], [5, 5], [10, 10]]);
    expect(expandTriangle([[0, 0], [1, 0], [NaN, 2]], 1)).toEqual([[0, 0], [1, 0], [NaN, 2]]);
  });
});

describe('warpPlan', () => {
  it('is null when the mesh does nothing', () => {
    expect(warpPlan({ on: true, cols: 1, rows: 1, pts: [] }, W, H)).toBeNull();
    expect(warpPlan({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H) }, W, H)).toBeNull();
    expect(warpPlan(DRAG, 0, 0)).toBeNull();
  });

  it('carries the control points themselves, exactly, for a grid', () => {
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p));
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts }, W, H);
    expect(plan.projective).toBe(false);
    // Every control point is somewhere in the destination, to the bit.
    const flat = plan.tris.flatMap((t) => t.dst).map((p) => `${p[0]},${p[1]}`);
    for (const p of pts) expect(flat).toContain(`${p[0]},${p[1]}`);
  });

  it('splits every cell into two triangles that share the cell diagonal', () => {
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p));
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts }, W, H);
    // No band: the source rect is the box rect, so 2x2 cells and no more.
    expect(plan.tris).toHaveLength(8);
    for (let i = 0; i < plan.tris.length; i += 2) {
      const a = plan.tris[i];
      const b = plan.tris[i + 1];
      // (tl, tr, br) then (tl, br, bl): the diagonal is tl->br in both, as the
      // same coordinates rather than as two roundings of one point.
      expect(a.dst[0]).toEqual(b.dst[0]);
      expect(a.dst[2]).toEqual(b.dst[1]);
      expect(a.src[0]).toEqual(b.src[0]);
      expect(a.src[2]).toEqual(b.src[1]);
    }
  });

  it('adds a ring of cells for the footprint the box overflows into', () => {
    const rect = { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 };
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p)) }, W, H, rect);
    // Two lines added on each axis, so 4x4 cells instead of 2x2.
    expect(plan.tris).toHaveLength(32);
    const srcPts = plan.tris.flatMap((t) => t.src).map((p) => `${p[0]},${p[1]}`);
    expect(srcPts).toContain(`${-PAD},${-PAD}`);
    expect(srcPts).toContain(`${W + PAD},${H + PAD}`);
  });

  it('takes the projective route for a four-handle quad that is not a parallelogram', () => {
    const plan = warpPlan(DRAG, W, H);
    expect(plan.projective).toBe(true);
    // 8x8 virtual cells, two triangles each.
    expect(plan.tris).toHaveLength(2 * WARP_SUB * WARP_SUB);
  });

  it('puts the middle of that quad where the homography says, not where the two triangles do', () => {
    // The crease, in numbers. A 1x1 mesh whose right edge is pulled in to 2/3
    // (the trapezoid warp.test.js solves by hand, at 100px): the projective map
    // sends the box centre to (40, 40), while reading the cell as two triangles
    // sends it to (100/3, 100/3) - three and a third pixels of fold.
    const pts = [[0, 0], [200 / 3, 0], [0, 100], [200 / 3, 200 / 3]];
    const warp = { on: true, cols: 1, rows: 1, pts };
    const plan = warpPlan(warp, W, H);
    expect(plan.projective).toBe(true);
    // The virtual grid's centre point is a cell corner, so it is in the list.
    const dst = plan.tris.flatMap((t, i) => t.dst.map((p, k) => ({ p, src: t.src[k] })));
    const mid = dst.find(({ src }) => src[0] === 50 && src[1] === 50);
    expect(mid.p[0]).toBeCloseTo(40, 6);
    expect(mid.p[1]).toBeCloseTo(40, 6);
    // Which is not what the affine reading of the same quad gives.
    const [ax, ay] = warpPoint(pts, 1, 1, W, H, 50, 50);
    expect(ax).toBeCloseTo(100 / 3, 6);
    expect(ay).toBeCloseTo(100 / 3, 6);
  });

  it('stays affine for a parallelogram, where both maps are the same map', () => {
    // A shear: no perspective, so nothing to subdivide for.
    const plan = warpPlan({ on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [30, 100], [130, 100]] }, W, H);
    expect(plan.projective).toBe(false);
    expect(plan.tris).toHaveLength(2);
  });

  it('falls back to the triangles for a quad no projective map fits', () => {
    // Bottom-left dragged past the diagonal: a crossed quad, which has no
    // homography onto it. Better a crease than nothing on the page.
    const plan = warpPlan({ on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [140, 60], [120, 140]] }, W, H);
    expect(plan.projective).toBe(false);
    expect(plan.tris).toHaveLength(2);
  });

  it('bounds the destination by what the mesh actually covers', () => {
    expect(warpPlan(DRAG, W, H).bounds).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 140 });
  });
});

describe('warpBoxCanvas', () => {
  it('hands back null for a mesh that changes nothing, so the caller keeps its texture', () => {
    expect(warpBoxCanvas(flatTexture(), warpArgs({ on: true, cols: 1, rows: 1, pts: [] }))).toBeNull();
    expect(
      warpBoxCanvas(flatTexture(), warpArgs({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H) })),
    ).toBeNull();
  });

  it('sizes the destination from the deformed mesh, padded for the AA bleed', () => {
    const rect = { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 };
    const b = warpPlan(DRAG, W, H, rect).bounds;
    const out = warpBoxCanvas(quadTexture(), warpArgs(DRAG));
    // Two page px past everything the mesh covers - the band around the box
    // rect included, which is where the overflow went - and snapped outwards to
    // whole px so the box's origin inside the bitmap stays an integer.
    expect(out.ox).toBe(-Math.floor(b.minX - WARP_PAD));
    expect(out.oy).toBe(-Math.floor(b.minY - WARP_PAD));
    expect(out.cw).toBe(Math.ceil(b.maxX + WARP_PAD) - Math.floor(b.minX - WARP_PAD));
    expect(out.ch).toBe(Math.ceil(b.maxY + WARP_PAD) - Math.floor(b.minY - WARP_PAD));
    expect(out.canvas.width).toBe(out.cw);
    expect(out.canvas.height).toBe(out.ch);
    // The dragged corner is 20px right and 40px below the box, and the bitmap
    // holds all of it: nothing the mesh moved is cropped off.
    expect(out.cw - out.ox).toBeGreaterThanOrEqual(120 + WARP_PAD);
    expect(out.ch - out.oy).toBeGreaterThanOrEqual(140 + WARP_PAD);
  });

  it('lands the probes where the mesh says - hand-computed, three of them', () => {
    // The 1x1 drag is not a parallelogram, so the painter draws it projectively;
    // these probes are read against that map, which is exact at the corners the
    // gizmo actually dragged.
    const out = warpBoxCanvas(quadTexture(), warpArgs(DRAG));
    const h = solveHomography(
      [[0, 0], [W, 0], [W, H], [0, H]],
      [DRAG.pts[0], DRAG.pts[1], DRAG.pts[3], DRAG.pts[2]],
    );
    const probe = (sx, sy) => {
      const [x, y] = applyHomography(h, sx, sy);
      return at(out.canvas, x + out.ox, y + out.oy);
    };
    // One probe per quadrant of the source, well inside it.
    expect(probe(25, 25).slice(0, 3)).toEqual(RED);
    expect(probe(75, 25).slice(0, 3)).toEqual(GREEN);
    expect(probe(25, 75).slice(0, 3)).toEqual(BLUE);
    expect(probe(75, 75).slice(0, 3)).toEqual(YELLOW);
    // And the corner the user dragged carries the colour that was under it: the
    // box's bottom-right pixel is now at (120, 140).
    expect(at(out.canvas, 118 + out.ox, 137 + out.oy).slice(0, 3)).toEqual(YELLOW);
    // Outside the quad the box has become, nothing is painted at all: (10, 135)
    // is below the edge from (0, 100) to (120, 140), which passes through
    // y = 103.3 there.
    expect(alphaAt(out.canvas, 10 + out.ox, 135 + out.oy)).toBe(0);
  });

  it('carries a piecewise-affine grid the way its own triangles say', () => {
    // A 2x2 mesh, so the mapping is `warpPoint`'s, and the probes are read
    // straight off it.
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [30, 60] : p));
    const out = warpBoxCanvas(quadTexture(), warpArgs({ on: true, cols: 2, rows: 2, pts }));
    for (const [sx, sy, want] of [[20, 20, RED], [80, 20, GREEN], [80, 80, YELLOW]]) {
      const [x, y] = warpPoint(pts, 2, 2, W, H, sx, sy);
      expect(at(out.canvas, x + out.ox, y + out.oy).slice(0, 3)).toEqual(want);
    }
  });

  it('carries the overflow outside the box rect instead of cropping it', () => {
    // Ink drawn over the box edge, or a glyph hanging out of it: the band cells
    // are what keep it. A texture with paint in the margin, and the margin is
    // still there afterwards.
    const src = flatTexture();
    const sctx = src.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.translate(PAD, PAD);
    sctx.fillStyle = '#00ff00';
    sctx.fillRect(-10, 10, 10, 10); // a strip 10px left of the box
    const out = warpBoxCanvas(src, warpArgs(DRAG));
    const [x, y] = warpPoint(DRAG.pts, 1, 1, W, H, -5, 15);
    expect(at(out.canvas, x + out.ox, y + out.oy).slice(0, 3)).toEqual(GREEN);
  });
});

describe('the seams between cells', () => {
  // A mesh with every interior handle pulled somewhere different, which is the
  // worst case for the joins: nine cells, twelve interior edges, and four
  // T-junctions where four triangles meet at a point.
  const pts = identityMesh(3, 3, W, H).map(([x, y], i) => [
    x + (i % 3) * 4 - 4,
    y + ((i * 7) % 5) * 3 - 6,
  ]);
  const warp = { on: true, cols: 3, rows: 3, pts };

  // Which pixels are interior: a pixel whose four corners, pushed out by a
  // margin, are all inside the deformed outline. The margin keeps the box's own
  // antialiased edge - which is not a seam - out of the scan.
  const outline = () => {
    const n = 4;
    const ring = [];
    for (let i = 0; i < n; i++) ring.push(pts[i]);
    for (let j = 1; j < n; j++) ring.push(pts[j * n + n - 1]);
    for (let i = n - 2; i >= 0; i--) ring.push(pts[(n - 1) * n + i]);
    for (let j = n - 2; j >= 1; j--) ring.push(pts[j * n]);
    return ring;
  };

  const scan = (overdraw) => {
    const out = warpBoxCanvas(flatTexture(1, '#000000'), warpArgs(warp, { overdraw }));
    const ring = outline();
    const m = 2.5;
    let worst = 1;
    let holes = 0;
    for (let y = 0; y < out.canvas.height; y++) {
      for (let x = 0; x < out.canvas.width; x++) {
        const cx = x + 0.5 - out.ox;
        const cy = y + 0.5 - out.oy;
        const inside = [[-m, -m], [m, -m], [m, m], [-m, m]].every(([dx, dy]) =>
          inPoly(ring, cx + dx, cy + dy),
        );
        if (!inside) continue;
        const a = alphaAt(out.canvas, x, y);
        if (a < worst) worst = a;
        if (a < 0.999) holes++;
      }
    }
    return { worst, holes };
  };

  it('leaves no pinhole anywhere inside a warped flat-colour box', () => {
    const { worst, holes } = scan(SEAM_OVERDRAW);
    expect(holes).toBe(0);
    expect(worst).toBe(1);
  });

  it('is the overdraw guard that does it - without one the joins show', () => {
    // The control case, and the reason the guard is not cargo cult: with the
    // clips drawn exactly on their triangles, the shared edges composite to
    // about three quarters and the background reads through.
    const { worst, holes } = scan(0);
    expect(holes).toBeGreaterThan(20);
    expect(worst).toBeLessThan(0.85);
  });
});

// ===========================================================================
// The editor and the exporter draw the same box
// ===========================================================================

describe('warped parity: the editor canvas is the exported crop', () => {
  const realDocument = globalThis.document;
  const realImage = globalThis.Image;

  beforeEach(() => {
    globalThis.document = {
      fonts: { ready: Promise.resolve() },
      // The canvases are the renderer above; the div and the range are what
      // `wrapLinesDOM` measures its breaks with, and answering "no rectangles"
      // is what keeps the sample text on one line here.
      createElement: (tag) =>
        tag === 'canvas' ? canvasOf(0, 0) : { style: {}, firstChild: null, remove() {} },
      createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
      body: { appendChild() {} },
    };
    globalThis.Image = class {
      set src(_v) {
        queueMicrotask(() => this.onerror?.(new Error('no art in this test')));
      }
    };
  });
  afterEach(() => {
    globalThis.document = realDocument;
    globalThis.Image = realImage;
  });

  const boxOf = () => ({
    id: 1,
    x: 120,
    y: 90,
    w: W,
    h: H,
    text: 'AB',
    style: normalizeStyle({ size: 40, color: '#000000', warp: DRAG }),
  });

  it('draws the same pixels in the editor at zoom 1 as the page composite does', async () => {
    const box = boxOf();
    loadProjectPages([{ id: 7, w: 400, h: 300, lines: [], boxes: [box] }]);
    const p = app.pages[0];
    const pageCnv = await renderPageCanvas(p);

    const el = canvasOf(0, 0);
    const geom = paintWarpedBox(el, p.boxes[0], p, 1, null);
    // Where the page composite put that same bitmap.
    const originX = Math.round(box.x - geom.ox);
    const originY = Math.round(box.y - geom.oy);
    expect(el.width).toBe(geom.cw);
    expect(el.height).toBe(geom.ch);

    let inked = 0;
    let worst = 0;
    for (let y = 0; y < el.height; y++) {
      for (let x = 0; x < el.width; x++) {
        const e = at(el, x, y);
        const pg = at(pageCnv, originX + x, originY + y);
        if (e[3] > 0) inked++;
        // The page has a white sheet under the box; the editor canvas is
        // transparent. Composite the editor's pixel over white and the two are
        // the same picture.
        for (let c = 0; c < 3; c++) {
          const over = e[c] * e[3] + 1 * (1 - e[3]);
          worst = Math.max(worst, Math.abs(over - (pg[c] * pg[3] + 1 * (1 - pg[3]))));
        }
      }
    }
    // The box actually painted something, and every pixel of it agrees.
    expect(inked).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1e-9);
  });

  it('places the warped bitmap by the mesh, not by the box rect', async () => {
    const box = boxOf();
    loadProjectPages([{ id: 7, w: 400, h: 300, lines: [], boxes: [box] }]);
    const p = app.pages[0];
    const el = canvasOf(0, 0);
    const warpGeom = paintWarpedBox(el, p.boxes[0], p, 1, null);

    // The same box with the warp switched off, for the footprint it would have
    // had. The mesh drags the bottom-right corner 20px right and 40px down, so
    // the warped footprint has to be that much bigger.
    p.boxes[0].style.warp.on = false;
    const flat = canvasOf(0, 0);
    const flatGeom = paintWarpedBox(flat, p.boxes[0], p, 1, null);
    expect(warpGeom.cw - flatGeom.cw).toBeGreaterThanOrEqual(20);
    expect(warpGeom.ch - flatGeom.ch).toBeGreaterThanOrEqual(40);
  });
});
