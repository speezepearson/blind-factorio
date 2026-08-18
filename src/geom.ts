// Continuous-space geometry: the world is a plain rectangle of pixels, not
// a lattice. Veins are freehand curves discretized into NODES spaced SEG
// apart along their arc — one parcel per node, advecting node-to-node, so
// the rigid quantization of particles/heat/ticks is untouched: geometry
// only decides which discrete containers sit next to which, and it is
// frozen at draw time. All committed coordinates are quantized to quarter
// pixels (exactly representable), so worlds serialize and replay exactly.

export type Pt = [number, number];

export const WORLD_W = 966;
export const WORLD_H = 630;

export const SEG = 16; // arc length between vein nodes, px (1 node = 1 parcel)
export const R_SNAP = 14; // attach/probe/bud click radius (> SEG/2, so a click on a vein always finds a node)
export const R_CROSS = 10; // crossing veins exchange heat within this node distance
export const R_ORGAN = 52; // organ disc radius
export const PORT_R = 10; // port hit/draw zone radius
export const R_ERASE = 14; // eraser brush radius
export const SRC_R = 13; // source wellhead radius

export const quant = (v: number) => Math.round(v * 4) / 4;
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Chaikin corner-cutting (endpoints pinned): turns a jittery mouse trail
// into an organic curve
export function smooth(pts: Pt[], rounds = 2): Pt[] {
  let cur = pts;
  for (let r = 0; r < rounds; r++) {
    if (cur.length < 3) return cur;
    const out: Pt[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [ax, ay] = cur[i];
      const [bx, by] = cur[i + 1];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

// resample a polyline at (approximately) even arc-length steps, keeping
// both endpoints
export function resample(pts: Pt[], step = SEG): Pt[] {
  if (pts.length < 2) return pts.slice();
  const total = pts.slice(1).reduce((a, p, i) => a + dist(pts[i], p), 0);
  const n = Math.max(1, Math.round(total / step));
  const stride = total / n;
  const out: Pt[] = [pts[0]];
  let acc = 0;
  let next = stride;
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i];
    const b = pts[i + 1];
    let d = dist(a, b);
    while (acc + d >= next - 1e-9) {
      const f = (next - acc) / d;
      const p: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      out.push(p);
      acc = next;
      next += stride;
      d = dist(p, b);
      a = p;
    }
    acc += d;
  }
  if (out.length < 2) out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [quant(x), quant(y)] as Pt);
}

// fractional position along a node chain (t in node-index units)
export function posAt(pts: Pt[], t: number): Pt {
  const n = pts.length;
  if (t <= 0) return pts[0];
  if (t >= n - 1) return pts[n - 1];
  const i = Math.floor(t);
  const f = t - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
}

// even angular candidates on a circle (for placing organ ports)
export function circlePts(c: Pt, r: number, n = 24): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [quant(c[0] + r * Math.cos(a)), quant(c[1] + r * Math.sin(a))] as Pt;
  });
}

// ---- spatial hash over vein nodes, rebuilt per reindex ----

const BUCKET = 32;
const bkey = (x: number, y: number) => Math.floor(x / BUCKET) + ',' + Math.floor(y / BUCKET);

export interface NodeRef<V> {
  vein: V;
  idx: number;
  pt: Pt;
}

export class NodeHash<V> {
  private map = new Map<string, Array<NodeRef<V>>>();

  add(vein: V, idx: number, pt: Pt): void {
    const k = bkey(pt[0], pt[1]);
    let arr = this.map.get(k);
    if (!arr) {
      arr = [];
      this.map.set(k, arr);
    }
    arr.push({ vein, idx, pt });
  }

  near(pt: Pt, r: number): Array<NodeRef<V>> {
    const out: Array<NodeRef<V>> = [];
    const x0 = Math.floor((pt[0] - r) / BUCKET);
    const x1 = Math.floor((pt[0] + r) / BUCKET);
    const y0 = Math.floor((pt[1] - r) / BUCKET);
    const y1 = Math.floor((pt[1] + r) / BUCKET);
    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        const arr = this.map.get(bx + ',' + by);
        if (!arr) continue;
        for (const ref of arr) {
          if (dist(ref.pt, pt) <= r) out.push(ref);
        }
      }
    }
    return out;
  }

  nearest(pt: Pt, r: number): NodeRef<V> | null {
    let best: NodeRef<V> | null = null;
    let bd = Infinity;
    for (const ref of this.near(pt, r)) {
      const d = dist(ref.pt, pt);
      if (d < bd) {
        bd = d;
        best = ref;
      }
    }
    return best;
  }
}
