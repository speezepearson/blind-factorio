import { useEffect, useRef } from 'react';
import type { JSX, RefObject } from 'react';
import { HIST, resolveAttach } from './world';
import type { World } from './world';
import type { Chemistry } from './chem';
import { speciesColor } from './chem';

// A probe's chart data is the vein node's live history ring buffer — HIST
// slots of (nsp species + temperature) Float32s, indexed by tick % HIST,
// NaN where nothing was recorded. When the probed node disappears the probe
// freezes: it keeps a private copy of the buffer as of that moment.
export interface Snapshot {
  h: Float32Array | null; // null: node exists but never recorded anything
  tick: number; // the window is (tick - HIST, tick]
}

export interface Probe {
  id: number;
  veinId: number;
  x: number; // anchor point, resolved to the nearest node of the vein
  y: number;
  label: string;
  frozen?: Snapshot;
  lastH?: Float32Array | null; // last live buffer seen, for freezing
  lastTick?: number;
}

const mono = "'SF Mono','Cascadia Code',Menlo,monospace";

const btn = {
  font: '600 12px/1 inherit',
  padding: '7px 11px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid #4a3f42',
  background: '#2c2528',
  color: '#cfc4bd',
};

// ---- the chart: hand-drawn on canvas, straight from the ring buffer ----
// Deliberately allocation-free and SVG-free. The panel repaints every
// 250 ms; in this Chromium, sustained per-update garbage (chart-library
// data arrays, SVG path strings) makes V8's committed heap grow without
// bound — used-heap stays flat, the renderer's memory climbs until the tab
// dies ("Aw, Snap"). Reading the Float32Array directly and painting on
// canvas allocates nothing per frame, which is the fix. Measured before
// touching this: recharts ~45 MB/s, per-pulse row objects ~1 MB/s,
// buffer-direct canvas ~0.

function drawChart(
  cv: HTMLCanvasElement,
  chem: Chemistry,
  snap: Snapshot,
  hoverX: number | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.offsetWidth;
  const h = cv.offsetHeight;
  const g = cv.getContext('2d');
  if (!g || w === 0 || h === 0) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const L = 30;
  const R = 30;
  const T = 6;
  const B = 14;
  const iw = w - L - R;
  const ih = h - T - B;
  if (iw <= 0 || ih <= 0) return;

  const buf = snap.h;
  const nsp = chem.nsp;
  const stride = nsp + 1;
  const t1 = snap.tick;
  const t0 = Math.max(0, t1 - HIST + 1);
  if (t1 - t0 < 1) return;
  // a slot is trustworthy if it was written within the window: its temp
  // cell is a number (buffers start NaN-filled)
  const base = (tt: number) => (tt % HIST) * stride;
  const rec = (tt: number) => buf !== null && !Number.isNaN(buf[base(tt) + nsp]);

  let maxC = 0;
  let maxT = 0;
  for (let tt = t0; tt <= t1; tt++) {
    if (!rec(tt)) continue;
    const b = base(tt);
    let s = 0;
    for (let k = 0; k < nsp; k++) s += buf![b + k];
    if (s > maxC) maxC = s;
    if (buf![b + nsp] > maxT) maxT = buf![b + nsp];
  }
  maxC = Math.max(maxC, 1e-6) * 1.05;
  maxT = Math.max(maxT, 1.3) * 1.05; // keep ambient (T = 1) in view
  const x = (tt: number) => L + (iw * (tt - t0)) / (t1 - t0);
  const yC = (v: number) => T + ih * (1 - v / maxC);
  const yT = (v: number) => T + ih * (1 - v / maxT);

  g.strokeStyle = '#3a3134';
  g.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    g.beginPath();
    g.moveTo(L, T + ih * f);
    g.lineTo(L + iw, T + ih * f);
    g.stroke();
  }

  // stacked composition areas, species piled in index order over each
  // contiguous recorded run; the stack bottom for species k is the sum of
  // species < k, recomputed per column straight from the buffer
  const below = (tt: number, k: number) => {
    const b = base(tt);
    let s = 0;
    for (let q = 0; q < k; q++) s += buf![b + q];
    return s;
  };
  g.globalAlpha = 0.8;
  for (let k = 0; k < nsp; k++) {
    g.fillStyle = speciesColor(chem, k);
    let tt = t0;
    while (tt <= t1) {
      while (tt <= t1 && !rec(tt)) tt++;
      const runStart = tt;
      while (tt <= t1 && rec(tt)) tt++;
      if (tt > runStart) {
        g.beginPath();
        for (let q = runStart; q < tt; q++) g.lineTo(x(q), yC(below(q, k) + buf![base(q) + k]));
        for (let q = tt - 1; q >= runStart; q--) g.lineTo(x(q), yC(below(q, k)));
        g.closePath();
        g.fill();
      }
    }
  }
  g.globalAlpha = 1;

  // temperature: dashed pale line against the right-hand scale
  g.strokeStyle = '#e8e2dc';
  g.lineWidth = 1.5;
  g.setLineDash([5, 3]);
  g.beginPath();
  let pen = false;
  for (let tt = t0; tt <= t1; tt++) {
    if (!rec(tt)) {
      pen = false;
      continue;
    }
    if (pen) g.lineTo(x(tt), yT(buf![base(tt) + nsp]));
    else g.moveTo(x(tt), yT(buf![base(tt) + nsp]));
    pen = true;
  }
  g.stroke();
  g.setLineDash([]);

  g.font = '9px sans-serif';
  g.fillStyle = '#8d7f84';
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  g.fillText(maxC.toFixed(2), L - 3, T + 4);
  g.fillText('0', L - 3, T + ih);
  g.textAlign = 'left';
  g.fillText(maxT.toFixed(2), L + iw + 3, T + 4);
  g.fillText('0', L + iw + 3, T + ih);
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillText(String(t0), L, T + ih + 3);
  g.fillText(String(t1), L + iw, T + ih + 3);

  // hover: crosshair on the nearest recorded tick, with a value readout
  if (hoverX !== null && hoverX >= L && hoverX <= L + iw) {
    const want = t0 + ((hoverX - L) / iw) * (t1 - t0);
    let best = -1;
    let bd = Infinity;
    for (let tt = t0; tt <= t1; tt++) {
      if (!rec(tt)) continue;
      const d = Math.abs(tt - want);
      if (d < bd) {
        bd = d;
        best = tt;
      }
    }
    if (best >= 0) {
      const b = base(best);
      const px = x(best);
      g.strokeStyle = 'rgba(240,235,228,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, T);
      g.lineTo(px, T + ih);
      g.stroke();
      let line = `tick ${best} · T ${buf![b + nsp].toFixed(2)}`;
      for (let k = 0; k < nsp; k++) {
        if (buf![b + k] >= 0.0005) line += ` · ${chem.species[k]} ${buf![b + k].toFixed(2)}`;
      }
      g.font = `10px ${mono}`;
      const tw = g.measureText(line).width;
      const bx = Math.max(L, Math.min(px + 6, L + iw - tw - 4));
      g.fillStyle = 'rgba(38,32,35,0.92)';
      g.fillRect(bx - 3, T + 1, tw + 6, 13);
      g.fillStyle = '#d8cfc9';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(line, bx, T + 8);
    }
  }
}

function ProbeChart(props: { chem: Chemistry; snap: Snapshot; hoverX: RefObject<number | null> }): JSX.Element {
  const { chem, snap, hoverX } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  // repaint on every panel render (the 250 ms pulse): reading ~HIST slots
  // out of a Float32Array and stroking a canvas is cheap and garbage-free
  useEffect(() => {
    if (ref.current) drawChart(ref.current, chem, snap, hoverX.current);
  });
  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: 150, display: 'block' }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hoverX.current = e.clientX - r.left;
        drawChart(e.currentTarget, chem, snap, hoverX.current);
      }}
      onMouseLeave={(e) => {
        hoverX.current = null;
        drawChart(e.currentTarget, chem, snap, null);
      }}
    />
  );
}

// per-probe live snapshot (no copying — hands the chart the live buffer)
function liveSnapshot(w: World, pr: Probe): Snapshot {
  if (pr.frozen) return pr.frozen;
  const seg = resolveAttach(w, { veinId: pr.veinId, at: [pr.x, pr.y] });
  if (!seg) {
    // the probed node is gone: freeze on the last buffer we saw. The world
    // dropped that buffer along with the node, so it's orphaned — keeping
    // it by reference is safe and its contents can no longer change.
    pr.frozen = { h: pr.lastH ?? null, tick: pr.lastTick ?? w.tick };
    return pr.frozen;
  }
  pr.veinId = seg.vein.id;
  pr.lastH = seg.vein.hist[seg.idx];
  pr.lastTick = w.tick;
  return { h: pr.lastH, tick: w.tick };
}

export function ProbePanel(props: {
  world: World;
  probes: Probe[];
  uiTick: number;
  onRemove: (id: number) => void;
  onClear: () => void;
}): JSX.Element {
  const { world, probes, onRemove, onClear } = props;
  const chem = world.chem;
  // one hover x for ALL cards: live charts share a time window, so the
  // crosshair lines up the same tick across every probe
  const hoverX = useRef<number | null>(null);
  void props.uiTick; // the pulse that makes the charts advance

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8d7f84', fontWeight: 700 }}>
          Probes
        </div>
        {probes.length > 0 &&
          <button style={btn} onClick={onClear}>clear all</button>}
      </div>
      {probes.length === 0 && (
        <div style={{ fontSize: 12, color: '#8d7f84', padding: 10, background: '#211b1e', border: '1px dashed #443a3c', borderRadius: 8 }}>
          right-click a vein (or use the probe tool) to chart its composition &amp; temperature here
        </div>
      )}
      {probes.map((pr, i) => {
        const snap = liveSnapshot(world, pr);
        return (
          <div key={pr.id} style={{ background: '#262023', border: '1px solid #443a3c', borderRadius: 8, padding: '6px 8px 2px', marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: mono, fontSize: 11.5, color: '#9db4bd' }}>
                #{i + 1} {pr.label}{pr.frozen ? ' (gone)' : ''}
              </span>
              <button
                onClick={() => onRemove(pr.id)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#e07a6a', fontWeight: 700, fontSize: 13 }}
              >
                ✕
              </button>
            </div>
            <div style={{ height: 150 }}>
              <ProbeChart chem={chem} snap={snap} hoverX={hoverX} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
