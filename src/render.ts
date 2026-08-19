import { fluidRGB, speciesColor, tempOf, SCALE } from './chem';
import type { Chemistry } from './chem';
import { GROW_TICKS, INC_PERIOD, organGrown, resolveAttach } from './world';
import type { Vein, World } from './world';
import { PORT_R, SRC_R, WORLD_H, WORLD_W, dist, posAt } from './geom';
import type { Pt } from './geom';

// The view layer: a torn-open cavity in some vast biological machine. The
// player's channels are vein color (composition ratios), width (amount),
// flow direction, and organ anatomy — everything else here is flesh
// dressing, kept deliberately dim and slow so it never competes with the
// data. Composition numbers, temperature, and probes are god-only.

export type Tool = 'draw' | 'erase' | 'probe';

export type DragState =
  | { kind: 'draw'; pts: Pt[]; endOrganIn?: number }
  | { kind: 'erase'; pts: Pt[] }
  | null;

export interface ViewState {
  world: World;
  godMode: boolean;
  tempOverlay: boolean;
  streams: boolean; // god-only: per-species parallel ribbons instead of the blended fluid
  drag: DragState;
  probes: Array<{ x: number; y: number }>;
  eraseHover: { veinId: number; i0: number; i1: number } | null; // shift-erase preview span
  cursor: Pt | null; // the cursor-probed node (god mode): ringed on the canvas
  phase: number; // continuous tick: world.tick + sub-tick fraction
  timeMs: number; // wall clock, for sim-speed-independent ambience
}

// ---- the cavity backdrop -------------------------------------------------
// A blurry mottle of dark reds and browns, breathing slowly, with the
// occasional drip. All Math.random here is view-only — never the sim RNG.

let bgBase: HTMLCanvasElement | null = null;

function makeBgBase(wpx: number, hpx: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const s = 6; // low-res; upscaling smoothing does the blurring for free
  c.width = Math.ceil(wpx / s);
  c.height = Math.ceil(hpx / s);
  const g = c.getContext('2d')!;
  g.fillStyle = '#221316';
  g.fillRect(0, 0, c.width, c.height);
  const tones = ['#301a1c', '#3c2220', '#452a24', '#2c1a22', '#251b1e', '#3a2828', '#1d1114', '#41231e'];
  for (let i = 0; i < 170; i++) {
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    const r = 4 + Math.random() * 22;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = tones[Math.floor(Math.random() * tones.length)];
    grad.addColorStop(0, tone);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.16 + Math.random() * 0.3;
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

interface Drip {
  x: number;
  y: number;
  len: number;
  speed: number;
  alpha: number;
}
const drips: Drip[] = [];
let lastDripSpawn = 0;

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, t: number): void {
  if (!bgBase) bgBase = makeBgBase(W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bgBase, 0, 0, W, H);

  const ts = t / 1000;
  for (let k = 0; k < 4; k++) {
    const cx = W * (0.18 + 0.22 * k) + 26 * Math.sin(ts * 0.11 + k * 2.1);
    const cy = H * (k % 2 ? 0.3 : 0.68) + 20 * Math.cos(ts * 0.083 + k * 1.4);
    const r = W * 0.16 * (1 + 0.22 * Math.sin(ts * 0.157 + k * 2.7));
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, k % 2 ? 'rgba(94,42,38,0.10)' : 'rgba(20,8,12,0.13)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (t - lastDripSpawn > 6500 && drips.length < 3 && Math.random() < 0.02) {
    lastDripSpawn = t;
    drips.push({ x: Math.random() * W, y: -30, len: 26 + Math.random() * 40, speed: 9 + Math.random() * 14, alpha: 0.05 + Math.random() * 0.05 });
  }
  for (let i = drips.length - 1; i >= 0; i--) {
    const d = drips[i];
    d.y += (d.speed * 16) / 1000;
    if (d.y - d.len > H) {
      drips.splice(i, 1);
      continue;
    }
    const grad = ctx.createLinearGradient(d.x, d.y - d.len, d.x, d.y);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(110,40,40,${d.alpha})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(d.x, d.y - d.len);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(d.x, d.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(110,40,40,${d.alpha * 1.6})`;
    ctx.fill();
  }

  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ---- vent haze -------------------------------------------------------------
// Wherever fluid leaves the network — an open tail, an incarnation
// frontier, an unattached organ port — a fuzzy cloud of its own light hangs
// in the cavity, area ∝ the venting rate.

function drawHaze(ctx: CanvasRenderingContext2D, pt: Pt, dir: Pt | null, rgb: [number, number, number], rate: number, t: number): void {
  const r = (7 + 24 * Math.sqrt(Math.min(2.5, rate / SCALE))) * (1 + 0.07 * Math.sin(t * 1.6 + pt[0] * 0.13));
  const cx = pt[0] + (dir ? dir[0] * r * 0.45 : 0);
  const cy = pt[1] + (dir ? dir[1] * r * 0.45 : 0);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.36)`);
  grad.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.16)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawVents(ctx: CanvasRenderingContext2D, view: ViewState): void {
  const w = view.world;
  const chem = w.chem;
  const t = view.timeMs / 1000;
  const norm = (from: Pt, to: Pt): Pt | null => {
    const d = dist(from, to);
    return d > 1e-6 ? [(to[0] - from[0]) / d, (to[1] - from[1]) / d] : null;
  };
  // a merge whose target junction hasn't been built yet vents too
  const tailVents = (p: Vein): boolean => {
    if (p.tail.type === 'open') return true;
    if (p.tail.type === 'merge') {
      const seg = resolveAttach(w, p.tail, { selfId: p.id, end: 'tail' });
      return !seg || seg.vein.inc[seg.idx] !== 1;
    }
    return false;
  };
  for (const p of w.veins.values()) {
    const n = p.pts.length;
    const tv = tailVents(p);
    for (let i = 0; i < n; i++) {
      if (!p.inc[i]) continue;
      const venting = i === n - 1 ? tv : p.inc[i + 1] === 0;
      if (!venting || p.flow[i] < SCALE * 0.01) continue;
      const rgb = fluidRGB(chem, p.parcels[i].c);
      if (!rgb) continue; // invisible fluid vents invisibly
      drawHaze(ctx, p.pts[i], i > 0 ? norm(p.pts[i - 1], p.pts[i]) : null, rgb, p.flow[i], t);
    }
  }
  for (const o of w.organs.values()) {
    if (!organGrown(o)) continue;
    const port = (vent: { rate: number; c: Int32Array } | null, pt: Pt) => {
      if (!vent || vent.rate < SCALE * 0.01) return;
      const rgb = fluidRGB(chem, vent.c);
      if (!rgb) return;
      drawHaze(ctx, pt, norm(o.c, pt), rgb, vent.rate, t);
    };
    port(o.ventOut, o.portOut);
    port(o.ventSide, o.portSide);
  }
}

// ---- veins ---------------------------------------------------------------

const widthOf = (f: number) => Math.min(14, 1.6 + 6.8 * Math.sqrt(Math.max(0, f) / SCALE));

function strokeSeg(
  ctx: CanvasRenderingContext2D, pts: Pt[], t0: number, t1: number, width: number, style: string,
  cap: CanvasLineCap = 'round',
): void {
  if (t1 - t0 < 1e-4) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let [px, py] = posAt(pts, t0);
  ctx.moveTo(px, py);
  // visit every interior node so the stroke follows the curve instead of
  // chording across it
  for (let t = Math.floor(t0) + 1; t < t1; t++) {
    if (t > t0) {
      [px, py] = posAt(pts, t);
      ctx.lineTo(px, py);
    }
  }
  [px, py] = posAt(pts, t1);
  ctx.lineTo(px, py);
  ctx.stroke();
}

// peristalsis: a gentle width wave traveling downstream at fluid speed
const wave = (phase: number, i: number, flow: number) => {
  const a = 0.18 * Math.min(1, flow / (SCALE * 0.5));
  return 1 + a * Math.sin(((i - phase) / 5.5) * Math.PI * 2);
};

const fluidW = (view: ViewState, p: Vein, i: number) =>
  Math.max(1.2, widthOf(p.flow[i]) * wave(view.phase, i, p.flow[i]));

// What the half-node region around station i currently shows: station i's
// contents, cross-faded toward the incoming content over the tick where
// that incoming content is truthfully known (see the comment in drawVein
// step 3). Null = nothing visible.
function stationDisplay(
  view: ViewState, p: Vein, pinned: Set<string>, i: number,
): { rgb: [number, number, number]; alpha: number } | null {
  const chem = view.world.chem;
  const frac = Math.max(0, Math.min(1, view.phase - view.world.tick));
  const cur = fluidRGB(chem, p.parcels[i].c);
  const isPinned = i === 0 || pinned.has(p.id + ':' + i) || !p.inc[i - 1];
  const inc = isPinned ? cur : fluidRGB(chem, p.parcels[i - 1].c);
  if (!cur && !inc) return null;
  const alpha = (cur ? 1 : 0) * (1 - frac) + (inc ? 1 : 0) * frac;
  if (alpha < 0.02) return null;
  const base = cur ?? inc!;
  const other = inc ?? cur!;
  const mix = (k: number) => Math.round(base[k] * (1 - frac) + other[k] * frac);
  return { rgb: [mix(0), mix(1), mix(2)], alpha };
}

const cssOf = (d: { rgb: [number, number, number] }) => `rgb(${d.rgb[0]},${d.rgb[1]},${d.rgb[2]})`;

// Is station i a live merge target flanked by live vein? Its mixed color
// then begins AT the station instead of half a node before it.
const isJunction = (p: Vein, pinned: Set<string>, i: number): boolean =>
  i > 0 && i < p.pts.length - 1 && p.inc[i - 1] === 1 && p.inc[i] === 1 && pinned.has(p.id + ':' + i);

// God's spectroscope: every species rides its own parallel ribbon along the
// vein, width ∝ its particle count (linear — one full part = STREAM_W px,
// with a visibility floor). The stack is centered on the vein path in
// species order, so lanes are stable and R+G — identical to the player's
// blended eye — visibly separates from fused RG.
const STREAM_W = 8;

// per-frame scratch + a species-CSS memo: this runs at rAF frequency, and
// sustained small allocations are exactly the committed-heap churn that
// OOMed the tab before (see Probes.tsx) — so no garbage on this path
let snx = new Float64Array(0);
let sny = new Float64Array(0);
const speciesCss = new WeakMap<Chemistry, string[]>();

function drawStreams(ctx: CanvasRenderingContext2D, view: ViewState, p: Vein): void {
  const chem = view.world.chem;
  const n = p.pts.length;
  const nsp = chem.nsp;
  let css = speciesCss.get(chem);
  if (!css) {
    css = Array.from({ length: nsp }, (_, k) => speciesColor(chem, k));
    speciesCss.set(chem, css);
  }
  // unit normals per node, perpendicular to the local direction
  if (snx.length < n) {
    snx = new Float64Array(n);
    sny = new Float64Array(n);
  }
  const nx = snx;
  const ny = sny;
  for (let i = 0; i < n; i++) {
    const a = p.pts[Math.max(0, i - 1)];
    const b = p.pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const m = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / m;
    ny[i] = dx / m;
  }
  const wOf = (i: number, k: number) => {
    const c = p.parcels[i].c[k];
    return c > 0 ? Math.max(0.8, (c / SCALE) * STREAM_W) : 0;
  };
  // maximal runs of consecutive incarnate nodes; within each, one filled
  // ribbon per species, pinching to zero wherever the count does
  let s = 0;
  while (s < n) {
    if (!p.inc[s]) {
      s++;
      continue;
    }
    let e = s;
    while (e + 1 < n && p.inc[e + 1]) e++;
    for (let k = 0; k < nsp; k++) {
      let present = false;
      for (let i = s; i <= e; i++) if (p.parcels[i].c[k] > 0) present = true;
      if (!present) continue;
      ctx.beginPath();
      for (let i = s; i <= e; i++) {
        let lo = 0;
        for (let j = 0; j < nsp; j++) lo += wOf(i, j);
        lo = -lo / 2;
        for (let j = 0; j < k; j++) lo += wOf(i, j);
        const hi = lo + wOf(i, k);
        const x = p.pts[i][0] + nx[i] * hi;
        const y = p.pts[i][1] + ny[i] * hi;
        if (i === s) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = e; i >= s; i--) {
        let lo = 0;
        for (let j = 0; j < nsp; j++) lo += wOf(i, j);
        lo = -lo / 2;
        for (let j = 0; j < k; j++) lo += wOf(i, j);
        ctx.lineTo(p.pts[i][0] + nx[i] * lo, p.pts[i][1] + ny[i] * lo);
      }
      ctx.closePath();
      ctx.fillStyle = css[k];
      ctx.fill();
      // a hairline seam so neighboring ribbons of kindred hue stay distinct
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    s = e + 1;
  }
}

function drawVein(ctx: CanvasRenderingContext2D, view: ViewState, p: Vein, pinned: Set<string>): void {
  const pts = p.pts;
  const n = pts.length;
  const phase = view.phase;

  // 1) ghost route: a faint dashed thread where walls don't exist yet
  ctx.setLineDash([3, 5]);
  for (let i = 0; i + 1 < n; i++) {
    if (!p.inc[i] || !p.inc[i + 1]) {
      strokeSeg(ctx, pts, i, i + 1, 1.6, 'rgba(226,214,220,0.30)');
    }
  }
  ctx.setLineDash([]);

  // 2) membrane wall over the incarnate portion, with freshly incarnated
  // nodes extruding smoothly out of their older neighbor
  const growF = (i: number) => {
    if (!p.inc[i]) return 0;
    if (p.incTick[i] <= 0) return 1;
    // incTick is recorded before the tick counter advances, so the first
    // rendered frame sees phase - incTick ≈ 1; the -1 makes extrusion start
    // from ~0 and finish just as the next node begins its own
    return Math.max(0.03, Math.min(1, (phase - p.incTick[i] - 1) / INC_PERIOD));
  };
  const wallW = (i: number) => Math.max(4.5, widthOf(p.flow[i]) * wave(phase, i, p.flow[i]) + 3);
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
    // the wall shows only where the vein reads empty: where fluid is drawn
    // (stationDisplay ≠ null, the same predicate as the fluid pass) the
    // fluid IS the vein. An invisible fluid still reads as an empty,
    // walled vein — exactly the deception it's designed for.
    if (stationDisplay(view, p, pinned, i)) continue;
    const g = growF(i);
    const wl = 'rgba(226,200,182,0.5)';
    if (i > 0 && p.inc[i - 1] && growF(i - 1) >= g) strokeSeg(ctx, pts, i - g * 0.5, i, wallW(i), wl);
    else if (i === 0 || !p.inc[i - 1]) strokeSeg(ctx, pts, i - 0.001, i, wallW(i), wl);
    if (i + 1 < n && p.inc[i + 1] && growF(i + 1) >= g) strokeSeg(ctx, pts, i, i + g * 0.5, wallW(i), wl);
    else if (i === n - 1 || !p.inc[i + 1]) strokeSeg(ctx, pts, i, i + 0.001, wallW(i), wl);
  }
  // dark lumen inside the wall
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
    const g = growF(i);
    const lw = Math.max(2, wallW(i) - 2.6);
    if (i > 0 && p.inc[i - 1]) strokeSeg(ctx, pts, i - g * 0.5, i, lw, '#1b1214');
    if (i + 1 < n && p.inc[i + 1]) strokeSeg(ctx, pts, i, i + g * 0.5, lw, '#1b1214');
    if ((i === 0 || !p.inc[i - 1]) && (i === n - 1 || !p.inc[i + 1])) strokeSeg(ctx, pts, i - 0.001, i + 0.001, lw, '#1b1214');
  }

  // 3) fluid: each region of vein (the half-node span around station i)
  // always shows station i's contents — regions are FIXED in space, so
  // composition boundaries pinned to a station (junctions, terminals)
  // never wobble. Motion still reads smoothly because a region whose
  // incoming content is truthfully known (plain mid-vein: next tick it
  // holds exactly what station i-1 holds now) cross-fades toward it over
  // the tick. Stations where content is *made* rather than passed along —
  // heads and merge targets — stay pinned-static. A merge target's mixed
  // color moreover begins AT the station, flat-cut; its upstream half-span
  // keeps the incoming line's color, painted here in vein order so a
  // later-drawn tributary occludes it like any other overlap.
  // In the species-streams view the ribbons are painted in a global pass
  // AFTER every vein's structure, so no vein's dark lumen can sit on top of
  // another's ribbons at a junction.
  if (!(view.godMode && view.streams)) {
    for (let i = 0; i < n; i++) {
      if (!p.inc[i]) continue;
      const d = stationDisplay(view, p, pinned, i);
      if (!d) continue;
      if (isJunction(p, pinned, i)) {
        const du = stationDisplay(view, p, pinned, i - 1);
        if (du) {
          // upstream color first: its round cap pokes past the node, and the
          // wider mixed stroke then covers the poke
          ctx.globalAlpha = du.alpha;
          strokeSeg(ctx, pts, i - 0.5, i, fluidW(view, p, i - 1), cssOf(du));
        }
        ctx.globalAlpha = d.alpha;
        strokeSeg(ctx, pts, i, i + 0.5, fluidW(view, p, i), cssOf(d), 'butt');
      } else {
        ctx.globalAlpha = d.alpha;
        strokeSeg(ctx, pts, Math.max(0, i - 0.5), Math.min(n - 1, i + 0.5), fluidW(view, p, i), cssOf(d));
      }
      ctx.globalAlpha = 1;
    }

    drawChevrons(ctx, view, p);
  }
}

// drifting direction chevrons, riding the flow — only where there IS flow
// (a dry vein gives no direction hint until fluid moves through it)
function drawChevrons(ctx: CanvasRenderingContext2D, view: ViewState, p: Vein): void {
  const pts = p.pts;
  const n = pts.length;
  const phase = view.phase;
  ctx.fillStyle = 'rgba(240,235,228,0.5)';
  const step = 4;
  for (let base = 1 + ((phase % step) + step) % step; base < n - 0.5; base += step) {
    const i = base;
    const lo = Math.floor(i);
    if (lo < 0 || lo + 1 >= n || !p.inc[lo] || !p.inc[lo + 1]) continue;
    if (p.flow[lo] < SCALE * 0.01) continue;
    const [x0, y0] = posAt(pts, i - 0.45);
    const [x1, y1] = posAt(pts, i + 0.45);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    ctx.beginPath();
    ctx.moveTo(mx + dx * 0.18, my + dy * 0.18);
    ctx.lineTo(mx - dx * 0.1 - dy * 0.16, my - dy * 0.1 + dx * 0.16);
    ctx.lineTo(mx - dx * 0.1 + dy * 0.16, my - dy * 0.1 - dx * 0.16);
    ctx.fill();
  }
}

// ---- organs --------------------------------------------------------------

// a soft double-thump heartbeat envelope, 0..1
function heartbeat(t: number): number {
  const s = ((t % 1) + 1) % 1;
  const thump = (c: number, w: number) => Math.exp(-(((s - c) / w) ** 2));
  return thump(0.07, 0.045) + 0.45 * thump(0.24, 0.055);
}

// the wobbling radius of an organic disc at polar angle th
function blobR(R: number, th: number, t: number, wobble: number): number {
  return (
    R *
    (1 +
      wobble * 0.14 * Math.sin(3 * th + t * 2.4) +
      wobble * 0.1 * Math.sin(5 * th - t * 1.7) +
      wobble * 0.05 * Math.sin(8 * th + t * 3.9))
  );
}

// a wobbling organic disc outline
function blobPath(ctx: CanvasRenderingContext2D, c: Pt, R: number, t: number, wobble: number): void {
  ctx.beginPath();
  const N = 26;
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI * 2;
    const r = blobR(R, th, t, wobble);
    const x = c[0] + r * Math.cos(th);
    const y = c[1] + r * 0.94 * Math.sin(th);
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawOrgans(ctx: CanvasRenderingContext2D, view: ViewState): void {
  const w = view.world;
  const phase = view.phase;
  const t = view.timeMs / 1000;
  for (const o of w.organs.values()) {
    const grown = organGrown(o);
    const g = grown ? 1 : Math.min(1, (o.growth + Math.max(0, Math.min(1, phase - w.tick))) / GROW_TICKS);

    if (!grown) {
      // a wobbling blob swelling over the vein beneath it — fully opaque,
      // so the doomed stretch disappears under it as it grows
      const ease = g * g * (3 - 2 * g);
      blobPath(ctx, o.c, o.r * (0.22 + 0.78 * ease), t, 1 - 0.5 * ease);
      const tone = (a: number, b: number) => Math.round(a + (b - a) * ease);
      ctx.fillStyle = `rgb(${tone(196, 232)},${tone(168, 221)},${tone(128, 200)})`;
      ctx.fill();
      ctx.strokeStyle = '#7a6f58';
      ctx.lineWidth = 2;
      ctx.stroke();
      continue;
    }

    // grown: a gently breathing membrane disc with a load-driven heartbeat
    const amp = 0.045 * Math.min(1, o.load / (SCALE * 0.3));
    const beat = 1 + amp * heartbeat(phase / 8 + o.id * 0.37);
    ctx.save();
    ctx.translate(o.c[0], o.c[1]);
    ctx.scale(beat, beat);
    ctx.translate(-o.c[0], -o.c[1]);
    blobPath(ctx, o.c, o.r, t * 0.35, 0.28);
    ctx.fillStyle = '#e8ddc8';
    ctx.fill();
    ctx.strokeStyle = '#7a6f58';
    ctx.lineWidth = 2;
    ctx.stroke();
    // the organ's identity is god-only: the player was promised "what it
    // does is yours to find out"
    if (view.godMode) {
      ctx.fillStyle = '#6a5f48';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('RADICAL', o.c[0], o.c[1] - 5);
      ctx.fillText('FILTER', o.c[0], o.c[1] + 6);
    }

    // ports are pigment splotches ON the membrane: anchored to the wobbling
    // rim (not the frozen attachment point) and drawn inside the heartbeat
    // transform, so they pulse with the flesh instead of floating over it
    // like UI markers. Distinct colors are the only labeling; the side
    // port's function stays unnamed even for gods.
    const rimAt = (pt: Pt): Pt => {
      const th = Math.atan2((pt[1] - o.c[1]) / 0.94, pt[0] - o.c[0]);
      const r = blobR(o.r, th, t * 0.35, 0.28);
      return [o.c[0] + r * Math.cos(th), o.c[1] + r * 0.94 * Math.sin(th)];
    };
    const splotch = (pt: Pt, rgb: string, seed: number) => {
      const rp = rimAt(pt);
      blobPath(ctx, rp, PORT_R * 1.35, t * 0.7 + seed, 0.9);
      ctx.fillStyle = `rgba(${rgb},0.4)`;
      ctx.fill();
      blobPath(ctx, rp, PORT_R * 0.85, t * 0.9 + seed * 1.7, 0.8);
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fill();
    };
    splotch(o.portIn, '74,122,82', o.id * 0.9 + 1);
    splotch(o.portOut, '74,95,122', o.id * 0.9 + 4);
    splotch(o.portSide, '154,95,58', o.id * 0.9 + 7);
    ctx.restore();
  }
}

// ---- the frame -----------------------------------------------------------

export function drawWorld(canvas: HTMLCanvasElement, view: ViewState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = view.world;
  const chem = w.chem;

  drawBackground(ctx, WORLD_W, WORLD_H, view.timeMs);

  // temperature underlay (god only): red-hot / blue-cold halos
  if (view.godMode && view.tempOverlay) {
    for (const p of w.veins.values()) {
      for (let i = 0; i < p.pts.length; i++) {
        if (!p.inc[i]) continue;
        const T = tempOf(chem, p.parcels[i]);
        const d = T - chem.ambient;
        if (Math.abs(d) < 0.04) continue;
        const a = Math.min(0.6, Math.abs(d) * 0.45);
        const halo = d > 0 ? `rgba(255,90,50,${a})` : `rgba(70,140,255,${a})`;
        strokeSeg(ctx, p.pts, Math.max(0, i - 0.5), Math.min(p.pts.length - 1, i + 0.5), widthOf(p.flow[i]) + 9, halo);
      }
    }
  }

  // haze of escaping fluid hangs behind everything structural
  drawVents(ctx, view);

  // stations where fluid is *made* rather than passed along (merge targets)
  // render pinned-static — their color boundary belongs to the station
  const pinned = new Set<string>();
  const junctions: Array<{ p: Vein; i: number }> = [];
  for (const q of w.veins.values()) {
    if (q.tail.type === 'merge') {
      const seg = resolveAttach(w, q.tail, { selfId: q.id, end: 'tail' });
      if (seg && !pinned.has(seg.vein.id + ':' + seg.idx)) {
        pinned.add(seg.vein.id + ':' + seg.idx);
        junctions.push({ p: seg.vein, i: seg.idx });
      }
    }
  }
  for (const p of w.veins.values()) drawVein(ctx, view, p, pinned);

  // species-streams view: all ribbons above all structure (a vein's dark
  // lumen must never cover another's ribbons at a junction), chevrons on top
  if (view.godMode && view.streams) {
    for (const p of w.veins.values()) drawStreams(ctx, view, p);
    for (const p of w.veins.values()) drawChevrons(ctx, view, p);
  }

  // The mixed color's flat cut at each junction, repainted OVER every vein:
  // the tributary's wall/lumen and fluid cap (drawn after the host) poke
  // past the node, and only this front may cover them there. The upstream
  // side is deliberately NOT repainted — it was drawn in vein order, so the
  // tributary lies over it like any other overlap. (Moot in the species-
  // streams view, which draws no blended color at all.)
  for (const { p, i } of view.godMode && view.streams ? [] : junctions) {
    if (!isJunction(p, pinned, i)) continue;
    const d = stationDisplay(view, p, pinned, i);
    if (d) {
      ctx.globalAlpha = d.alpha;
      strokeSeg(ctx, p.pts, i, i + 0.5, fluidW(view, p, i), cssOf(d), 'butt');
      ctx.globalAlpha = 1;
    }
  }

  // shift-erase hover: the doomed junction-to-junction stretch glows red
  if (view.eraseHover) {
    const p = w.veins.get(view.eraseHover.veinId);
    if (p) {
      const n = p.pts.length;
      const i0 = Math.max(0, Math.min(n - 1, view.eraseHover.i0));
      const i1 = Math.max(0, Math.min(n - 1, view.eraseHover.i1));
      ctx.save();
      ctx.shadowColor = '#ff5040';
      ctx.shadowBlur = 14;
      strokeSeg(ctx, p.pts, Math.max(0, i0 - 0.4), Math.min(n - 1, i1 + 0.4), 7, 'rgba(255,84,64,0.85)');
      ctx.restore();
    }
  }

  // sources: wellheads in the cavity wall, painted with their fluid's light
  for (const s of w.sources) {
    ctx.fillStyle = 'rgba(226,200,182,0.35)';
    ctx.beginPath();
    ctx.arc(s.pt[0], s.pt[1], SRC_R * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = speciesColor(chem, s.spIdx);
    ctx.beginPath();
    ctx.arc(s.pt[0], s.pt[1], SRC_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (view.godMode) {
      ctx.fillStyle = '#fff';
      ctx.font = '700 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, s.pt[0], s.pt[1] + 0.5);
    }
  }

  drawOrgans(ctx, view);

  // drag previews
  const dr = view.drag;
  if (dr?.kind === 'draw' && dr.pts.length) {
    ctx.strokeStyle = 'rgba(235,245,250,0.5)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    dr.pts.forEach((pt, i) => {
      if (i) ctx.lineTo(pt[0], pt[1]);
      else ctx.moveTo(pt[0], pt[1]);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (dr?.kind === 'erase' && dr.pts.length) {
    ctx.fillStyle = 'rgba(220,80,60,0.28)';
    for (const pt of dr.pts) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // the cursor probe: a faint dashed ring on the node the mouse is reading
  if (view.godMode && view.cursor) {
    ctx.strokeStyle = 'rgba(240,235,228,0.65)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(view.cursor[0], view.cursor[1], 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // probe markers (god only, like the probes themselves)
  if (view.godMode) {
    view.probes.forEach((pr, i) => {
      ctx.strokeStyle = '#f0e8e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f0e8e0';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), pr.x - 13, pr.y - 12);
    });
  }
}
