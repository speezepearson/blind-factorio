import {
  ambientLeak, cloneParcel, emptyParcel, exchangeHeat, radCount, reactParcel,
  sourceParcel, tempOf, totalParticles,
  K_ALONG, K_CROSS, SCALE,
} from './chem';
import type { Chemistry, Parcel } from './chem';
import {
  HEART_B, NSUB, NU_ORG, NU_SRC, NU_T, V_CHAMBER, V_NODE, V_SEED, V_SIDE,
  moveFluid, sSite, ventFluid,
} from './entropy';
import {
  NodeHash, PORT_R, R_CROSS, R_ERASE, R_ORGAN, R_SNAP, SEG, SRC_R, WORLD_H, WORLD_W,
  circlePts, dist, resample,
} from './geom';
import type { Pt } from './geom';

// The world is a continuous rectangle. Fluid lives in VEINS: freehand
// curves discretized into nodes SEG apart along their arc, one parcel per
// node, advecting node-to-node one hop per tick. Veins may pass anywhere;
// nodes of different stretches within R_CROSS of each other exchange heat
// but never matter.
//
// A vein's endpoints attach:
//   head:  open | source | fork (splits half of a host vein's parcel)
//        | port (an organ's out or side port)
//   tail:  open (vents) | merge (adds into a host vein's parcel)
//        | organ-in (feeds an organ)
// Fork/merge anchors are POINTS: they resolve to the nearest node of the
// referenced vein within R_SNAP (healing onto whatever covers the spot if
// that vein is gone — but never onto the anchor's own endpoint; see
// resolveAttach).
//
// Organs are DISCS of radius R_ORGAN, grown by budding anywhere on a vein
// that flows in from outside the disc; the in-disc stretch is eaten and the
// ports sit where the curve pierced the membrane. One organ type exists so
// far — the radical filter — three chambers wired by effusion channels.
//
// ENTROPY-ENGINE BRANCH: advection and organ code are replaced by biased
// detailed-balanced transport channels (docs/thermodynamic-engine.md).
// Each node has a capacity `cap` (radical-slots), born collapsed; the
// world keeps boundary-account meters so conservation and the second law
// are auditable statements.

export const HIST = 400; // rolling probe-history window, ticks
const HIST_CAP = 1600; // max nodes carrying passive history
export const GROW_TICKS = 10; // ticks for a budded organ to grow in
export const INC_PERIOD = 2; // ticks per node of ghost-vein incarnation

export type Head =
  | { type: 'open' }
  | { type: 'source'; spIdx: number }
  | { type: 'fork'; veinId: number; at: Pt }
  | { type: 'port'; organId: number; port: 'out' | 'side' };
export type Tail =
  | { type: 'open' }
  | { type: 'merge'; veinId: number; at: Pt }
  | { type: 'organ-in'; organId: number };

export interface Vein {
  id: number;
  pts: Pt[]; // node positions, ~SEG apart, quantized, frozen after commit
  head: Head;
  tail: Tail;
  parcels: Parcel[];
  cap: number[]; // per-node capacity V in radical-slots — born collapsed, inflates with contents
  flow: number[]; // smoothed radicals/tick per node, drives drawn width
  hist: Array<Float32Array | null>; // per-node probe history ring buffers
  probed?: boolean;
  // Incarnation: drawn veins start as ghosts (inc all 0) and grow real,
  // one node per INC_PERIOD ticks, spreading from every contact with the
  // live network. Ghost nodes have no walls: they carry no fluid and
  // exchange no heat — fluid reaching the frontier vents into the cavity.
  inc: number[]; // 1 = incarnate
  incTick: number[]; // world tick the node incarnated (-1 = never), for smooth extrusion
}

export interface Organ {
  id: number;
  c: Pt; // disc center
  r: number; // disc radius
  portIn: Pt;
  portOut: Pt;
  portSide: Pt;
  // A grown organ is three chambers wired by effusion channels: inlet→main
  // passes everything, inlet→side passes single radicals only. Null while
  // growing. Chamber capacities are the V_CHAMBER/V_SIDE constants.
  chambers: { inlet: Parcel; main: Parcel; side: Parcel } | null;
  // A freshly budded organ grows over GROW_TICKS ticks. While growing it
  // swallows its feed and emits nothing. Budding snips the host vein once,
  // locally, at the organ's center; the two halves stay intact (hidden
  // under the opaque growing blob) until completion, when their in-disc
  // portions are trimmed back to the membrane and the ports attach.
  growth: number; // ticks grown; >= GROW_TICKS = fully incarnate
  pending: { upId: number; downId: number | null } | null; // halves awaiting the completion trim
  load: number; // smoothed input radicals/tick (drives the heartbeat pulse)
  // view-only vent trackers: what an unattached port is spraying into the
  // cavity (smoothed rate + last composition), so the haze can show it
  ventOut: { rate: number; c: Int32Array } | null;
  ventSide: { rate: number; c: Int32Array } | null;
}

export const organGrown = (o: Organ) => o.growth >= GROW_TICKS;

export interface Source {
  pt: Pt;
  spIdx: number;
  name: string;
}

// The declared boundary accounts (docs/thermodynamic-engine.md §10): every
// conservation statement is exact modulo these. Radicals and energy
// (quanta, heat + bond ledger) in/out per account; heartS is the entropy
// budget the peristaltic bias injected; growthSlots the capacity minted by
// construction; cut* books surgery (erasing, trims).
export interface Meters {
  heartS: number;
  srcRad: number;
  srcE: number;
  ventRad: number;
  ventE: number;
  grownRad: number;
  grownE: number;
  cutRad: number;
  cutE: number;
  ambQ: number;
  growthSlots: number;
}

const freshMeters = (): Meters => ({
  heartS: 0, srcRad: 0, srcE: 0, ventRad: 0, ventE: 0,
  grownRad: 0, grownE: 0, cutRad: 0, cutE: 0, ambQ: 0, growthSlots: 0,
});

export interface World {
  chem: Chemistry;
  tick: number;
  veins: Map<number, Vein>;
  organs: Map<number, Organ>;
  nextId: number;
  sources: Source[];
  nodeHash: NodeHash<Vein>; // rebuilt by reindex(); geometry is frozen between edits
  histCount: number;
  meters: Meters;
}

export function makeWorld(chem: Chemistry): World {
  const sources: Source[] = chem.species.map((s, i) => ({
    pt: [26, 42 + i * 72] as Pt,
    spIdx: i,
    name: s,
  }));
  return {
    chem,
    tick: 0,
    veins: new Map(),
    organs: new Map(),
    nextId: 1,
    sources,
    nodeHash: new NodeHash<Vein>(),
    histCount: 0,
    meters: freshMeters(),
  };
}

export function reindex(w: World): void {
  w.nodeHash = new NodeHash<Vein>();
  for (const p of w.veins.values()) {
    p.pts.forEach((pt, i) => w.nodeHash.add(p, i, pt));
  }
}

export const sourceAt = (w: World, pt: Pt): Source | null =>
  w.sources.find((s) => dist(s.pt, pt) <= SRC_R) ?? null;

// What part of an organ (if any) covers this point — ports win over body.
// A growing organ's ports aren't drawn yet, so they aren't clickable yet
// either: only the body blob exists.
export function organAt(w: World, pt: Pt): { organ: Organ; role: 'body' | 'in' | 'out' | 'side' } | null {
  for (const o of w.organs.values()) {
    if (!organGrown(o)) continue;
    if (dist(o.portIn, pt) <= PORT_R) return { organ: o, role: 'in' };
    if (dist(o.portOut, pt) <= PORT_R) return { organ: o, role: 'out' };
    if (dist(o.portSide, pt) <= PORT_R) return { organ: o, role: 'side' };
  }
  for (const o of w.organs.values()) {
    if (dist(o.c, pt) <= o.r) return { organ: o, role: 'body' };
  }
  return null;
}

function newVein(w: World, pts: Pt[], head: Head, tail: Tail, incarnate: boolean): Vein {
  const p: Vein = {
    id: w.nextId++,
    pts: pts.map((q) => [q[0], q[1]] as Pt),
    head,
    tail,
    parcels: pts.map(() => emptyParcel(w.chem)),
    cap: pts.map(() => 0), // born collapsed; inflates as fluid arrives
    hist: pts.map(() => null),
    flow: pts.map(() => 0),
    inc: pts.map(() => (incarnate ? 1 : 0)),
    incTick: pts.map(() => (incarnate ? 0 : -1)),
  };
  w.veins.set(p.id, p);
  return p;
}

export function ensureHist(w: World, vein: Vein, i: number): Float32Array | null {
  if (vein.hist[i]) return vein.hist[i];
  if (w.histCount >= HIST_CAP) return null;
  const h = new Float32Array(HIST * (w.chem.nsp + 1)).fill(NaN);
  vein.hist[i] = h;
  w.histCount++;
  return h;
}

// Resolve a point-anchor to a live node: nearest node of the referenced
// vein within R_SNAP, else heal onto whatever vein covers the spot.
//
// `guard` identifies the vein that OWNS the anchor and which of its ends
// carries it: a fork/merge anchor always sits within snap range of its own
// endpoint (strokes start/end where they attach), so without the guard,
// deleting the host would heal the anchor onto the dependent ITSELF — a
// tail merging into its own last node (an invisible, hazeless black hole
// accumulating fluid forever) or a head forking off itself. The guard
// rejects self-resolution near the owning end; healAttachments then opens
// the anchor honestly. Resolution onto the owner far from that end stays
// legal — that's a deliberately drawn circulation loop.
export function resolveAttach(
  w: World,
  att: { veinId: number; at: Pt },
  guard?: { selfId: number; end: 'head' | 'tail' },
): { vein: Vein; idx: number } | null {
  const bad = (vein: Vein, idx: number) =>
    !!guard &&
    vein.id === guard.selfId &&
    (guard.end === 'tail' ? idx >= vein.pts.length - 2 : idx <= 1);
  const own = w.veins.get(att.veinId);
  if (own) {
    let best = -1;
    let bd = R_SNAP + 1e-9;
    for (let i = 0; i < own.pts.length; i++) {
      if (bad(own, i)) continue;
      const d = dist(own.pts[i], att.at);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) return { vein: own, idx: best };
  }
  const ref = w.nodeHash.nearest(att.at, R_SNAP, (r) => bad(r.vein, r.idx));
  if (ref) {
    att.veinId = ref.vein.id;
    return { vein: ref.vein, idx: ref.idx };
  }
  return null;
}

// ---------------- the tick ----------------

// One step of ghost-vein incarnation: every ghost node touching the live
// network — along its own vein, or at any attachment or junction with an
// incarnate node, a source, or a grown organ — becomes incarnate. Called
// every INC_PERIOD ticks, so fronts advance one node per period.
function growthStep(w: World): void {
  const grow: Array<{ p: Vein; i: number }> = [];
  const liveAt = (att: { veinId: number; at: Pt }, guard: { selfId: number; end: 'head' | 'tail' }): boolean => {
    const seg = resolveAttach(w, att, guard);
    return !!seg && seg.vein.inc[seg.idx] === 1;
  };
  const grownOrgan = (id: number): boolean => {
    const o = w.organs.get(id);
    return !!o && organGrown(o);
  };
  for (const p of w.veins.values()) {
    const n = p.pts.length;
    const last = n - 1;
    for (let i = 0; i < n; i++) {
      if (p.inc[i]) continue;
      if ((i > 0 && p.inc[i - 1]) || (i < last && p.inc[i + 1])) {
        grow.push({ p, i });
        continue;
      }
      if (i === 0) {
        const h = p.head;
        if (
          h.type === 'source' ||
          (h.type === 'fork' && liveAt(h, { selfId: p.id, end: 'head' })) ||
          (h.type === 'port' && grownOrgan(h.organId))
        ) {
          grow.push({ p, i });
          continue;
        }
      }
      if (i === last) {
        const t = p.tail;
        if ((t.type === 'merge' && liveAt(t, { selfId: p.id, end: 'tail' })) || (t.type === 'organ-in' && grownOrgan(t.organId))) grow.push({ p, i });
      }
    }
  }
  // junction seeds: an incarnate vein end touching a ghost node mid-vein
  for (const q of w.veins.values()) {
    if (q.head.type === 'fork' && q.inc[0] === 1) {
      const seg = resolveAttach(w, q.head, { selfId: q.id, end: 'head' });
      if (seg && !seg.vein.inc[seg.idx]) grow.push({ p: seg.vein, i: seg.idx });
    }
    if (q.tail.type === 'merge' && q.inc[q.pts.length - 1] === 1) {
      const seg = resolveAttach(w, q.tail, { selfId: q.id, end: 'tail' });
      if (seg && !seg.vein.inc[seg.idx]) grow.push({ p: seg.vein, i: seg.idx });
    }
  }
  for (const { p, i } of grow) {
    p.inc[i] = 1;
    p.incTick[i] = w.tick;
  }
}

export function doTick(w: World): void {
  const chem = w.chem;
  const M = w.meters;

  // 0) INCARNATION — ghost veins grow real where they touch live network
  if (w.tick % INC_PERIOD === 0) growthStep(w);

  // 0b) INFLATION — veins are born collapsed (cap 0): an incarnate node
  // opens a small seed lumen and dilates geometrically (×1.25/tick) toward
  // what its duty demands: enough slots for 3× its standing stock or 8
  // ticks of its arrival flux, whichever is greater, up to V_NODE. Flux
  // matters: a node passing flow through efficiently keeps low standing
  // contents, and a contents-only ratchet left such nodes as permanent
  // necks choking full-bore jams behind them. No free vacuum: capacity
  // follows fluid use, and every minted slot is booked.
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) {
      if (!p.inc[i]) continue;
      const N = radCount(chem, p.parcels[i].c);
      const desired = Math.min(V_NODE, Math.max(V_SEED, Math.ceil(Math.max(N * 3, p.flow[i] * 8))));
      if (p.cap[i] < desired) {
        const next = Math.min(desired, Math.max(V_SEED, Math.ceil(p.cap[i] * 1.25)));
        M.growthSlots += next - p.cap[i];
        p.cap[i] = next;
      }
    }
  }

  // 1) HEAT — along chains, between nearby nodes (any two incarnate nodes
  // within R_CROSS that aren't chain neighbors: crossings, parallel runs,
  // even a vein's own hairpins), between organ chambers, and ambient leak.
  // Ghost nodes take no part. Hot→cold proportional flow is the ΔS>0
  // direction always — the mean-field form is a safe optimization of the
  // quantum-hop channels (docs/thermodynamic-engine.md addendum).
  for (const p of w.veins.values()) {
    for (let i = 0; i + 1 < p.parcels.length; i++) {
      if (p.inc[i] && p.inc[i + 1]) exchangeHeat(chem, p.parcels[i], p.parcels[i + 1], K_ALONG);
    }
  }
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.pts.length; i++) {
      if (!p.inc[i]) continue;
      const near = w.nodeHash
        .near(p.pts[i], R_CROSS)
        .filter(
          (ref) =>
            (ref.vein.id > p.id || (ref.vein.id === p.id && ref.idx > i + 1)) && ref.vein.inc[ref.idx] === 1,
        )
        .sort((u, v) => u.vein.id - v.vein.id || u.idx - v.idx);
      for (const ref of near) exchangeHeat(chem, p.parcels[i], ref.vein.parcels[ref.idx], K_CROSS);
    }
  }
  for (const o of w.organs.values()) {
    if (!o.chambers) continue;
    exchangeHeat(chem, o.chambers.inlet, o.chambers.main, K_ALONG);
    exchangeHeat(chem, o.chambers.inlet, o.chambers.side, K_ALONG);
    exchangeHeat(chem, o.chambers.main, o.chambers.side, K_ALONG);
  }
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) if (p.inc[i]) M.ambQ += ambientLeak(chem, p.parcels[i]);
  }
  for (const o of w.organs.values()) {
    if (!o.chambers) continue;
    M.ambQ += ambientLeak(chem, o.chambers.inlet);
    M.ambQ += ambientLeak(chem, o.chambers.main);
    M.ambQ += ambientLeak(chem, o.chambers.side);
  }

  // 2) REACTIONS — untouched kinetics: fill cancels from radical-conserving
  // reactions at one site, so the tuned law IS the (★) law restricted there
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) if (p.inc[i]) reactParcel(chem, p.parcels[i]);
  }
  for (const o of w.organs.values()) {
    if (!o.chambers) continue;
    reactParcel(chem, o.chambers.inlet);
    reactParcel(chem, o.chambers.main);
    reactParcel(chem, o.chambers.side);
  }

  // 3) TRANSPORT — every movement of matter is a biased detailed-balanced
  // channel through moveFluid()/ventFluid() (docs/thermodynamic-engine.md).
  // Flow is no longer plug advection: it is the net current the peristaltic
  // bias HEART_B drives down each vein, stalling honestly against fill
  // gradients. Junctions, ports, sources, and vents are just more channels.
  type Att = { vein: Vein; idx: number };
  const forkOf = new Map<number, Att>();
  const mergeOf = new Map<number, Att>();
  const tailVent = new Map<number, 'vent' | 'grown'>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && p.inc[0]) {
      const seg = resolveAttach(w, p.head, { selfId: p.id, end: 'head' });
      if (seg && seg.vein.inc[seg.idx]) forkOf.set(p.id, seg);
    }
    const last = p.pts.length - 1;
    if (!p.inc[last]) continue;
    if (p.tail.type === 'merge') {
      const seg = resolveAttach(w, p.tail, { selfId: p.id, end: 'tail' });
      if (seg && seg.vein.inc[seg.idx]) mergeOf.set(p.id, seg);
      else tailVent.set(p.id, 'vent'); // junction not built yet: vents
    } else if (p.tail.type === 'organ-in') {
      const o = w.organs.get(p.tail.organId);
      // a growing organ swallows its feed (it's building itself with it)
      if (!o) tailVent.set(p.id, 'vent');
      else if (!o.chambers) tailVent.set(p.id, 'grown');
    } else tailVent.set(p.id, 'vent'); // open tail
  }
  const portFed = new Set<string>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'port' && p.inc[0]) portFed.add(p.head.organId + ':' + p.head.port);
  }
  const loadAcc = new Map<number, number>();
  const ventAcc = new Map<string, { rad: number; c: Int32Array }>();
  // per-node arrival flux this tick — feeds flow[] (width, haze, chevrons)
  // and the inflation ratchet
  const arrivals = new Map<number, Float64Array>();
  const bump = (p: Vein, i: number, rad: number): void => {
    if (rad <= 0) return;
    let a = arrivals.get(p.id);
    if (!a) {
      a = new Float64Array(p.pts.length);
      arrivals.set(p.id, a);
    }
    a[i] += rad;
  };
  const tau = 1 / NSUB;
  for (let sub = 0; sub < NSUB; sub++) {
    for (const p of w.veins.values()) {
      const n = p.parcels.length;
      const last = n - 1;
      // source wellhead: detailed-balanced exchange with a frozen reservoir
      // at ambient. UNBIASED — the reservoir seeps at its own chemical
      // potential, so injection self-limits when the head node reaches
      // reservoir fill (a biased wellhead jammed the whole network to
      // saturation); the peristaltic bias lives in the vein hops alone.
      if (p.head.type === 'source' && p.inc[0]) {
        const res = sourceParcel(chem, p.head.spIdx);
        const out = moveFluid(chem, res, V_NODE, p.parcels[0], p.cap[0], 0, NU_SRC, tau, false, true);
        M.srcRad += out.rad;
        M.srcE += out.E;
        M.heartS += out.heartS;
        bump(p, 0, out.rad);
      }
      // organ out/side port: the chamber pushes into the vein's first node
      if (p.head.type === 'port' && p.inc[0]) {
        const o = w.organs.get(p.head.organId);
        if (o?.chambers) {
          const side = p.head.port === 'side';
          const ch = side ? o.chambers.side : o.chambers.main;
          const out = moveFluid(chem, ch, side ? V_SIDE : V_CHAMBER, p.parcels[0], p.cap[0], HEART_B, NU_T, tau);
          M.heartS += out.heartS;
          bump(p, 0, out.rad);
        }
      }
      // fork: the host node feeds the branch's first node
      const fk = forkOf.get(p.id);
      if (fk) {
        const out = moveFluid(chem, fk.vein.parcels[fk.idx], fk.vein.cap[fk.idx], p.parcels[0], p.cap[0], HEART_B, NU_T, tau);
        M.heartS += out.heartS;
        bump(p, 0, out.rad);
      }
      // along the vein, one biased hop channel per adjacent incarnate pair;
      // incarnation frontiers vent
      for (let i = 0; i + 1 < n; i++) {
        if (!p.inc[i]) continue;
        if (p.inc[i + 1]) {
          const out = moveFluid(chem, p.parcels[i], p.cap[i], p.parcels[i + 1], p.cap[i + 1], HEART_B, NU_T, tau);
          M.heartS += out.heartS;
          bump(p, i + 1, out.rad);
        } else {
          const out = ventFluid(chem, p.parcels[i], NU_T, HEART_B, tau);
          M.ventRad += out.rad;
          M.ventE += out.E;
          M.heartS += out.heartS;
        }
      }
      // the tail: merge into a host, feed an organ, be swallowed, or vent
      const mg = mergeOf.get(p.id);
      if (mg) {
        const out = moveFluid(chem, p.parcels[last], p.cap[last], mg.vein.parcels[mg.idx], mg.vein.cap[mg.idx], HEART_B, NU_T, tau);
        M.heartS += out.heartS;
        bump(mg.vein, mg.idx, out.rad);
      } else if (p.tail.type === 'organ-in' && p.inc[last]) {
        const o = w.organs.get(p.tail.organId);
        if (o?.chambers) {
          const out = moveFluid(chem, p.parcels[last], p.cap[last], o.chambers.inlet, V_CHAMBER, HEART_B, NU_T, tau);
          M.heartS += out.heartS;
          loadAcc.set(o.id, (loadAcc.get(o.id) ?? 0) + Math.max(0, out.rad));
        }
      }
      const tv = tailVent.get(p.id);
      if (tv) {
        const out = ventFluid(chem, p.parcels[last], NU_T, HEART_B, tau);
        if (tv === 'grown') {
          M.grownRad += out.rad;
          M.grownE += out.E;
        } else {
          M.ventRad += out.rad;
          M.ventE += out.E;
        }
        M.heartS += out.heartS;
      }
    }
    // organ internals: unbiased effusion channels (inlet→main passes
    // everything, inlet→side passes single radicals only), and any port
    // with no live vein on it vents into the cavity
    for (const o of w.organs.values()) {
      if (!o.chambers) continue;
      const { inlet, main, side } = o.chambers;
      moveFluid(chem, inlet, V_CHAMBER, main, V_CHAMBER, 0, NU_ORG, tau);
      moveFluid(chem, inlet, V_CHAMBER, side, V_SIDE, 0, NU_ORG, tau, true);
      for (const port of ['out', 'side'] as const) {
        if (portFed.has(o.id + ':' + port)) continue;
        const key = o.id + ':' + port;
        let acc = ventAcc.get(key);
        if (!acc) {
          acc = { rad: 0, c: new Int32Array(chem.nsp) };
          ventAcc.set(key, acc);
        }
        const out = ventFluid(chem, port === 'out' ? main : side, NU_T, HEART_B, tau, acc.c);
        acc.rad += out.rad;
        M.ventRad += out.rad;
        M.ventE += out.E;
        M.heartS += out.heartS;
      }
    }
  }
  // organ view-state: the load pulse and the port-vent haze trackers
  for (const o of w.organs.values()) {
    if (!o.chambers) continue;
    o.load = o.load * 0.9 + (loadAcc.get(o.id) ?? 0) * 0.1;
    const upd = (prev: Organ['ventOut'], key: string): Organ['ventOut'] => {
      const acc = ventAcc.get(key);
      if (acc && acc.rad > 0) return { rate: (prev?.rate ?? 0) * 0.9 + acc.rad * 0.1, c: acc.c };
      if (prev && prev.rate * 0.9 > 20) return { rate: prev.rate * 0.9, c: prev.c };
      return null;
    };
    o.ventOut = upd(o.ventOut, o.id + ':out');
    o.ventSide = upd(o.ventSide, o.id + ':side');
  }
  // organs: growing ones just grow; on completion the two host halves are
  // trimmed back to the membrane (their in-disc portions have been hidden
  // under the opaque blob since budding), the ports attach, and the
  // chambers open
  for (const o of w.organs.values()) {
    if (!organGrown(o)) {
      o.growth++;
      if (organGrown(o)) completeBud(w, o);
    }
  }

  // 4) RECORD
  w.tick++;
  const slot = w.tick % HIST;
  for (const p of w.veins.values()) {
    const arr = arrivals.get(p.id);
    for (let i = 0; i < p.parcels.length; i++) {
      const parcel = p.parcels[i];
      // flow is now true flux: radicals ARRIVING at this node per tick
      p.flow[i] = p.flow[i] * 0.9 + (arr ? arr[i] : 0) * 0.1;
      let h = p.hist[i];
      if (!h && (totalParticles(chem, parcel.c) > 0 || p.probed)) h = ensureHist(w, p, i);
      if (!h) continue;
      const base = slot * (chem.nsp + 1);
      for (let s = 0; s < chem.nsp; s++) h[base + s] = parcel.c[s] / SCALE;
      h[base + chem.nsp] = tempOf(chem, parcel);
    }
  }
}

// slice a vein down to pts[s..e], dropping (and accounting) trimmed
// hists and booking the trimmed fluid to the surgery account
function trimVein(w: World, p: Vein, s: number, e: number): void {
  for (let i = 0; i < p.pts.length; i++) {
    if (i < s || i > e) {
      if (p.hist[i]) w.histCount--;
      bookCut(w, p.parcels[i]);
    }
  }
  p.pts = p.pts.slice(s, e + 1);
  p.parcels = p.parcels.slice(s, e + 1);
  p.cap = p.cap.slice(s, e + 1);
  p.hist = p.hist.slice(s, e + 1);
  p.flow = p.flow.slice(s, e + 1);
  p.inc = p.inc.slice(s, e + 1);
  p.incTick = p.incTick.slice(s, e + 1);
}

function deleteVein(w: World, p: Vein): void {
  for (const h of p.hist) if (h) w.histCount--;
  for (const parcel of p.parcels) bookCut(w, parcel);
  w.veins.delete(p.id);
}

// attachments whose anchor no longer resolves to any node go open
function healAttachments(w: World): void {
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && !resolveAttach(w, p.head, { selfId: p.id, end: 'head' })) p.head = { type: 'open' };
    if (p.tail.type === 'merge' && !resolveAttach(w, p.tail, { selfId: p.id, end: 'tail' })) p.tail = { type: 'open' };
  }
}

// Splice fresh empty incarnate nodes onto one end of a vein so it reaches
// exactly to `target` (usually a port point one node-hop away).
function bridgeToPoint(w: World, p: Vein, end: 'head' | 'tail', target: Pt): void {
  const anchor = end === 'head' ? p.pts[0] : p.pts[p.pts.length - 1];
  if (dist(anchor, target) <= 0.5) return;
  const stub =
    end === 'head'
      ? resample([target, anchor], SEG).slice(0, -1)
      : resample([anchor, target], SEG).slice(1);
  const pts = stub.map((q) => [q[0], q[1]] as Pt);
  const parcels = stub.map(() => emptyParcel(w.chem));
  const cap = stub.map(() => 0);
  const hist = stub.map(() => null);
  const flow = stub.map(() => 0);
  const inc = stub.map(() => 1);
  const incTick = stub.map(() => w.tick);
  if (end === 'head') {
    p.pts = [...pts, ...p.pts];
    p.parcels = [...parcels, ...p.parcels];
    p.cap = [...cap, ...p.cap];
    p.hist = [...hist, ...p.hist];
    p.flow = [...flow, ...p.flow];
    p.inc = [...inc, ...p.inc];
    p.incTick = [...incTick, ...p.incTick];
  } else {
    p.pts = [...p.pts, ...pts];
    p.parcels = [...p.parcels, ...parcels];
    p.cap = [...p.cap, ...cap];
    p.hist = [...p.hist, ...hist];
    p.flow = [...p.flow, ...flow];
    p.inc = [...p.inc, ...inc];
    p.incTick = [...p.incTick, ...incTick];
  }
}

// The completion trim: when a budded organ finishes growing, the two host
// halves (snipped at the organ's center at bud time, hidden under the
// opaque blob since) are cut back to the membrane and the ports attach.
// Each surviving half is then extended to end exactly ON its port point,
// so the drawn vein meets the membrane instead of stopping a node short.
function completeBud(w: World, o: Organ): void {
  if (!o.pending) return;
  const { upId, downId } = o.pending;
  o.pending = null;
  const inDisc = (pt: Pt) => dist(pt, o.c) <= o.r;
  const up = w.veins.get(upId);
  if (up && up.tail.type === 'organ-in' && up.tail.organId === o.id) {
    let e = up.pts.length - 1;
    while (e >= 0 && inDisc(up.pts[e])) e--;
    if (e + 1 >= 2) {
      trimVein(w, up, 0, e);
      bridgeToPoint(w, up, 'tail', o.portIn);
    } else deleteVein(w, up); // fully swallowed
  }
  const down = downId !== null ? w.veins.get(downId) : undefined;
  if (down && down.head.type === 'open') {
    let s = 0;
    while (s < down.pts.length && inDisc(down.pts[s])) s++;
    if (down.pts.length - s >= 2) {
      trimVein(w, down, s, down.pts.length - 1);
      down.head = { type: 'port', organId: o.id, port: 'out' };
      bridgeToPoint(w, down, 'head', o.portOut);
    } else deleteVein(w, down);
  }
  // the chambers open (built by construction: the swallowed feed paid for
  // them — book the minted capacity to the growth account)
  o.chambers = makeChambers(w.chem);
  w.meters.growthSlots += 2 * V_CHAMBER + V_SIDE;
  reindex(w);
  healAttachments(w);
}

export const makeChambers = (chem: Chemistry): NonNullable<Organ['chambers']> => ({
  inlet: emptyParcel(chem),
  main: emptyParcel(chem),
  side: emptyParcel(chem),
});

// Total world entropy — the god readout; the meters are its boundary flows.
export function worldEntropy(w: World): number {
  let S = 0;
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) {
      if (p.inc[i]) S += sSite(w.chem, p.parcels[i], p.cap[i]);
    }
  }
  for (const o of w.organs.values()) {
    if (!o.chambers) continue;
    S += sSite(w.chem, o.chambers.inlet, V_CHAMBER);
    S += sSite(w.chem, o.chambers.main, V_CHAMBER);
    S += sSite(w.chem, o.chambers.side, V_SIDE);
  }
  return S;
}

// surgery (erasing, trims) removes fluid from the world outside the
// physics: book it so the radical/energy audits stay exact
function bookCut(w: World, p: Parcel): void {
  const rad = radCount(w.chem, p.c);
  if (rad === 0 && p.U === 0) return;
  w.meters.cutRad += rad;
  let E = p.U; // energy content = heat − bond depth (U − E_bond is the invariant)
  for (let s = 0; s < w.chem.nsp; s++) E -= p.c[s] * w.chem.bondEq[s];
  w.meters.cutE += E;
}

// ---------------- editing ops ----------------

// Player-drawn veins start as ghosts; preset/import builders pass
// incarnate: true to lay live vasculature. pts must already be resampled
// to ~SEG spacing and quantized.
export function commitVein(w: World, pts: Pt[], head: Head, tail: Tail, incarnate = false): Vein | null {
  if (pts.length < 2) return null;
  const p = newVein(w, pts, head, tail, incarnate);
  reindex(w);
  return p;
}

// Erase everything the brush touched: organs whose disc it hit die
// (attachments re-open; a growing organ's snipped host halves survive,
// re-exposed), and veins lose the nodes within R_ERASE of the brush,
// splitting into fragments (fluid rides along).
export function eraseNear(w: World, brush: Pt[]): void {
  const hit = (pt: Pt, r: number) => brush.some((bp) => dist(bp, pt) <= r);
  for (const o of [...w.organs.values()]) {
    if (
      hit(o.c, R_ERASE + o.r) ||
      hit(o.portIn, R_ERASE) ||
      hit(o.portOut, R_ERASE) ||
      hit(o.portSide, R_ERASE)
    ) {
      for (const p of w.veins.values()) {
        if (p.head.type === 'port' && p.head.organId === o.id) p.head = { type: 'open' };
        if (p.tail.type === 'organ-in' && p.tail.organId === o.id) p.tail = { type: 'open' };
      }
      if (o.chambers) {
        bookCut(w, o.chambers.inlet);
        bookCut(w, o.chambers.main);
        bookCut(w, o.chambers.side);
      }
      w.organs.delete(o.id);
    }
  }
  const newVeins: Vein[] = [];
  for (const p of [...w.veins.values()]) {
    if (!p.pts.some((pt) => hit(pt, R_ERASE))) {
      newVeins.push(p);
      continue;
    }
    w.veins.delete(p.id);
    type Run = {
      pt: Pt; parcel: Parcel; cap: number; hist: Float32Array | null; flow: number;
      inc: number; incTick: number; i: number;
    };
    let run: Run[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const isFirst = run[0].i === 0;
        const isLast = run[run.length - 1].i === p.pts.length - 1;
        newVeins.push({
          id: w.nextId++,
          pts: run.map((r) => r.pt),
          parcels: run.map((r) => r.parcel),
          cap: run.map((r) => r.cap),
          hist: run.map((r) => r.hist),
          flow: run.map((r) => r.flow),
          inc: run.map((r) => r.inc),
          incTick: run.map((r) => r.incTick),
          head: isFirst ? p.head : { type: 'open' },
          tail: isLast ? p.tail : { type: 'open' },
          probed: p.probed,
        });
      } else {
        for (const r of run) {
          if (r.hist) w.histCount--;
          bookCut(w, r.parcel);
        }
      }
      run = [];
    };
    for (let i = 0; i < p.pts.length; i++) {
      if (hit(p.pts[i], R_ERASE)) {
        flush();
        if (p.hist[i]) w.histCount--;
        bookCut(w, p.parcels[i]);
      } else {
        run.push({
          pt: p.pts[i], parcel: p.parcels[i], cap: p.cap[i], hist: p.hist[i], flow: p.flow[i],
          inc: p.inc[i], incTick: p.incTick[i], i,
        });
      }
    }
    flush();
  }
  w.veins = new Map(newVeins.map((p) => [p.id, p]));
  reindex(w);
  healAttachments(w);
}

// ---- endpoint extension & unification ----
// Starting a stroke on a vein's open tail (or ending one on a vein's open
// head) EXTENDS that vein rather than forking/merging — no 50/50 split, no
// stub vent. New nodes are ghosts and incarnate from the join.

// append drawn nodes to a vein's open tail; the vein keeps its id
export function extendVeinTail(w: World, p: Vein, pts: Pt[], tail: Tail): void {
  p.pts = [...p.pts, ...pts.map((q) => [q[0], q[1]] as Pt)];
  p.parcels = [...p.parcels, ...pts.map(() => emptyParcel(w.chem))];
  p.cap = [...p.cap, ...pts.map(() => 0)];
  p.hist = [...p.hist, ...pts.map(() => null)];
  p.flow = [...p.flow, ...pts.map(() => 0)];
  p.inc = [...p.inc, ...pts.map(() => 0)];
  p.incTick = [...p.incTick, ...pts.map(() => -1)];
  p.tail = tail;
  reindex(w);
}

// prepend drawn nodes to a vein's open head (the stroke feeds it)
export function extendVeinHead(w: World, p: Vein, pts: Pt[], head: Head): void {
  p.pts = [...pts.map((q) => [q[0], q[1]] as Pt), ...p.pts];
  p.parcels = [...pts.map(() => emptyParcel(w.chem)), ...p.parcels];
  p.cap = [...pts.map(() => 0), ...p.cap];
  p.hist = [...pts.map(() => null), ...p.hist];
  p.flow = [...pts.map(() => 0), ...p.flow];
  p.inc = [...pts.map(() => 0), ...p.inc];
  p.incTick = [...pts.map(() => -1), ...p.incTick];
  p.head = head;
  reindex(w);
}

// a stroke bridging one vein's open tail to another's open head fuses the
// three into a single vein (upstream keeps its id; anchors and probes on
// the absorbed vein heal onto it by proximity)
export function uniteVeins(w: World, up: Vein, bridge: Pt[], down: Vein): void {
  up.pts = [...up.pts, ...bridge.map((q) => [q[0], q[1]] as Pt), ...down.pts];
  up.parcels = [...up.parcels, ...bridge.map(() => emptyParcel(w.chem)), ...down.parcels];
  up.cap = [...up.cap, ...bridge.map(() => 0), ...down.cap];
  up.hist = [...up.hist, ...bridge.map(() => null), ...down.hist];
  up.flow = [...up.flow, ...bridge.map(() => 0), ...down.flow];
  up.inc = [...up.inc, ...bridge.map(() => 0), ...down.inc];
  up.incTick = [...up.incTick, ...bridge.map(() => -1), ...down.incTick];
  up.tail = down.tail;
  up.probed = up.probed || down.probed;
  w.veins.delete(down.id);
  reindex(w);
}

// ---- whole-stretch erase (shift-click) ----

// The junction-to-junction span of vein under a point: from the nearest
// node, extend both ways until the next node some OTHER vein forks from or
// merges into (exclusive — the junction node survives for its dependents),
// or the vein's end.
export function veinSpanAt(w: World, at: Pt): { vein: Vein; i0: number; i1: number } | null {
  const ref = w.nodeHash.nearest(at, R_SNAP);
  if (!ref) return null;
  const p = ref.vein;
  const junc = new Set<number>();
  for (const q of w.veins.values()) {
    if (q.id === p.id) continue;
    const atts: Array<{ veinId: number; at: Pt }> = [];
    if (q.head.type === 'fork') atts.push(q.head);
    if (q.tail.type === 'merge') atts.push(q.tail);
    for (const att of atts) {
      const guard = { selfId: q.id, end: (att === q.head ? 'head' : 'tail') as 'head' | 'tail' };
      const seg = resolveAttach(w, att, guard);
      if (seg && seg.vein.id === p.id) junc.add(seg.idx);
    }
  }
  // clicking the junction node itself is ambiguous (and deleting it would
  // dangle its dependents): no-op — click a hair to either side
  if (junc.has(ref.idx)) return null;
  let i0 = ref.idx;
  let i1 = ref.idx;
  while (i0 - 1 >= 0 && !junc.has(i0 - 1)) i0--;
  while (i1 + 1 <= p.pts.length - 1 && !junc.has(i1 + 1)) i1++;
  return { vein: p, i0, i1 };
}

// sever nodes [i0..i1], keeping junction-anchored remainders as fragments
export function eraseSpan(w: World, veinId: number, i0: number, i1: number): void {
  const p = w.veins.get(veinId);
  if (!p) return;
  const n = p.pts.length;
  for (let i = i0; i <= i1 && i < n; i++) {
    if (p.hist[i]) w.histCount--;
    bookCut(w, p.parcels[i]);
  }
  const frag = (s: number, e: number, head: Head, tail: Tail) => {
    if (e - s + 1 < 2) {
      for (let i = s; i <= e; i++) {
        if (p.hist[i]) w.histCount--;
        bookCut(w, p.parcels[i]);
      }
      return;
    }
    const f: Vein = {
      id: w.nextId++,
      pts: p.pts.slice(s, e + 1),
      parcels: p.parcels.slice(s, e + 1),
      cap: p.cap.slice(s, e + 1),
      hist: p.hist.slice(s, e + 1),
      flow: p.flow.slice(s, e + 1),
      inc: p.inc.slice(s, e + 1),
      incTick: p.incTick.slice(s, e + 1),
      head,
      tail,
      probed: p.probed,
    };
    w.veins.set(f.id, f);
  };
  w.veins.delete(p.id);
  if (i0 > 0) frag(0, i0 - 1, p.head, { type: 'open' });
  if (i1 < n - 1) frag(i1 + 1, n - 1, { type: 'open' }, p.tail);
  reindex(w);
  healAttachments(w);
}

// Bud an organ on the nearest vein node to `at`: its disc eats the
// contiguous in-disc stretch of that vein. The host is cut: upstream feeds
// the organ's in port, downstream grows from its out port, both sitting
// where the curve pierced the membrane. (Hard-coded to the radical filter
// for now — the mixture-determined budding grammar is a later milestone.)
export function tryBud(w: World, at: Pt, opts?: { instant?: boolean }): { ok: boolean; msg: string } {
  const cands = w.nodeHash
    .near(at, R_SNAP)
    .sort((u, v) => dist(u.pt, at) - dist(v.pt, at));
  if (cands.length === 0) return { ok: false, msg: 'no vein here' };
  let why = 'bud failed: needs a vein flowing through from outside';
  for (const { vein: p, idx } of cands) {
    const center = p.pts[idx];
    if (
      center[0] - R_ORGAN < 0 || center[1] - R_ORGAN < 0 ||
      center[0] + R_ORGAN >= WORLD_W || center[1] + R_ORGAN >= WORLD_H
    ) {
      why = 'too close to the edge';
      continue;
    }
    const inFoot = (pt: Pt) => dist(pt, center) <= R_ORGAN;
    const n = p.pts.length;
    let a = idx;
    while (a - 1 >= 0 && inFoot(p.pts[a - 1])) a--;
    let b = idx;
    while (b + 1 < n && inFoot(p.pts[b + 1])) b++;
    if (a === 0) {
      why = 'the vein must flow in from outside';
      continue;
    }
    if (b === n - 1 && p.tail.type !== 'open') {
      why = p.tail.type === 'merge' ? "there's a junction in the way" : 'too close to another organ';
      continue;
    }
    if (a === 1 || n - 1 - b === 1) {
      why = 'too close to the end of the vein';
      continue;
    }
    if (!p.inc.slice(a, b + 1).every((v) => v === 1)) {
      why = 'the vein here is not grown in yet';
      continue;
    }
    // no third-party junctions on the doomed stretch (they'd dangle into a
    // vent hidden under the organ body)
    let junction = false;
    for (const q of w.veins.values()) {
      if (q.id === p.id) continue;
      const checks: Array<{ veinId: number; at: Pt }> = [];
      if (q.head.type === 'fork') checks.push(q.head);
      if (q.tail.type === 'merge') checks.push(q.tail);
      for (const att of checks) {
        const guard = { selfId: q.id, end: (att === q.head ? 'head' : 'tail') as 'head' | 'tail' };
        const seg = resolveAttach(w, att, guard);
        if (seg && seg.vein.id === p.id && seg.idx >= a && seg.idx <= b) junction = true;
      }
      if (junction) break;
    }
    if (junction) {
      why = "there's a junction in the way";
      continue;
    }
    // the disc must clear other organs and sources
    let blocked = false;
    for (const o2 of w.organs.values()) if (dist(o2.c, center) < R_ORGAN + o2.r + 6) blocked = true;
    for (const s of w.sources) if (dist(s.pt, center) < R_ORGAN + SRC_R + 6) blocked = true;
    if (blocked) {
      why = 'no room for the organ here';
      continue;
    }

    // ---- placement: ports sit where the curve pierced the membrane ----
    // Freely-placed ports prefer rim points no surviving vein runs near: a
    // port on a live stretch would capture its mouse interactions. The
    // doomed stretch [a..b] doesn't count — it's about to be eaten.
    const occupied = (pt: Pt) =>
      w.nodeHash.near(pt, 9).some((s) => s.vein.id !== p.id || s.idx < a || s.idx > b);
    const rimPick = (avoid: Pt[]): Pt => {
      const all = circlePts(center, R_ORGAN);
      const free = all.filter((pt) => !occupied(pt));
      return (free.length > 0 ? free : all).reduce((best, pt) => {
        const d = Math.min(...avoid.map((v) => dist(pt, v)));
        const bd = Math.min(...avoid.map((v) => dist(best, v)));
        return d > bd ? pt : best;
      });
    };
    const portIn: Pt = [p.pts[a][0], p.pts[a][1]];
    // out port: the natural exit crossing — unless the vein exits right
    // where it entered, or terminates inside, in which case it relocates
    // along the rim (completeBud grows a connecting stub if needed)
    let portOut: Pt;
    if (b < n - 1 && dist(p.pts[b], portIn) >= 18) {
      portOut = [p.pts[b][0], p.pts[b][1]];
    } else {
      portOut = rimPick([portIn]);
    }
    const portSide = rimPick([portIn, portOut]);

    const instant = opts?.instant ?? false;
    const o: Organ = {
      id: w.nextId++,
      c: [center[0], center[1]],
      r: R_ORGAN,
      portIn,
      portOut,
      portSide,
      chambers: null,
      growth: instant ? GROW_TICKS : 0,
      pending: null,
      load: 0,
      ventOut: null,
      ventSide: null,
    };
    // The bud itself is LOCAL: snip the host once, at the organ's center.
    // Both halves stay intact — their in-disc portions hidden under the
    // opaque growing blob — until completeBud() trims them back to the
    // membrane on completion. The upstream half keeps the host's id, so
    // anchors referencing the host keep resolving.
    let m = idx;
    if (n - m - 1 === 1) m = idx + 1; // never strand a 1-node orphan
    const bPts = p.pts.slice(m + 1);
    let downId: number | null = null;
    if (bPts.length >= 2) {
      const B: Vein = {
        id: w.nextId++,
        pts: bPts,
        parcels: p.parcels.slice(m + 1),
        cap: p.cap.slice(m + 1),
        hist: p.hist.slice(m + 1),
        flow: p.flow.slice(m + 1),
        inc: p.inc.slice(m + 1),
        incTick: p.incTick.slice(m + 1),
        head: { type: 'open' },
        tail: p.tail,
        probed: p.probed,
      };
      w.veins.set(B.id, B);
      downId = B.id;
    }
    p.pts = p.pts.slice(0, m + 1);
    p.parcels = p.parcels.slice(0, m + 1);
    p.cap = p.cap.slice(0, m + 1);
    p.hist = p.hist.slice(0, m + 1);
    p.flow = p.flow.slice(0, m + 1);
    p.inc = p.inc.slice(0, m + 1);
    p.incTick = p.incTick.slice(0, m + 1);
    p.tail = { type: 'organ-in', organId: o.id };
    o.pending = { upId: p.id, downId };
    w.organs.set(o.id, o);
    reindex(w);
    if (instant) completeBud(w, o);
    return { ok: true, msg: 'something is budding here' };
  }
  return { ok: false, msg: why };
}

// ---------------- undo snapshots ----------------
// Deep-clone the world minus probe history (observational, not world state;
// re-created lazily after a restore). The Chemistry object is shared.

export function snapshotWorld(w: World): World {
  const snap: World = {
    chem: w.chem,
    tick: w.tick,
    veins: new Map(
      [...w.veins.values()].map((p) => [
        p.id,
        {
          id: p.id,
          pts: p.pts.map((pt) => [pt[0], pt[1]] as Pt),
          head: { ...p.head },
          tail: { ...p.tail },
          parcels: p.parcels.map(cloneParcel),
          cap: [...p.cap],
          hist: p.pts.map(() => null),
          flow: [...p.flow],
          inc: [...p.inc],
          incTick: [...p.incTick],
          probed: p.probed,
        } satisfies Vein,
      ]),
    ),
    organs: new Map(
      [...w.organs.values()].map((o) => [
        o.id,
        {
          ...o,
          c: [o.c[0], o.c[1]] as Pt,
          portIn: [o.portIn[0], o.portIn[1]] as Pt,
          portOut: [o.portOut[0], o.portOut[1]] as Pt,
          portSide: [o.portSide[0], o.portSide[1]] as Pt,
          pending: o.pending ? { ...o.pending } : null,
          ventOut: null, // view-only trackers regrow after a restore
          ventSide: null,
          chambers: o.chambers
            ? {
                inlet: cloneParcel(o.chambers.inlet),
                main: cloneParcel(o.chambers.main),
                side: cloneParcel(o.chambers.side),
              }
            : null,
        } satisfies Organ,
      ]),
    ),
    nextId: w.nextId,
    sources: w.sources,
    nodeHash: new NodeHash<Vein>(),
    histCount: 0,
    meters: { ...w.meters },
  };
  reindex(snap);
  return snap;
}
