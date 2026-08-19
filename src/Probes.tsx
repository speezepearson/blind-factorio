import { useEffect, useRef } from 'react';
import type { JSX, ReactNode, RefObject } from 'react';
import { HIST, resolveAttach } from './world';
import type { Vein, World } from './world';
import type { Chemistry } from './chem';
import { SCALE, speciesColor, tempOf } from './chem';

// A probe's chart data is the vein node's live history ring buffer — HIST
// slots of (nsp species + temperature) Float32s, indexed by tick % HIST,
// NaN where nothing was recorded. When the probed node disappears the probe
// freezes: it keeps the orphaned buffer as of that moment.
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

// ---- the chart: hand-drawn on canvas, straight from world state ----
// Deliberately allocation-free and SVG-free. The panel repaints every
// 250 ms; in this Chromium, sustained per-update garbage (chart-library
// data arrays, SVG path strings) makes V8's committed heap grow without
// bound — used-heap stays flat, the renderer's memory climbs until the tab
// dies ("Aw, Snap"). Reading world buffers directly and painting on canvas
// allocates nothing per frame, which is the fix. Measured before touching
// this: recharts ~45 MB/s, per-pulse row objects ~1 MB/s, direct canvas ~0.

// One column per x position. Probe cards and both cursor charts paint
// through this, so time-series (columns = ticks) and along-the-vein
// profiles (columns = nodes) share one visual language.
interface ChartSource {
  n: number;
  rec(i: number): boolean; // was anything recorded at column i?
  val(i: number, k: number): number; // species k at column i, in parts
  temp(i: number): number;
  axis(i: number): string; // end-of-axis label for column i
  label(i: number): string; // readout prefix ("tick 217" / "node 12")
}

// the hovered node's history over the saved window
function ringSource(chem: Chemistry, snap: Snapshot): ChartSource {
  const h = snap.h;
  const nsp = chem.nsp;
  const t1 = snap.tick;
  const t0 = Math.max(0, t1 - HIST + 1);
  const base = (i: number) => ((t0 + i) % HIST) * (nsp + 1);
  return {
    n: t1 - t0 + 1,
    rec: (i) => h !== null && !Number.isNaN(h[base(i) + nsp]),
    val: (i, k) => h![base(i) + k],
    temp: (i) => h![base(i) + nsp],
    axis: (i) => String(t0 + i),
    label: (i) => `tick ${t0 + i}`,
  };
}

// the current composition/temperature profile along a vein, node by node
// (ghost nodes are gaps — they carry no fluid and have no temperature)
function veinSource(chem: Chemistry, vein: Vein): ChartSource {
  return {
    n: vein.pts.length,
    rec: (i) => vein.inc[i] === 1,
    val: (i, k) => vein.parcels[i].c[k] / SCALE,
    temp: (i) => tempOf(chem, vein.parcels[i]),
    axis: (i) => String(i),
    label: (i) => `node ${i}`,
  };
}

const L = 30;
const R = 30;
const T = 6;
const B = 14;

// crosshair request: a chart-local mouse x in px, or a pinned column
type Cross = { px: number } | { col: number } | null;

function paintChart(cv: HTMLCanvasElement, chem: Chemistry, src: ChartSource, cross: Cross): void {
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
  const iw = w - L - R;
  const ih = h - T - B;
  const n = src.n;
  const nsp = chem.nsp;
  if (n < 2 || iw <= 0 || ih <= 0) return;

  let maxC = 0;
  let maxT = 0;
  for (let i = 0; i < n; i++) {
    if (!src.rec(i)) continue;
    let s = 0;
    for (let k = 0; k < nsp; k++) s += src.val(i, k);
    if (s > maxC) maxC = s;
    const tv = src.temp(i);
    if (tv > maxT) maxT = tv;
  }
  maxC = Math.max(maxC, 1e-6) * 1.05;
  maxT = Math.max(maxT, chem.ambient * 1.3) * 1.05; // keep ambient in view
  const x = (i: number) => L + (iw * i) / (n - 1);
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
  // the species below it, recomputed per column straight from the source
  const below = (i: number, k: number) => {
    let s = 0;
    for (let q = 0; q < k; q++) s += src.val(i, q);
    return s;
  };
  g.globalAlpha = 0.8;
  for (let k = 0; k < nsp; k++) {
    g.fillStyle = speciesColor(chem, k);
    let i = 0;
    while (i < n) {
      while (i < n && !src.rec(i)) i++;
      const start = i;
      while (i < n && src.rec(i)) i++;
      if (i > start) {
        g.beginPath();
        for (let q = start; q < i; q++) g.lineTo(x(q), yC(below(q, k) + src.val(q, k)));
        for (let q = i - 1; q >= start; q--) g.lineTo(x(q), yC(below(q, k)));
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
  for (let i = 0; i < n; i++) {
    if (!src.rec(i)) {
      pen = false;
      continue;
    }
    if (pen) g.lineTo(x(i), yT(src.temp(i)));
    else g.moveTo(x(i), yT(src.temp(i)));
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
  g.fillText(src.axis(0), L, T + ih + 3);
  g.fillText(src.axis(n - 1), L + iw, T + ih + 3);

  // crosshair: vertical line at the requested spot, value readout from the
  // nearest recorded column
  if (cross !== null) {
    const colF = 'col' in cross ? cross.col : ((cross.px - L) / iw) * (n - 1);
    if (colF < -0.5 || colF > n - 0.5) return;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (!src.rec(i)) continue;
      const d = Math.abs(i - colF);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const px = x(Math.max(0, Math.min(n - 1, colF)));
    g.strokeStyle = 'rgba(240,235,228,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, T);
    g.lineTo(px, T + ih);
    g.stroke();
    if (best >= 0) {
      let line = `${src.label(best)} · T ${src.temp(best).toFixed(2)}`;
      for (let k = 0; k < nsp; k++) {
        if (src.val(best, k) >= 0.0005) line += ` · ${chem.species[k]} ${src.val(best, k).toFixed(2)}`;
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

// a probe card's chart: chart-local hover, shared across cards so the
// crosshair lines up the same tick on every probe
function ProbeChart(props: { chem: Chemistry; snap: Snapshot; hoverX: RefObject<number | null> }): JSX.Element {
  const { chem, snap, hoverX } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const paint = (cv: HTMLCanvasElement) =>
    paintChart(cv, chem, ringSource(chem, snap), hoverX.current === null ? null : { px: hoverX.current });
  // repaint on every panel render (the 250 ms pulse): reading the buffer
  // and stroking a canvas is cheap and garbage-free
  useEffect(() => {
    if (ref.current) paint(ref.current);
  });
  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: 150, display: 'block' }}
      onMouseMove={(e) => {
        hoverX.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
        paint(e.currentTarget);
      }}
      onMouseLeave={(e) => {
        hoverX.current = null;
        paint(e.currentTarget);
      }}
    />
  );
}

// a cursor chart: no local mouse (the pointer is on the world canvas);
// the along-the-vein variant pins its crosshair to the hovered node
function CursorChart(props: { chem: Chemistry; src: ChartSource; col: number | null }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintChart(ref.current, props.chem, props.src, props.col === null ? null : { col: props.col });
  });
  return <canvas ref={ref} style={{ width: '100%', height: 150, display: 'block' }} />;
}

function Card(props: { title: string; onRemove?: () => void; children: ReactNode }): JSX.Element {
  return (
    <div style={{ background: '#262023', border: '1px solid #443a3c', borderRadius: 8, padding: '6px 8px 2px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: mono, fontSize: 11.5, color: '#9db4bd' }}>{props.title}</span>
        {props.onRemove && (
          <button
            onClick={props.onRemove}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#e07a6a', fontWeight: 700, fontSize: 13 }}
          >
            ✕
          </button>
        )}
      </div>
      <div style={{ height: 150 }}>{props.children}</div>
    </div>
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
  cursor: { veinId: number; idx: number } | null;
  onRemove: (id: number) => void;
  onClear: () => void;
}): JSX.Element {
  const { world, probes, onRemove, onClear } = props;
  const chem = world.chem;
  // one hover x for ALL probe cards: live charts share a time window, so
  // the crosshair lines up the same tick across every probe
  const hoverX = useRef<number | null>(null);
  void props.uiTick; // the pulse that makes the charts advance

  // the cursor probe: the vein node under the mouse right now, if it still
  // exists (the world may have changed since the last mousemove)
  const cvein = props.cursor ? world.veins.get(props.cursor.veinId) : undefined;
  const cidx = props.cursor && cvein && props.cursor.idx < cvein.pts.length ? props.cursor.idx : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8d7f84', fontWeight: 700 }}>
          Probes
        </div>
        {probes.length > 0 &&
          <button style={btn} onClick={onClear}>clear all</button>}
      </div>
      {cvein && cidx !== null && (
        <>
          <Card title={`cursor · node ${cidx} · history`}>
            <CursorChart chem={chem} src={ringSource(chem, { h: cvein.hist[cidx], tick: world.tick })} col={null} />
          </Card>
          <Card title={'cursor · along the vein'}>
            <CursorChart chem={chem} src={veinSource(chem, cvein)} col={cidx} />
          </Card>
        </>
      )}
      {probes.length === 0 && (
        <div style={{ fontSize: 12, color: '#8d7f84', padding: 10, background: '#211b1e', border: '1px dashed #443a3c', borderRadius: 8 }}>
          right-click a vein (or use the probe tool) to chart its composition &amp; temperature here — or just
          hover a vein for the cursor charts
        </div>
      )}
      {probes.map((pr, i) => (
        <Card
          key={pr.id}
          title={`#${i + 1} ${pr.label}${pr.frozen ? ' (gone)' : ''}`}
          onRemove={() => onRemove(pr.id)}
        >
          <ProbeChart chem={chem} snap={liveSnapshot(world, pr)} hoverX={hoverX} />
        </Card>
      ))}
    </div>
  );
}
