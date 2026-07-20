import { CELL } from './geom';

// --- warp noise ---------------------------------------------------------------
// Smooth value noise anchored to map pixels. Outside god mode the tool square
// is drawn through a fixed slice of this field, so its apparent shape undulates
// as it moves across the world; the whole map view is composited through a
// slowly time-evolving slice (the "lake" effect). Purely cosmetic — the real
// region stays a square and the world itself never moves.

function latticeHash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

// 2D slice at integer time iz
function valueNoise(x: number, y: number, iz: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = latticeHash(ix, iy, iz, seed);
  const b = latticeHash(ix + 1, iy, iz, seed);
  const c = latticeHash(ix, iy + 1, iz, seed);
  const d = latticeHash(ix + 1, iy + 1, iz, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// A lattice corner's value over time: Catmull-Rom through its own hashed
// keyframe sequence, on its own hashed phase-shifted clock. Both matter:
// smoothstep between two keyframes has zero velocity at every keyframe, and
// with a shared clock the whole field would visibly freeze in sync once per
// 1/speed seconds. Catmull-Rom keeps velocity nonzero through keyframes, and
// the per-corner phase means no two corners hit keyframes together anyway.
function cornerWave(ix: number, iy: number, z: number, seed: number): number {
  const zc = z + latticeHash(ix, iy, 0, seed ^ 0x5bf03635);
  const i = Math.floor(zc);
  const f = zc - i;
  const p0 = latticeHash(ix, iy, i - 1, seed);
  const p1 = latticeHash(ix, iy, i, seed);
  const p2 = latticeHash(ix, iy, i + 1, seed);
  const p3 = latticeHash(ix, iy, i + 2, seed);
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

// displacement (in px) of the static tool-square warp field at map-pixel (px, py)
export function warpOffset(px: number, py: number, ampPx: number, scalePx: number): [number, number] {
  return [
    (valueNoise(px / scalePx, py / scalePx, 0, 0x9e3779b9) * 2 - 1) * ampPx,
    (valueNoise(px / scalePx, py / scalePx, 0, 0x7f4a7c15) * 2 - 1) * ampPx,
  ];
}

// One layer of the lake: an independent noise field with its own feature
// size, displacement amplitude, evolution rate, and a directional drift that
// makes its ripples travel across the map.
export interface LakeLayer {
  waveDir: number; // degrees; direction the ripples travel
  waveSpeed: number; // drift speed, cells per second
  magnitude: number; // displacement amplitude, cells
  wavelength: number; // feature size, cells
  timeScale: number; // pattern renewals per second
}

export const lakeIsStill = (layers: LakeLayer[]): boolean =>
  layers.every((l) => l.magnitude <= 0 || l.wavelength <= 0);

// A prepared per-frame snapshot of the layered ripple field: one entry per
// active layer, with the drift/time offsets baked in and a per-frame cache of
// lattice-corner values (they repeat across many samples).
export interface RipplePrep {
  ampPx: number;
  scalePx: number;
  ox: number;
  oy: number;
  z: number;
  seedX: number;
  seedY: number;
  corners: Map<number, [number, number]>;
}

// Different seedSalts give statistically-identical but uncorrelated fields —
// e.g. the selection boundary ripples like the lake but never agrees with it.
export const SELECTION_RIPPLE_SALT = 0x6a09e667;

export function prepRipple(layers: LakeLayer[], tSec: number, seedSalt = 0): RipplePrep[] {
  return layers
    .filter((l) => l.magnitude > 0 && l.wavelength > 0)
    .map((l, li) => {
      const rad = (l.waveDir * Math.PI) / 180;
      return {
        ampPx: l.magnitude * CELL,
        scalePx: l.wavelength * CELL,
        // sampling the field shifted by -t·v makes the pattern drift toward waveDir
        ox: -tSec * l.waveSpeed * Math.cos(rad) * CELL,
        oy: -tSec * l.waveSpeed * Math.sin(rad) * CELL,
        z: tSec * l.timeScale,
        seedX: (0x51ab3e97 ^ Math.imul(li + 1, 0x9e3779b9) ^ seedSalt) >>> 0,
        seedY: (0x2c1b3c6d ^ Math.imul(li + 1, 0x85ebca6b) ^ seedSalt) >>> 0,
        corners: new Map<number, [number, number]>(),
      };
    });
}

function cornerVec(p: RipplePrep, ix: number, iy: number): [number, number] {
  const key = ix * 0x10000 + iy;
  let v = p.corners.get(key);
  if (!v) {
    v = [cornerWave(ix, iy, p.z, p.seedX), cornerWave(ix, iy, p.z, p.seedY)];
    p.corners.set(key, v);
  }
  return v;
}

// displacement (in px) of the summed ripple field at map-pixel (px, py)
export function rippleAt(preps: RipplePrep[], px: number, py: number): [number, number] {
  let dx = 0;
  let dy = 0;
  for (const p of preps) {
    const nx = (px + p.ox) / p.scalePx;
    const ny = (py + p.oy) / p.scalePx;
    const ix = Math.floor(nx);
    const iy = Math.floor(ny);
    const fx = nx - ix;
    const fy = ny - iy;
    const sxw = fx * fx * (3 - 2 * fx);
    const syw = fy * fy * (3 - 2 * fy);
    const a = cornerVec(p, ix, iy);
    const b = cornerVec(p, ix + 1, iy);
    const c = cornerVec(p, ix, iy + 1);
    const d = cornerVec(p, ix + 1, iy + 1);
    const blend = (ch: 0 | 1) =>
      a[ch] + (b[ch] - a[ch]) * sxw + (c[ch] - a[ch]) * syw + (a[ch] - b[ch] - c[ch] + d[ch]) * sxw * syw;
    dx += (blend(0) * 2 - 1) * p.ampPx;
    dy += (blend(1) * 2 - 1) * p.ampPx;
  }
  return [dx, dy];
}

// Composite `src` onto `dst` through the time-varying lake field (the sum of
// all layers): each small tile of the destination samples the source
// displaced by the field at that spot, like looking at the map through the
// surface of a lake.
const LAKE_TILE = 2 * CELL; // px; small vs. the field's feature size, so seams stay sub-blur

export function drawLakeWarped(
  dst: HTMLCanvasElement, src: HTMLCanvasElement, tSec: number, layers: LakeLayer[],
): void {
  const ctx = dst.getContext('2d');
  if (!ctx) return;
  const w = src.width;
  const h = src.height;
  const preps = prepRipple(layers, tSec);
  for (let y = 0; y < h; y += LAKE_TILE) {
    for (let x = 0; x < w; x += LAKE_TILE) {
      const [dx, dy] = rippleAt(preps, x + LAKE_TILE / 2, y + LAKE_TILE / 2);
      const sx = Math.max(0, Math.min(w - LAKE_TILE, x + dx));
      const sy = Math.max(0, Math.min(h - LAKE_TILE, y + dy));
      ctx.drawImage(src, sx, sy, LAKE_TILE, LAKE_TILE, x, y, LAKE_TILE, LAKE_TILE);
    }
  }
}

// Set the current path to the closed polygon `pts` (in map px) with its
// perimeter displaced through the static warp field plus the given ripple
// field, sampled every few px so the wobble stays smooth.
export function traceWarpedPoly(
  ctx: CanvasRenderingContext2D,
  pts: Array<[number, number]>,
  ampPx: number, scalePx: number,
  preps: RipplePrep[],
): void {
  ctx.beginPath();
  if (pts.length === 0) return;
  let first = true;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      const [wx, wy] = ampPx > 0 ? warpOffset(px, py, ampPx, scalePx) : [0, 0];
      const [rx, ry] = rippleAt(preps, px, py);
      if (first) {
        ctx.moveTo(px + wx + rx, py + wy + ry);
        first = false;
      } else ctx.lineTo(px + wx + rx, py + wy + ry);
    }
  }
  ctx.closePath();
}

// Everything that fogs the player's view. Purely cosmetic — never affects
// the world or how input maps to it.
export interface Obscura {
  blurPx: number; // whole-canvas Gaussian blur, px
  toolBlur: number; // blur on the copy/erase selection, cells
  warpAmp: number; // static selection-edge warp amplitude, cells
  warpScale: number; // feature size of the selection warp field, cells
  lakeLayers: LakeLayer[];
}

export const DEFAULT_OBSCURA: Obscura = {
  blurPx: 3,
  toolBlur: 2,
  warpAmp: 2,
  warpScale: 10,
  lakeLayers: [
    // a big slow swell plus small quick ripples
    { waveDir: 20, waveSpeed: 1, magnitude: 1, wavelength: 18, timeScale: 0.8 },
    { waveDir: 20, waveSpeed: 2.5, magnitude: 1, wavelength: 7, timeScale: 1.2 },
  ],
};
