import { fluidColor, speciesColor, tempOf, T_AMB, SCALE } from './chem';
import { CELL, COLS, GROW_TICKS, INC_PERIOD, ROWS, organGrown, parseKey } from './world';
import type { Vein, World } from './world';

// The view layer: a torn-open cavity in some vast biological machine. The
// player's channels are vein color (composition ratios), width (amount),
// flow direction, and organ anatomy — everything else here is flesh
// dressing, kept deliberately dim and slow so it never competes with the
// data. Composition numbers, temperature, and probes are god-only.

export type Tool = 'draw' | 'erase' | 'probe';

export type DragState =
  | { kind: 'draw'; cells: Array<{ x: number; y: number; k: string }>; endOrganIn?: number }
  | { kind: 'erase'; keys: Set<string> }
  | null;

export interface ViewState {
  world: World;
  godMode: boolean;
  tempOverlay: boolean;
  drag: DragState;
  probes: Array<{ cellKey: string }>;
  phase: number; // continuous tick: world.tick + sub-tick fraction
  timeMs: number; // wall clock, for sim-speed-independent ambience
}

const laneOffsets: Array<[number, number]> = [[0, 0], [-5, -5], [5, 5], [-5, 5], [5, -5]];
const laneOff = (id: number) => laneOffsets[id % laneOffsets.length];

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

  // slow breathing: a few broad soft patches swelling and drifting
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

  // rare slow drips crawling down the cavity wall
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

  // vignette: the torn-open edges fall away into dark
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ---- veins ---------------------------------------------------------------

// fractional position along a vein's polyline (t in cell-index units)
function posAt(pts: Array<[number, number]>, t: number): [number, number] {
  const n = pts.length;
  if (t <= 0) return pts[0];
  if (t >= n - 1) return pts[n - 1];
  const i = Math.floor(t);
  const f = t - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
}

const widthOf = (f: number) => Math.min(14, 1.6 + 6.8 * Math.sqrt(Math.max(0, f) / SCALE));

function strokeSeg(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>, t0: number, t1: number, width: number, style: string): void {
  if (t1 - t0 < 1e-4) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let [px, py] = posAt(pts, t0);
  ctx.moveTo(px, py);
  // visit every interior cell center so the stroke follows corners
  // instead of chording across them
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

function drawVein(ctx: CanvasRenderingContext2D, view: ViewState, p: Vein): void {
  const chem = view.world.chem;
  const off = laneOff(p.id);
  const pts: Array<[number, number]> = p.cells.map((c) => [
    c.x * CELL + CELL / 2 + off[0],
    c.y * CELL + CELL / 2 + off[1],
  ]);
  const n = p.cells.length;
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
  // cells extruding smoothly out of their older neighbor
  const growF = (i: number) => {
    if (!p.inc[i]) return 0;
    if (p.incTick[i] <= 0) return 1;
    // incTick is recorded before the tick counter advances, so the first
    // rendered frame sees phase - incTick ≈ 1; the -1 makes extrusion start
    // from ~0 and finish just as the next cell begins its own
    return Math.max(0.03, Math.min(1, (phase - p.incTick[i] - 1) / INC_PERIOD));
  };
  const wallW = (i: number) => Math.max(4.5, widthOf(p.flow[i]) * wave(i, p.flow[i]) + 3);
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
    const g = growF(i);
    // half-segments toward each incarnate/edge neighbor, scaled by growth
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

  // 3) fluid: each parcel drawn as a sliding one-cell segment — arrivals
  // interpolate from the cell behind, stalled parcels sit still
  for (let i = 0; i < n; i++) {
    if (!p.inc[i]) continue;
    const color = fluidColor(chem, p.parcels[i].c);
    if (!color) continue;
    const slide = p.arrived?.[i] ? frac - 1 : 0; // arrived: from i-1 (slide -1..0)
    const t0 = Math.max(0, i + slide - 0.5);
    const t1 = Math.min(n - 1, i + slide + 0.5);
    const wv = Math.max(1.2, widthOf(p.flow[i]) * wave(i, p.flow[i]));
    strokeSeg(ctx, pts, t0, t1, wv, color);
  }

  // 4) drifting direction chevrons, riding the flow
  ctx.fillStyle = 'rgba(240,235,228,0.5)';
  const step = 4;
  for (let base = 1 + ((phase % step) + step) % step; base < n - 0.5; base += step) {
    const i = base;
    const lo = Math.floor(i);
    if (lo < 0 || lo + 1 >= n || !p.inc[lo] || !p.inc[lo + 1]) continue;
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

function drawOrgans(ctx: CanvasRenderingContext2D, view: ViewState): void {
  const w = view.world;
  const phase = view.phase;
  for (const o of w.organs.values()) {
    const cx = o.cx * CELL + CELL / 2;
    const cy = o.cy * CELL + CELL / 2;
    const grown = organGrown(o);
    const g = grown ? 1 : Math.min(1, (o.growth + Math.max(0, Math.min(1, phase - w.tick))) / GROW_TICKS);

    if (!grown) {
      // a wobbling blob swelling over the vein beneath it
      const ease = g * g * (3 - 2 * g);
      const R = 2.5 * CELL * (0.22 + 0.78 * ease);
      const t = view.timeMs / 1000;
      ctx.beginPath();
      const N = 26;
      for (let k = 0; k <= N; k++) {
        const th = (k / N) * Math.PI * 2;
        const r =
          R *
          (1 +
            0.14 * (1 - 0.5 * ease) * Math.sin(3 * th + t * 2.4) +
            0.1 * (1 - 0.5 * ease) * Math.sin(5 * th - t * 1.7) +
            0.05 * Math.sin(8 * th + t * 3.9));
        const x = cx + r * Math.cos(th);
        const y = cy + r * 0.92 * Math.sin(th);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(210,185,150,${0.25 + 0.65 * ease})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(122,111,88,${0.4 + 0.6 * ease})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      continue;
    }

    // grown: parchment body with a load-driven heartbeat
    const amp = 0.045 * Math.min(1, o.load / (SCALE * 0.3));
    const beat = 1 + amp * heartbeat(phase / 8 + o.id * 0.37);
    const x = (o.cx - 2) * CELL;
    const y = (o.cy - 2) * CELL;
    const wpx = 5 * CELL;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(beat, beat);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = '#e8ddc8';
    ctx.strokeStyle = '#7a6f58';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, wpx - 4, wpx - 4, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6a5f48';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RADICAL', cx, o.cy * CELL + 2);
    ctx.fillText('FILTER', cx, o.cy * CELL + 13);
    ctx.restore();

    // ports sit on the grid, unscaled (veins attach to them)
    const port = (pt: { x: number; y: number }, color: string, label: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(pt.x * CELL + 3, pt.y * CELL + 3, CELL - 6, CELL - 6, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pt.x * CELL + CELL / 2, pt.y * CELL + CELL / 2 + 0.5);
    };
    port(o.portIn, '#4a7a52', 'in');
    port(o.portOut, '#4a5f7a', 'out');
    port(o.portSide, '#9a5f3a', 'rad');
  }
}

// ---- the frame -----------------------------------------------------------

export function drawWorld(canvas: HTMLCanvasElement, view: ViewState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = view.world;
  const chem = w.chem;
  const W = COLS * CELL;
  const H = ROWS * CELL;

  drawBackground(ctx, W, H, view.timeMs);

  // temperature underlay (god only): red-hot / blue-cold halos
  if (view.godMode && view.tempOverlay) {
    for (const p of w.veins.values()) {
      const off = laneOff(p.id);
      for (let i = 0; i < p.cells.length; i++) {
        if (!p.inc[i]) continue;
        const T = tempOf(chem, p.parcels[i]);
        const d = T - T_AMB;
        if (Math.abs(d) < 0.04) continue;
        const a = Math.min(0.6, Math.abs(d) * 0.45);
        ctx.strokeStyle = d > 0 ? `rgba(255,90,50,${a})` : `rgba(70,140,255,${a})`;
        ctx.lineWidth = widthOf(p.flow[i]) + 9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const c0 = p.cells[Math.max(0, i - 1)];
        const c1 = p.cells[i];
        ctx.moveTo(
          (c0.x + c1.x) * 0.5 * CELL + CELL / 2 + off[0],
          (c0.y + c1.y) * 0.5 * CELL + CELL / 2 + off[1],
        );
        ctx.lineTo(c1.x * CELL + CELL / 2 + off[0], c1.y * CELL + CELL / 2 + off[1]);
        ctx.stroke();
      }
    }
  }

  for (const p of w.veins.values()) drawVein(ctx, view, p);

  // sources: wellheads in the cavity wall, painted with their fluid's light
  for (const s of w.sources) {
    const x = s.x * CELL;
    const y = s.y * CELL;
    ctx.fillStyle = 'rgba(226,200,182,0.35)';
    ctx.beginPath();
    ctx.arc(x + CELL / 2, y + CELL / 2, CELL * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = speciesColor(chem, s.spIdx);
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, CELL - 4, CELL - 4, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (view.godMode) {
      ctx.fillStyle = '#fff';
      ctx.font = '700 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, x + CELL / 2, y + CELL / 2 + 0.5);
    }
  }

  drawOrgans(ctx, view);

  // drag previews
  const dr = view.drag;
  if (dr?.kind === 'draw' && dr.cells.length) {
    ctx.strokeStyle = 'rgba(235,245,250,0.5)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    dr.cells.forEach((c, i) => {
      const x = c.x * CELL + CELL / 2;
      const y = c.y * CELL + CELL / 2;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (dr?.kind === 'erase' && dr.keys.size) {
    ctx.fillStyle = 'rgba(220,80,60,0.32)';
    for (const k of dr.keys) {
      const [x, y] = parseKey(k);
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  // probe markers (god only, like the probes themselves)
  if (view.godMode) {
    view.probes.forEach((pr, i) => {
      const [x, y] = parseKey(pr.cellKey);
      ctx.strokeStyle = '#f0e8e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x * CELL + CELL / 2, y * CELL + CELL / 2, CELL * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f0e8e0';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x * CELL + CELL / 2 - CELL * 0.62, y * CELL + CELL / 2 - CELL * 0.55);
    });
  }
}
