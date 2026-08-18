import {
  addInto, ambientLeak, cloneParcel, emptyParcel, exchangeHeat, radCount, reactParcel,
  sourceParcel, splitHalf, stochRound, tempOf, totalParticles,
  K_ALONG, K_CROSS, SCALE,
} from './chem';
import type { Chemistry, Parcel } from './chem';
import {
  NodeHash, R_CROSS, R_ERASE, R_ORGAN, R_SNAP, SEG, SRC_R, WORLD_H, WORLD_W,
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
// that vein is gone).
//
// Organs are DISCS of radius R_ORGAN, grown by budding anywhere on a vein
// that flows in from outside the disc; the in-disc stretch is eaten and the
// ports sit where the curve pierced the membrane. One organ type exists so
// far — the radical filter — hard-coded in organProcess().

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
  inAccum: Parcel | null;
  outReady: Parcel | null;
  sideReady: Parcel | null;
  // A freshly budded organ grows over GROW_TICKS ticks. While growing it
  // swallows its feed and emits nothing; the stretch of host vein under it
  // stays visible until growth completes, then is removed.
  growth: number; // ticks grown; >= GROW_TICKS = fully incarnate
  understretchId: number | null; // the doomed host-vein stretch beneath it
  load: number; // smoothed input radicals/tick (drives the heartbeat pulse)
}

export const organGrown = (o: Organ) => o.growth >= GROW_TICKS;

export interface Source {
  pt: Pt;
  spIdx: number;
  name: string;
}

export interface World {
  chem: Chemistry;
  tick: number;
  veins: Map<number, Vein>;
  organs: Map<number, Organ>;
  nextId: number;
  sources: Source[];
  nodeHash: NodeHash<Vein>; // rebuilt by reindex(); geometry is frozen between edits
  histCount: number;
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

// what part of an organ (if any) covers this point — ports win over body
export function organAt(w: World, pt: Pt): { organ: Organ; role: 'body' | 'in' | 'out' | 'side' } | null {
  for (const o of w.organs.values()) {
    if (dist(o.portIn, pt) <= 10) return { organ: o, role: 'in' };
    if (dist(o.portOut, pt) <= 10) return { organ: o, role: 'out' };
    if (dist(o.portSide, pt) <= 10) return { organ: o, role: 'side' };
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
export function resolveAttach(w: World, att: { veinId: number; at: Pt }): { vein: Vein; idx: number } | null {
  const own = w.veins.get(att.veinId);
  if (own) {
    let best = -1;
    let bd = R_SNAP + 1e-9;
    for (let i = 0; i < own.pts.length; i++) {
      const d = dist(own.pts[i], att.at);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) return { vein: own, idx: best };
  }
  const ref = w.nodeHash.nearest(att.at, R_SNAP);
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
  const liveAt = (att: { veinId: number; at: Pt }): boolean => {
    const seg = resolveAttach(w, att);
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
          (h.type === 'fork' && liveAt(h)) ||
          (h.type === 'port' && grownOrgan(h.organId))
        ) {
          grow.push({ p, i });
          continue;
        }
      }
      if (i === last) {
        const t = p.tail;
        if ((t.type === 'merge' && liveAt(t)) || (t.type === 'organ-in' && grownOrgan(t.organId))) grow.push({ p, i });
      }
    }
  }
  // junction seeds: an incarnate vein end touching a ghost node mid-vein
  for (const q of w.veins.values()) {
    if (q.head.type === 'fork' && q.inc[0] === 1) {
      const seg = resolveAttach(w, q.head);
      if (seg && !seg.vein.inc[seg.idx]) grow.push({ p: seg.vein, i: seg.idx });
    }
    if (q.tail.type === 'merge' && q.inc[q.pts.length - 1] === 1) {
      const seg = resolveAttach(w, q.tail);
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

  // 0) INCARNATION — ghost veins grow real where they touch live network
  if (w.tick % INC_PERIOD === 0) growthStep(w);

  // 1) HEAT — along chains, between nearby nodes (any two incarnate nodes
  // within R_CROSS that aren't chain neighbors: crossings, parallel runs,
  // even a vein's own hairpins), and ambient leak. Ghost nodes take no part.
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
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) if (p.inc[i]) ambientLeak(chem, p.parcels[i]);
  }

  // 2) REACTIONS
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) if (p.inc[i]) reactParcel(chem, p.parcels[i]);
  }

  // 3) ADVECTION — veins have infinite throughput: everything advances one
  // node every tick, nothing ever queues. Fluid that runs out of vein
  // vents into the cavity; every vent is structurally visible — an open
  // tail, the frontier of a still-incarnating ghost, a growing organ's
  // mouth — so mass-balance inference stays honest.
  const headIn = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && p.inc[0]) {
      const seg = resolveAttach(w, p.head);
      if (seg && seg.vein.inc[seg.idx]) headIn.set(p.id, splitHalf(chem, seg.vein.parcels[seg.idx]));
    }
  }
  const tailOut = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    const n = p.pts.length;
    if (p.inc[n - 1]) tailOut.set(p.id, p.parcels[n - 1]);
    let fill: Parcel | null = null;
    if (p.inc[0]) {
      if (p.head.type === 'source') fill = sourceParcel(chem, p.head.spIdx);
      else if (p.head.type === 'fork') fill = headIn.get(p.id) ?? null;
      else if (p.head.type === 'port') {
        const o = w.organs.get(p.head.organId);
        if (o) {
          const slot = p.head.port === 'side' ? 'sideReady' : 'outReady';
          if (o[slot]) {
            fill = o[slot];
            o[slot] = null;
          }
        }
      }
    }
    const old = p.parcels;
    const next = new Array<Parcel>(n);
    for (let i = n - 1; i >= 1; i--) {
      // a parcel shifting into a not-yet-incarnate node vents at the frontier
      next[i] = p.inc[i] ? old[i - 1] : emptyParcel(chem);
    }
    next[0] = fill ?? emptyParcel(chem);
    p.parcels = next;
  }
  for (const p of w.veins.values()) {
    const out = tailOut.get(p.id);
    if (!out) continue;
    if (p.tail.type === 'merge') {
      const seg = resolveAttach(w, p.tail);
      // a merge target still ghost = the junction isn't built yet: vents
      if (seg && seg.vein.inc[seg.idx]) addInto(chem, seg.vein.parcels[seg.idx], out);
    } else if (p.tail.type === 'organ-in') {
      const o = w.organs.get(p.tail.organId);
      // a growing organ swallows its feed (it's building itself with it)
      if (o && organGrown(o)) {
        if (o.inAccum) addInto(chem, o.inAccum, out);
        else o.inAccum = out;
      }
    }
    // open tails vent (discarded)
  }
  // organs: growing ones just grow; on completion the host stretch beneath
  // is garbage-collected (it has been hidden under the organ since budding)
  let reindexNeeded = false;
  for (const o of w.organs.values()) {
    if (!organGrown(o)) {
      o.growth++;
      o.outReady = null;
      o.sideReady = null;
      o.inAccum = null;
      if (organGrown(o) && o.understretchId !== null) {
        const stretch = w.veins.get(o.understretchId);
        if (stretch) {
          for (const h of stretch.hist) if (h) w.histCount--;
          w.veins.delete(stretch.id);
          reindexNeeded = true;
        }
        o.understretchId = null;
      }
      continue;
    }
    organProcess(w, o);
  }
  if (reindexNeeded) reindex(w);

  // 4) RECORD
  w.tick++;
  const slot = w.tick % HIST;
  for (const p of w.veins.values()) {
    for (let i = 0; i < p.parcels.length; i++) {
      const parcel = p.parcels[i];
      p.flow[i] = p.flow[i] * 0.9 + radCount(chem, parcel.c) * 0.1;
      let h = p.hist[i];
      if (!h && (totalParticles(chem, parcel.c) > 0 || p.probed)) h = ensureHist(w, p, i);
      if (!h) continue;
      const base = slot * (chem.nsp + 1);
      for (let s = 0; s < chem.nsp; s++) h[base + s] = parcel.c[s] / SCALE;
      h[base + chem.nsp] = tempOf(chem, parcel);
    }
  }
}

// The radical filter, the one organ so far: free radicals (single-radical
// species) exit the side port, composites pass through to out. Heat splits
// in proportion to the radicals each stream carries.
function organProcess(w: World, o: Organ): void {
  const chem = w.chem;
  o.outReady = null;
  o.sideReady = null; // unconsumed previous output vents
  const inp = o.inAccum;
  o.inAccum = null;
  o.load = o.load * 0.9 + (inp ? radCount(chem, inp.c) : 0) * 0.1;
  if (!inp || totalParticles(chem, inp.c) === 0) return;
  const main: Parcel = { c: new Int32Array(chem.nsp), U: 0 };
  const side: Parcel = { c: new Int32Array(chem.nsp), U: 0 };
  for (let i = 0; i < chem.nsp; i++) {
    if (chem.radcount[i] === 1) side.c[i] = inp.c[i];
    else main.c[i] = inp.c[i];
  }
  const rm = radCount(chem, main.c);
  const rs = radCount(chem, side.c);
  const tot = rm + rs;
  if (tot > 0) {
    side.U = stochRound(inp.U * (rs / tot));
    side.U = Math.max(0, Math.min(side.U, inp.U));
    main.U = inp.U - side.U;
  } else main.U = inp.U;
  o.outReady = main;
  o.sideReady = side;
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
// (attachments re-open; a growing organ's understretch is re-exposed), and
// veins lose the nodes within R_ERASE of the brush, splitting into
// fragments (fluid rides along).
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
      pt: Pt; parcel: Parcel; hist: Float32Array | null; flow: number;
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
          hist: run.map((r) => r.hist),
          flow: run.map((r) => r.flow),
          inc: run.map((r) => r.inc),
          incTick: run.map((r) => r.incTick),
          head: isFirst ? p.head : { type: 'open' },
          tail: isLast ? p.tail : { type: 'open' },
          probed: p.probed,
        });
      } else {
        for (const r of run) if (r.hist) w.histCount--;
      }
      run = [];
    };
    for (let i = 0; i < p.pts.length; i++) {
      if (hit(p.pts[i], R_ERASE)) {
        flush();
        if (p.hist[i]) w.histCount--;
      } else {
        run.push({
          pt: p.pts[i], parcel: p.parcels[i], hist: p.hist[i], flow: p.flow[i],
          inc: p.inc[i], incTick: p.incTick[i], i,
        });
      }
    }
    flush();
  }
  w.veins = new Map(newVeins.map((p) => [p.id, p]));
  reindex(w);
  // attachments pointing at vanished nodes go open
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && !resolveAttach(w, p.head)) p.head = { type: 'open' };
    if (p.tail.type === 'merge' && !resolveAttach(w, p.tail)) p.tail = { type: 'open' };
  }
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
        const seg = resolveAttach(w, att);
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
    let portOut: Pt;
    let downPrepend: Pt[] = [];
    if (b < n - 1) {
      const natural = p.pts[b];
      if (dist(natural, portIn) >= 18) {
        portOut = [natural[0], natural[1]];
      } else {
        // the vein exits right where it entered: shove the out port along
        // the rim and grow a stub of vein connecting it to the downstream
        portOut = rimPick([portIn]);
        downPrepend = resample([portOut, p.pts[b + 1]], SEG).slice(0, -1);
      }
    } else {
      // the vein terminates inside: the out port goes wherever there's room
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
      inAccum: null,
      outReady: null,
      sideReady: null,
      growth: instant ? GROW_TICKS : 0,
      understretchId: null,
      load: 0,
    };
    const upPts = p.pts.slice(0, a);
    const downPts = [...downPrepend, ...p.pts.slice(b + 1)];
    w.veins.delete(p.id);
    if (instant) {
      for (let j = a; j <= b; j++) if (p.hist[j]) w.histCount--;
    } else {
      const stretch: Vein = {
        id: w.nextId++,
        pts: p.pts.slice(a, b + 1),
        parcels: p.parcels.slice(a, b + 1),
        hist: p.hist.slice(a, b + 1),
        flow: p.flow.slice(a, b + 1),
        inc: p.inc.slice(a, b + 1),
        incTick: p.incTick.slice(a, b + 1),
        head: { type: 'open' },
        tail: { type: 'open' },
        probed: p.probed,
      };
      w.veins.set(stretch.id, stretch);
      o.understretchId = stretch.id;
    }
    if (upPts.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        pts: upPts,
        parcels: p.parcels.slice(0, a),
        hist: p.hist.slice(0, a),
        flow: p.flow.slice(0, a),
        inc: p.inc.slice(0, a),
        incTick: p.incTick.slice(0, a),
        head: p.head,
        tail: { type: 'organ-in', organId: o.id },
        probed: p.probed,
      });
    }
    if (downPts.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        pts: downPts,
        parcels: [...downPrepend.map(() => emptyParcel(w.chem)), ...p.parcels.slice(b + 1)],
        hist: [...downPrepend.map(() => null), ...p.hist.slice(b + 1)],
        flow: [...downPrepend.map(() => 0), ...p.flow.slice(b + 1)],
        inc: [...downPrepend.map(() => 1), ...p.inc.slice(b + 1)],
        incTick: [...downPrepend.map(() => w.tick), ...p.incTick.slice(b + 1)],
        head: { type: 'port', organId: o.id, port: 'out' },
        tail: p.tail,
        probed: p.probed,
      });
    }
    w.organs.set(o.id, o);
    reindex(w);
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
          inAccum: o.inAccum ? cloneParcel(o.inAccum) : null,
          outReady: o.outReady ? cloneParcel(o.outReady) : null,
          sideReady: o.sideReady ? cloneParcel(o.sideReady) : null,
        } satisfies Organ,
      ]),
    ),
    nextId: w.nextId,
    sources: w.sources,
    nodeHash: new NodeHash<Vein>(),
    histCount: 0,
  };
  reindex(snap);
  return snap;
}
