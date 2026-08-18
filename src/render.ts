import { fluidRGB, speciesColor, tempOf, T_AMB, SCALE } from './chem';
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
  drag: DragState;
  probes: Array<{ x: number; y: number }>;
  eraseHover: { veinId: number; i0: number; i1: number } | null; // shift-erase preview span
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
  for (const p of w.veins.values()) {
    const n = p.pts.length;
    for (let i = 0; i < n; i++) {
      if (!p.inc[i]) continue;
      const venting = i === n - 1 ? p.tail.type === 'open' : p.inc[i + 1] === 0;
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

function strokeSeg(ctx: CanvasRenderingContext2D, pts: Pt[], t0: number, t1: number, width: number, style: string): void {
  if (t1 - t0 < 1e-4) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
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

function drawVein(ctx: CanvasRenderingContext2D, view: ViewState, p: Vein, pinned: Set<string>): void {
  const chem = view.world.chem;
  const pts = p.pts;
  const n = pts.length;
  const phase = view.phase;
  const frac = Math.max(0, Math.min(1, phase - view.world.tick));

  // peristalsis: a gentle width wave traveling downstream at fluid speed
  const wave = (i: number, flow: number) => {
    const a = 0.18 * Math.min(1, flow / (SCALE * 0.5));
    return 1 + a * Math.sin(((i - phase) / 5.5) * Math.PI * 2);
  };

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
  const wallW = (i: number) => Math.max(4.5, widthOf(p.flow[i]) * wave(i, p.flow[i]) + 3);
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
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
  // heads and merge targets — stay pinned-static.
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
    const cur = fluidRGB(chem, p.parcels[i].c);
    const isPinned = i === 0 || pinned.has(p.id + ':' + i) || !p.inc[i - 1];
    const inc = isPinned ? cur : fluidRGB(chem, p.parcels[i - 1].c);
    if (!cur && !inc) continue;
    const aCur = cur ? 1 : 0;
    const aInc = inc ? 1 : 0;
    const alpha = aCur * (1 - frac) + aInc * frac;
    if (alpha < 0.02) continue;
    const base = cur ?? inc!;
    const other = inc ?? cur!;
    const mix = (k: number) => Math.round(base[k] * (1 - frac) + other[k] * frac);
    const wv = Math.max(1.2, widthOf(p.flow[i]) * wave(i, p.flow[i]));
    ctx.globalAlpha = alpha;
    strokeSeg(ctx, pts, Math.max(0, i - 0.5), Math.min(n - 1, i + 0.5), wv, `rgb(${mix(0)},${mix(1)},${mix(2)})`);
    ctx.globalAlpha = 1;
  }

  // 4) drifting direction chevrons, riding the flow — only where there IS
  // flow (a dry vein gives no direction hint until fluid moves through it)
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

// a wobbling organic disc outline
function blobPath(ctx: CanvasRenderingContext2D, c: Pt, R: number, t: number, wobble: number): void {
  ctx.beginPath();
  const N = 26;
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI * 2;
    const r =
      R *
      (1 +
        wobble * 0.14 * Math.sin(3 * th + t * 2.4) +
        wobble * 0.1 * Math.sin(5 * th - t * 1.7) +
        wobble * 0.05 * Math.sin(8 * th + t * 3.9));
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
    ctx.restore();

    // ports sit on the membrane, unscaled (veins attach to them). in/out
    // are honest anatomy; the side port's function stays unlabeled for
    // players.
    const port = (pt: Pt, color: string, label: string | null) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], PORT_R * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (label) {
        ctx.fillStyle = '#fff';
        ctx.font = '700 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pt[0], pt[1] + 0.5);
      }
    };
    port(o.portIn, '#4a7a52', 'in');
    port(o.portOut, '#4a5f7a', 'out');
    port(o.portSide, '#9a5f3a', view.godMode ? 'rad' : null);
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
        const d = T - T_AMB;
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
  for (const q of w.veins.values()) {
    if (q.tail.type === 'merge') {
      const seg = resolveAttach(w, q.tail);
      if (seg) pinned.add(seg.vein.id + ':' + seg.idx);
    }
  }
  for (const p of w.veins.values()) drawVein(ctx, view, p, pinned);

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
