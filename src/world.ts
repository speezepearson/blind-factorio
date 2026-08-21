import {
  addInto, ambientLeak, cloneParcel, emptyParcel, exchangeHeat, radCount, reactParcel,
  sourceParcel, splitHalf, tempOf, totalParticles,
  CR, EPS, K_ALONG, SCALE,
} from './chem';
import type { Chemistry, Parcel } from './chem';
import {
  NodeHash, PORT_R, R_ERASE, R_ORGAN, R_SNAP, SEG, SRC_R, WORLD_H, WORLD_W,
  circlePts, dist, resample,
} from './geom';
import type { Pt } from './geom';

// The world is a continuous rectangle. Fluid lives in VEINS: freehand
// curves discretized into nodes SEG apart along their arc, one parcel per
// node, advecting node-to-node one hop per tick.
//
// INERT-PIPES BRANCH: parcels in transit are sealed sample vials — no
// reactions, no heat exchange (not with neighbors, not with crossing
// veins, not with ambient). Junctions still mix and forks still split;
// that's transport, not chemistry. All chemistry and all heat flow happen
// inside organ chambers.
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
// far — the radical filter — defined as chamber + channel DATA above
// organProcess().

export const HIST = 400; // rolling probe-history window, ticks
const HIST_CAP = 1600; // max nodes carrying passive history
export const GROW_TICKS = 10; // ticks for a budded organ to grow in
export const INC_PERIOD = 2; // ticks per node of ghost-vein incarnation

export type Head =
  | { type: 'open' }
  | { type: 'source'; spIdx: number }
  | { type: 'fork'; veinId: number; at: Pt }
  | { type: 'port'; organId: number; port: string }; // key of one of the organ's out ports
export type Tail =
  | { type: 'open' }
  | { type: 'merge'; veinId: number; at: Pt }
  | { type: 'organ-in'; organId: number; port: string }; // key of one of the organ's in ports

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

export type OrganKind = 'filter' | 'exchanger';

// A port is a hole in the membrane bound to one internal chamber: in-ports
// feed their chamber, out-ports offer theirs to be drunk whole by the
// attached vein each tick. Keys are stable identities ('in', 'out', 'side',
// 'fuel', 'hot-in', …) that attachments reference.
export interface OrganPort {
  key: string;
  dir: 'in' | 'out';
  chamber: string;
  pt: Pt;
}

export interface Organ {
  id: number;
  kind: OrganKind;
  c: Pt; // disc center
  r: number; // disc radius
  ports: OrganPort[];
  // An organ is chambers wired by permeability channels (the wiring is the
  // kind's spec — see ORGAN_SPECS); ALL chemistry and heat flow in the
  // world happens inside them. Null while growing.
  chambers: Record<string, Parcel> | null;
  // A freshly budded organ grows over GROW_TICKS ticks. While growing it
  // swallows its feed and emits nothing. Budding snips the host vein once,
  // locally, at the organ's center; the connected veins stay intact
  // (hidden under the opaque growing blob) until completion, when their
  // in-disc portions are trimmed back to the membrane and the ports attach
  // (the pending trims record which vein end lands on which port).
  growth: number; // ticks grown; >= GROW_TICKS = fully incarnate
  pending: { trims: Array<{ veinId: number; end: 'head' | 'tail'; port: string }> } | null;
  load: number; // smoothed input radicals/tick (drives the heartbeat pulse)
  // consecutive ticks the fuel chamber has sat below ATROPHY_MIN; at
  // ATROPHY_TICKS the organ dissolves and the pipes rejoin (atrophy)
  starve: number;
  // view-only vent trackers by out-port key: what an unattached port is
  // spraying into the cavity (smoothed rate + last composition), for haze
  vents: Record<string, { rate: number; c: Int32Array }>;
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
  // organogenesis dwell clocks: junction-site key -> ticks its trigger
  // conditions have held (transient; not serialized)
  spawnDwell: Map<string, number>;
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
    spawnDwell: new Map(),
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

// What part of an organ (if any) covers this point — ports win over body
// (port: null = the body). A growing organ's ports aren't drawn yet, so
// they aren't clickable yet either: only the body blob exists.
export function organAt(w: World, pt: Pt): { organ: Organ; port: OrganPort | null } | null {
  for (const o of w.organs.values()) {
    if (!organGrown(o)) continue;
    for (const port of o.ports) {
      if (dist(port.pt, pt) <= PORT_R) return { organ: o, port };
    }
  }
  for (const o of w.organs.values()) {
    if (dist(o.c, pt) <= o.r) return { organ: o, port: null };
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

  // 0) INCARNATION — ghost veins grow real where they touch live network
  if (w.tick % INC_PERIOD === 0) growthStep(w);

  // 1+2) PIPES ARE INERT. No reactions, no conduction, no ambient leak —
  // a parcel in transit is a sealed sample vial: its composition and heat
  // are exactly what its origin gave it (junctions still mix and forks
  // still split — that's transport, not chemistry). All chemistry and all
  // heat flow happens inside organ chambers, in organProcess().

  // 3) ADVECTION — veins have infinite throughput: everything advances one
  // node every tick, nothing ever queues. Fluid that runs out of vein
  // vents into the cavity; every vent is structurally visible — an open
  // tail, the frontier of a still-incarnating ghost, a growing organ's
  // mouth — so mass-balance inference stays honest.
  const headIn = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && p.inc[0]) {
      const seg = resolveAttach(w, p.head, { selfId: p.id, end: 'head' });
      if (seg && seg.vein.inc[seg.idx]) headIn.set(p.id, splitHalf(chem, seg.vein.parcels[seg.idx]));
    }
  }
  const tailOut = new Map<number, Parcel>();
  const inFlux = new Map<number, number>(); // radicals delivered per organ this tick (load pulse)
  for (const p of w.veins.values()) {
    const n = p.pts.length;
    if (p.inc[n - 1]) tailOut.set(p.id, p.parcels[n - 1]);
    let fill: Parcel | null = null;
    if (p.inc[0]) {
      if (p.head.type === 'source') {
        // the full-spectrum species is fuel, and its wellhead only trickles
        const frac = chem.radcount[p.head.spIdx] === chem.radicals.length ? FUEL_SOURCE_FRAC : 1;
        fill = sourceParcel(chem, p.head.spIdx, frac);
      } else if (p.head.type === 'fork') fill = headIn.get(p.id) ?? null;
      else if (p.head.type === 'port') {
        const o = w.organs.get(p.head.organId);
        // the vein drinks the whole staging chamber; a fresh parcel is
        // born here and the chamber's ledgers zero (organs create parcels)
        const port = o?.ports.find((q) => q.key === (p.head as { port: string }).port);
        const ch = port && o?.chambers ? o.chambers[port.chamber] : undefined;
        if (ch && (totalParticles(chem, ch.c) > 0 || ch.U > 0)) {
          fill = cloneParcel(ch);
          ch.c.fill(0);
          ch.U = 0;
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
      const seg = resolveAttach(w, p.tail, { selfId: p.id, end: 'tail' });
      // a merge target still ghost = the junction isn't built yet: vents
      if (seg && seg.vein.inc[seg.idx]) addInto(chem, seg.vein.parcels[seg.idx], out);
    } else if (p.tail.type === 'organ-in') {
      const o = w.organs.get(p.tail.organId);
      // a growing organ swallows its feed (it's building itself with it);
      // a grown one takes it into the port's chamber (input parcels die here)
      const port = o?.ports.find((q) => q.key === (p.tail as { port: string }).port);
      if (o?.chambers && port) {
        addInto(chem, o.chambers[port.chamber], out);
        inFlux.set(o.id, (inFlux.get(o.id) ?? 0) + radCount(chem, out.c));
      }
    }
    // open tails vent (discarded)
  }
  // organs: growing ones just grow; on completion the two host halves are
  // trimmed back to the membrane (their in-disc portions have been hidden
  // under the opaque blob since budding) and the ports attach
  for (const o of w.organs.values()) {
    if (!organGrown(o)) {
      o.growth++;
      if (organGrown(o)) completeBud(w, o);
      continue;
    }
    organProcess(w, o, inFlux.get(o.id) ?? 0);
  }

  // 3.5) ORGANOGENESIS — junctions whose streams hold a trigger long
  // enough bud their organ spontaneously
  if (w.tick % SPAWN_PERIOD === 0) spawnStep(w);

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

// slice a vein down to pts[s..e], dropping (and accounting) trimmed hists
function trimVein(w: World, p: Vein, s: number, e: number): void {
  for (let i = 0; i < p.pts.length; i++) {
    if ((i < s || i > e) && p.hist[i]) w.histCount--;
  }
  p.pts = p.pts.slice(s, e + 1);
  p.parcels = p.parcels.slice(s, e + 1);
  p.hist = p.hist.slice(s, e + 1);
  p.flow = p.flow.slice(s, e + 1);
  p.inc = p.inc.slice(s, e + 1);
  p.incTick = p.incTick.slice(s, e + 1);
}

function deleteVein(w: World, p: Vein): void {
  for (const h of p.hist) if (h) w.histCount--;
  w.veins.delete(p.id);
}

// Snip a vein in two at node m (nudged so no 1-node orphan is stranded):
// the upstream part keeps the vein's id (anchors on it keep resolving), the
// downstream part becomes a new open-headed vein inheriting the old tail.
// Returns the downstream vein's id, or null if there wasn't enough left to
// make one. The caller re-points the upstream tail and reindexes. Used by
// both bud paths (manual and junction) — the cut both organs grow over.
function snipVeinAt(w: World, p: Vein, m: number): number | null {
  if (p.pts.length - m - 1 === 1) m++; // never strand a 1-node orphan
  const bPts = p.pts.slice(m + 1);
  let downId: number | null = null;
  if (bPts.length >= 2) {
    const B: Vein = {
      id: w.nextId++,
      pts: bPts,
      parcels: p.parcels.slice(m + 1),
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
  p.hist = p.hist.slice(0, m + 1);
  p.flow = p.flow.slice(0, m + 1);
  p.inc = p.inc.slice(0, m + 1);
  p.incTick = p.incTick.slice(0, m + 1);
  return downId;
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
  const hist = stub.map(() => null);
  const flow = stub.map(() => 0);
  const inc = stub.map(() => 1);
  const incTick = stub.map(() => w.tick);
  if (end === 'head') {
    p.pts = [...pts, ...p.pts];
    p.parcels = [...parcels, ...p.parcels];
    p.hist = [...hist, ...p.hist];
    p.flow = [...flow, ...p.flow];
    p.inc = [...inc, ...p.inc];
    p.incTick = [...incTick, ...p.incTick];
  } else {
    p.pts = [...p.pts, ...pts];
    p.parcels = [...p.parcels, ...parcels];
    p.hist = [...p.hist, ...hist];
    p.flow = [...p.flow, ...flow];
    p.inc = [...p.inc, ...inc];
    p.incTick = [...p.incTick, ...incTick];
  }
}

// The completion trim: when a budded organ finishes growing, every vein
// still connected to it (snipped or retargeted at bud time, hidden under
// the opaque blob since) is cut back to the membrane and its end attaches
// to its assigned port. Each survivor is then extended to end exactly ON
// its port point, so the drawn vein meets the membrane instead of
// stopping a node short.
function completeBud(w: World, o: Organ): void {
  if (!o.pending) return;
  const trims = o.pending.trims;
  o.pending = null;
  const inDisc = (pt: Pt) => dist(pt, o.c) <= o.r;
  for (const tr of trims) {
    const v = w.veins.get(tr.veinId);
    const port = o.ports.find((q) => q.key === tr.port);
    if (!v || !port) continue;
    if (tr.end === 'tail') {
      // flows INTO the organ: cut the tail back to the membrane
      let e = v.pts.length - 1;
      while (e >= 0 && inDisc(v.pts[e])) e--;
      if (e + 1 >= 2) {
        trimVein(w, v, 0, e);
        v.tail = { type: 'organ-in', organId: o.id, port: tr.port };
        bridgeToPoint(w, v, 'tail', port.pt);
      } else deleteVein(w, v); // fully swallowed
    } else {
      // flows OUT of the organ: cut the head back to the membrane
      let s = 0;
      while (s < v.pts.length && inDisc(v.pts[s])) s++;
      if (v.pts.length - s >= 2) {
        trimVein(w, v, s, v.pts.length - 1);
        v.head = { type: 'port', organId: o.id, port: tr.port };
        bridgeToPoint(w, v, 'head', port.pt);
      } else deleteVein(w, v);
    }
  }
  o.chambers = makeChambers(w.chem, o.kind); // the chambers open for business
  reindex(w);
  healAttachments(w);
}

// ---- organs as chambers + channels ----------------------------------------
// An organ is DATA: chambers, and channels between them with per-species
// permeability (the fraction of a chamber's stock that crosses per tick —
// deterministic: mean of the binomial, rounded, no sampling). Heat rides
// each crossing in proportion to the radicals it carries. Since pipes are
// inert, the chambers are the only places in the world where reactions run
// and heat moves — "organs contain the catalysts." Which chambers hold
// catalysts is part of the spec (`react`): a heat exchanger's stream
// chambers move heat but run no chemistry.
//
// Fuel: every organ has a `fuel` chamber fed RGB through its fuel port.
// The RGB smolders there by ordinary chemistry (energy-storing bonds crack
// where it's warm), its heat conducts to the working chambers, and the
// cracked singles drain into the process stream. A newly grown organ is
// endowed with a yolk of fuel; when the chamber runs dry the organ
// starves, and after ATROPHY_TICKS it dissolves and the pipes rejoin.

interface OrganChannel {
  from: string;
  to: string;
  perm: (chem: Chemistry, s: number) => number;
}
interface OrganSpec {
  label: string[]; // god-mode label lines
  chambers: string[];
  react: string[]; // chambers that hold catalysts (reactions run there)
  // NOTE: channel list ORDER is semantic — channels run sequentially, so a
  // chamber drained before it receives moves fluid at most one hop per
  // tick, while one drained after can cascade (the exchanger's conveyor
  // files depend on last-stage-first ordering)
  channels: OrganChannel[];
  heat: Array<[string, string, number]>; // conducting chamber pairs
  leak: string[]; // chambers that leak heat to ambient (the rest are insulated)
  ports: Array<{ key: string; dir: 'in' | 'out'; chamber: string }>; // canonical port set
  yolk: number; // fuel particles a newly grown organ starts with
}

const isFuel = (chem: Chemistry, s: number) => chem.radcount[s] === chem.radicals.length;
const FUEL_SOURCE_FRAC = 0.05; // fuel wellheads trickle at this fraction of SCALE
const FUEL_YOLK = 20000;
const ATROPHY_MIN = 100; // fuel particles: below this the organ is starving
// Atrophy is as snappy as organogenesis: the reservoir itself is the buffer
// (a supply interruption only bites after the stock burns down), so the
// dwell just rides out flickers. An organ whose fuel is gone is gone.
const ATROPHY_TICKS = 3;
// fuel-chamber drains: cracked products join the process stream briskly;
// unburned fuel only seeps (the reservoir holds it) — slower than a warm
// chamber burns, so a working organ consumes its fuel rather than wasting
// it, while an oversupplied reservoir still tops out instead of growing
// without bound
const P_FUEL_FEED = 0.15;
const P_FUEL_SEEP = 0.005;
const fuelDrain = (chem: Chemistry, s: number) => (isFuel(chem, s) ? P_FUEL_SEEP : P_FUEL_FEED);

// The radical filter: free radicals permeate readily into the side
// chamber, composites into the out chamber, each with only a trace leak
// the other way. Fed unreacted singles, its inlet chamber is also where
// they fuse — so the out stream's compound flux is set by the fusion rate
// during the inlet's residence time (drain permeabilities tune this; the
// values below give a pure 1:1 R+G feed about a 50/50 radical split
// between the two ports). Singles drain to side slowly enough that
// roughly half of a 1:1 R+G feed fuses during its inlet residence
// (fusion ≈ 0.08/tick per single at these stocks); compounds drain to
// out fast so they don't crack back.
const P_SIDE_SINGLE = 0.08;
const P_OUT_COMPOUND = 0.5;
const P_LEAK = 0.005;

// The heat exchanger: two files of chambers carrying the two streams in
// opposite directions, heat-conducting pairwise crosswise (counter-current:
// the hottest incoming pairs with the warmest outgoing). Its stream
// chambers hold NO catalysts — fluid changes temperature, never species.
// 7 stages per file, but the terminal ones are vestibules, not exchangers:
// the entry chamber forwards its fluid the same tick it fills, and the
// exit chamber is drunk empty by the port vein during advection — both
// stand empty when the heat pairs run. 7 stages = 5 live counter-current
// pairs (and 15 chambers with the fuel reservoir: "around a dozen").
const XCHG_STAGES = 7;
// full turnover, one stage per tick: with the channels ordered LAST STAGE
// FIRST (channels run in spec order, so draining a chamber before it
// receives keeps fluid from cascading several stages in one tick), each
// file is a strict conveyor — every parcel of stream spends exactly one
// tick in each stage
const P_XCHG_FLOW = 1.0;
// and each cross pair EQUALIZES every tick (κ=1 is exact in exchangeHeat,
// not an overshoot): conveyor staging + per-stage equilibration is the
// ideal staged counter-current exchanger, effectiveness N/(N+1)
const K_XCHG = 1.0;

function exchangerSpec(): OrganSpec {
  const h = Array.from({ length: XCHG_STAGES }, (_, i) => `h${i}`);
  const k = Array.from({ length: XCHG_STAGES }, (_, i) => `k${i}`);
  const flow = (names: string[]): OrganChannel[] =>
    names
      .slice(0, -1)
      .map((from, i) => ({ from, to: names[i + 1], perm: () => P_XCHG_FLOW }))
      .reverse();
  return {
    label: ['HEAT', 'EXCHANGER'],
    chambers: [...h, ...k, 'fuel'],
    react: ['fuel'],
    channels: [...flow(h), ...flow(k), { from: 'fuel', to: 'h0', perm: fuelDrain }],
    // cross pairs ONLY: the fuel reservoir must not touch the stream files
    // thermally — a big cold fuel stock would otherwise refrigerate h0 and
    // eat the very gradient the organ exists to preserve (its exhaust
    // matter still drains into the h file, heat riding along)
    heat: h.map((name, i) => [name, k[XCHG_STAGES - 1 - i], K_XCHG] as [string, string, number]),
    // the stream files are insulated — an exchanger's whole job is keeping
    // the gradient between its two flows, not sharing it with the cavity
    leak: ['fuel'],
    ports: [
      { key: 'hot-in', dir: 'in', chamber: 'h0' },
      { key: 'cold-in', dir: 'in', chamber: 'k0' },
      { key: 'fuel', dir: 'in', chamber: 'fuel' },
      { key: 'cold-out', dir: 'out', chamber: `h${XCHG_STAGES - 1}` }, // the cooled hot stream
      { key: 'hot-out', dir: 'out', chamber: `k${XCHG_STAGES - 1}` }, // the heated cold stream
    ],
    yolk: FUEL_YOLK,
  };
}

export const ORGAN_SPECS: Record<OrganKind, OrganSpec> = {
  filter: {
    label: ['RADICAL', 'FILTER'],
    chambers: ['inlet', 'out', 'side', 'fuel'],
    react: ['inlet', 'out', 'side', 'fuel'],
    channels: [
      { from: 'inlet', to: 'side', perm: (chem, s) => (chem.radcount[s] === 1 ? P_SIDE_SINGLE : P_LEAK) },
      { from: 'inlet', to: 'out', perm: (chem, s) => (chem.radcount[s] === 1 ? P_LEAK : P_OUT_COMPOUND) },
      { from: 'fuel', to: 'inlet', perm: fuelDrain },
    ],
    heat: [
      ['fuel', 'inlet', K_ALONG],
      ['inlet', 'out', K_ALONG],
      ['inlet', 'side', K_ALONG],
      ['out', 'side', K_ALONG],
    ],
    leak: ['inlet', 'out', 'side', 'fuel'],
    ports: [
      { key: 'in', dir: 'in', chamber: 'inlet' },
      { key: 'fuel', dir: 'in', chamber: 'fuel' },
      { key: 'out', dir: 'out', chamber: 'out' },
      { key: 'side', dir: 'out', chamber: 'side' },
    ],
    yolk: FUEL_YOLK,
  },
  exchanger: exchangerSpec(),
};

export function makeChambers(chem: Chemistry, kind: OrganKind): NonNullable<Organ['chambers']> {
  const spec = ORGAN_SPECS[kind];
  const chambers: Record<string, Parcel> = {};
  for (const name of spec.chambers) chambers[name] = emptyParcel(chem);
  // the yolk: a newly grown organ carries its own fuel endowment (budding
  // consumes chemicals; this is where some of them went)
  const fuelIdx = chem.radcount.indexOf(chem.radicals.length);
  if (spec.yolk > 0 && fuelIdx >= 0 && chambers.fuel) {
    chambers.fuel.c[fuelIdx] = spec.yolk;
    chambers.fuel.U = Math.round((CR * spec.yolk * chem.radcount[fuelIdx] * chem.ambient) / EPS);
  }
  return chambers;
}

function organProcess(w: World, o: Organ, inputRad: number): void {
  const chem = w.chem;
  if (!o.chambers) return;
  const spec = ORGAN_SPECS[o.kind];
  const ch = o.chambers;
  // out chambers still holding fluid were not consumed by a live vein this
  // tick: the port vents into the cavity — note it for the haze, then drop
  for (const port of o.ports) {
    if (port.dir !== 'out') continue;
    const slot = ch[port.chamber];
    const prev = o.vents[port.key];
    if (totalParticles(chem, slot.c) > 0) {
      o.vents[port.key] = { rate: (prev?.rate ?? 0) * 0.9 + radCount(chem, slot.c) * 0.1, c: new Int32Array(slot.c) };
      slot.c.fill(0);
      slot.U = 0;
    } else if (prev && prev.rate * 0.9 > 20) {
      o.vents[port.key] = { rate: prev.rate * 0.9, c: prev.c };
    } else if (prev) {
      delete o.vents[port.key];
    }
  }
  o.load = o.load * 0.9 + inputRad * 0.1;
  // channels: deterministic permeability flow, heat riding proportionally
  for (const c of spec.channels) {
    const from = ch[c.from];
    const to = ch[c.to];
    const fromRad = radCount(chem, from.c);
    if (fromRad === 0) continue;
    let moved = 0;
    for (let s = 0; s < chem.nsp; s++) {
      const k = Math.round(c.perm(chem, s) * from.c[s]);
      if (k === 0) continue;
      from.c[s] -= k;
      to.c[s] += k;
      moved += k * chem.radcount[s];
    }
    if (moved > 0 && from.U > 0) {
      const q = Math.min(from.U, Math.round((from.U * moved) / fromRad));
      from.U -= q;
      to.U += q;
    }
  }
  // the world's only chemistry and heat flow: chamber reactions (where the
  // spec puts catalysts), chamber-to-chamber conduction, and ambient leak
  // through the organ's membrane
  for (const name of spec.react) reactParcel(chem, ch[name]);
  for (const [x, y, k] of spec.heat) exchangeHeat(chem, ch[x], ch[y], k);
  for (const name of spec.leak) ambientLeak(chem, ch[name]);
  // starvation: a dry fuel chamber, held long enough, dissolves the organ
  const fuelIdx = chem.radcount.indexOf(chem.radicals.length);
  if (ch.fuel && fuelIdx >= 0) {
    o.starve = ch.fuel.c[fuelIdx] < ATROPHY_MIN ? o.starve + 1 : 0;
    if (o.starve >= ATROPHY_TICKS) atrophy(w, o);
  }
}

// Atrophy: the organ dissolves and the pipes simply rejoin — every input
// merges at the old center, every output forks back out of it (the main
// in/out pair fuse into one vein through the middle; the rest attach as
// ordinary junctions). The chambers' remaining contents dissolve into the
// flow at the wound; the reconnecting stubs are ghosts and incarnate from
// the live ends, so the scar heals over a few ticks.
function atrophy(w: World, o: Organ): void {
  const ins: Vein[] = [];
  const outs: Vein[] = [];
  for (const v of w.veins.values()) {
    if (v.tail.type === 'organ-in' && v.tail.organId === o.id) ins.push(v);
    if (v.head.type === 'port' && v.head.organId === o.id) outs.push(v);
  }
  w.organs.delete(o.id);
  const mainIn =
    ins.find((v) => v.tail.type === 'organ-in' && (v.tail.port === 'in' || v.tail.port === 'hot-in')) ?? ins[0];
  const mainOut =
    outs.find((v) => v.head.type === 'port' && (v.head.port === 'out' || v.head.port === 'hot-out')) ?? outs[0];
  // whatever the chambers still held rides out with the flow
  if (o.chambers && mainIn) {
    const wound = mainIn.parcels[mainIn.parcels.length - 1];
    for (const p of Object.values(o.chambers)) addInto(w.chem, wound, p);
  }
  if (mainIn && mainOut) {
    const tailPt = mainIn.pts[mainIn.pts.length - 1];
    const headPt = mainOut.pts[0];
    const bridge = resample([tailPt, [o.c[0], o.c[1]], headPt], SEG).filter(
      (q) => dist(q, tailPt) > 4 && dist(q, headPt) > 4,
    );
    uniteVeins(w, mainIn, bridge, mainOut);
    // the junction node the survivors attach to: the united vein's node
    // nearest the old center
    const node = mainIn.pts.reduce((best, pt) => (dist(pt, o.c) < dist(best, o.c) ? pt : best));
    for (const v of ins) {
      if (v === mainIn) continue;
      const end = v.pts[v.pts.length - 1];
      const stub = resample([end, node], SEG).filter((q) => dist(q, end) > 4);
      extendVeinTail(w, v, stub, { type: 'merge', veinId: mainIn.id, at: [node[0], node[1]] });
    }
    for (const v of outs) {
      if (v === mainOut) continue;
      const start = v.pts[0];
      const stub = resample([node, start], SEG).filter((q) => dist(q, start) > 4);
      extendVeinHead(w, v, stub, { type: 'fork', veinId: mainIn.id, at: [node[0], node[1]] });
    }
  } else {
    // nothing to rejoin: the survivors just open at the membrane
    for (const v of ins) v.tail = { type: 'open' };
    for (const v of outs) v.head = { type: 'open' };
  }
  reindex(w);
  healAttachments(w);
}

// ---- spontaneous organogenesis --------------------------------------------
// Organs are not placed; they GROW where the chemistry says so. Every
// SPAWN_PERIOD ticks the network's junctions are read. A junction is a
// cluster of attachments (merges in, forks out) on a host vein, close
// enough together that one organ disc could swallow them, counted along
// with the host's own through-flow. When a junction's input streams have
// held an organ kind's trigger for SPAWN_DWELL ticks, the organ buds
// there: the disc eats the junction, every vein end lands on a port
// chosen by its role, and growth proceeds exactly like a manual bud.
//
// Triggers (fractions are of particles, sensed over the trailing
// SENSE_NODES occupied parcels approaching the junction):
//   filter     2-in 2-out: one input >40% R, >30% G, <1% RGB (the mix);
//              the other input >1% RGB (the fuel).
//   exchanger  3-in 2-out: exactly one input >1% RGB (the fuel); of the
//              other two, one runs >0.3 temperature units hotter.
// Output roles are geometric, walking the rim from the named input
// (screen y points down, so "clockwise" visually = increasing atan2):
//   filter     main out = first output clockwise from the fuel input,
//              side = the other way.
//   exchanger  hot-out = first output counter-clockwise from the hot
//              input, cold-out = the other way.

// Organogenesis is nearly immediate — the game runs well below 60 Hz, and a
// long dwell would blur the cause-and-effect between "add RGB" and "an organ
// grows". Since every trigger requires fuel, the player's control is exactly
// that: only route RGB to a junction when you're ready for it to become an
// organ. The 3-tick hold just rides out single-parcel flickers.
const SPAWN_PERIOD = 1; // ticks between junction scans
const SPAWN_DWELL = 3; // ticks a trigger must hold before budding
const SENSE_NODES = 8; // trailing parcels sampled per input stream
const R_CLUSTER = 40; // attachments this close along a host share one junction

interface JunctionArm {
  vein: Vein;
  kind: 'merge' | 'fork';
  idx: number; // host node the attachment resolves to
}
interface Sense {
  frac: Float64Array; // particle fraction per species
  total: number;
  temp: number;
}

function senseStream(chem: Chemistry, v: Vein, start: number, step: -1 | 1): Sense | null {
  const frac = new Float64Array(chem.nsp);
  let total = 0;
  let U = 0;
  let rads = 0;
  for (let i = start, taken = 0; i >= 0 && i < v.pts.length && taken < SENSE_NODES; i += step, taken++) {
    if (!v.inc[i]) break;
    const pc = v.parcels[i];
    if (totalParticles(chem, pc.c) === 0) continue;
    for (let s = 0; s < chem.nsp; s++) {
      frac[s] += pc.c[s];
      total += pc.c[s];
    }
    U += pc.U;
    rads += radCount(chem, pc.c);
  }
  if (total < SCALE * 0.2) return null; // not a sustained stream
  for (let s = 0; s < chem.nsp; s++) frac[s] /= total;
  return { frac, total, temp: rads > 0 ? (U * EPS) / (CR * rads) : chem.ambient };
}

type SpawnRoles = { fuel: number; mix?: number; hot?: number; cold?: number }; // indices into inputs

function spawnStep(w: World): void {
  const chem = w.chem;
  const fuelIdx = chem.radcount.indexOf(chem.radicals.length);
  const rIdx = chem.speciesIndex('R');
  const gIdx = chem.speciesIndex('G');
  if (fuelIdx < 0) return;
  // every attachment, grouped by the host vein it resolves onto
  const perHost = new Map<number, JunctionArm[]>();
  for (const q of w.veins.values()) {
    const add = (kind: 'merge' | 'fork', att: { veinId: number; at: Pt }, end: 'head' | 'tail') => {
      const seg = resolveAttach(w, att, { selfId: q.id, end });
      if (!seg) return;
      const list = perHost.get(seg.vein.id) ?? [];
      list.push({ vein: q, kind, idx: seg.idx });
      perHost.set(seg.vein.id, list);
    };
    if (q.head.type === 'fork') add('fork', q.head, 'head');
    if (q.tail.type === 'merge') add('merge', q.tail, 'tail');
  }
  const holding = new Set<string>();
  let spawned = false;
  for (const [hostId, arms] of perHost) {
    if (spawned) break;
    const host = w.veins.get(hostId);
    if (!host) continue;
    arms.sort((x, y) => x.idx - y.idx);
    const clusters: JunctionArm[][] = [];
    let cl: JunctionArm[] = [];
    for (const arm of arms) {
      if (cl.length > 0 && dist(host.pts[cl[0].idx], host.pts[arm.idx]) > R_CLUSTER) {
        clusters.push(cl);
        cl = [];
      }
      cl.push(arm);
    }
    if (cl.length > 0) clusters.push(cl);
    for (const cluster of clusters) {
      const merges = cluster.filter((x) => x.kind === 'merge');
      const forks = cluster.filter((x) => x.kind === 'fork');
      const kind: OrganKind | null =
        merges.length === 1 && forks.length === 1
          ? 'filter'
          : merges.length === 2 && forks.length === 1
            ? 'exchanger'
            : null;
      if (!kind) continue;
      const centerIdx = Math.round(cluster.reduce((s, x) => s + x.idx, 0) / cluster.length);
      const center = host.pts[centerIdx];
      // input streams: the host upstream of the cluster, then each merge
      const hostSense = senseStream(chem, host, Math.min(...cluster.map((x) => x.idx)) - 1, -1);
      if (!hostSense) continue;
      const senses: Sense[] = [hostSense];
      let sensed = true;
      for (const m of merges) {
        const s = senseStream(chem, m.vein, m.vein.pts.length - 1, -1);
        if (!s) {
          sensed = false;
          break;
        }
        senses.push(s);
      }
      if (!sensed) continue;
      const fueled = senses.map((_, i) => i).filter((i) => senses[i].frac[fuelIdx] > 0.01);
      let roles: SpawnRoles | null = null;
      if (kind === 'filter') {
        const fi = fueled[0];
        const mi = senses.findIndex(
          (s, i) => i !== fi && s.frac[rIdx] > 0.4 && s.frac[gIdx] > 0.3 && s.frac[fuelIdx] < 0.01,
        );
        if (fueled.length >= 1 && fi !== undefined && mi >= 0) roles = { fuel: fi, mix: mi };
      } else if (fueled.length === 1) {
        const rest = [0, 1, 2].filter((i) => i !== fueled[0]);
        const dT = senses[rest[0]].temp - senses[rest[1]].temp;
        if (Math.abs(dT) > 0.3) {
          roles = { fuel: fueled[0], hot: dT > 0 ? rest[0] : rest[1], cold: dT > 0 ? rest[1] : rest[0] };
        }
      }
      if (!roles) continue;
      const key = `${Math.round(center[0] / 8)},${Math.round(center[1] / 8)}:${kind}`;
      holding.add(key);
      const dwell = (w.spawnDwell.get(key) ?? 0) + SPAWN_PERIOD;
      w.spawnDwell.set(key, dwell);
      if (dwell >= SPAWN_DWELL && spawnOrganAtJunction(w, host, centerIdx, kind, cluster, roles)) {
        w.spawnDwell.delete(key);
        spawned = true; // the network just changed under us: one bud per scan
        break;
      }
    }
  }
  // sites whose trigger lapsed cool off twice as fast as they warmed
  for (const [key, v] of [...w.spawnDwell]) {
    if (holding.has(key)) continue;
    const nv = v - SPAWN_PERIOD * 2;
    if (nv <= 0) w.spawnDwell.delete(key);
    else w.spawnDwell.set(key, nv);
  }
}

// The junction bud: validate the site the way tryBud does, assign every
// vein end to a port by its role, snip the host at the center, and let
// ordinary growth + completeBud do the rest. Returns false (leaving the
// dwell clock at threshold, to retry) if the site can't legally hold an
// organ.
function spawnOrganAtJunction(
  w: World,
  host: Vein,
  centerIdx: number,
  kind: OrganKind,
  cluster: JunctionArm[],
  roles: SpawnRoles,
): boolean {
  const center = host.pts[centerIdx];
  if (
    center[0] - R_ORGAN < 0 || center[1] - R_ORGAN < 0 ||
    center[0] + R_ORGAN >= WORLD_W || center[1] + R_ORGAN >= WORLD_H
  ) return false;
  const inDisc = (pt: Pt) => dist(pt, center) <= R_ORGAN;
  const n = host.pts.length;
  let a = centerIdx;
  while (a - 1 >= 0 && inDisc(host.pts[a - 1])) a--;
  let b = centerIdx;
  while (b + 1 < n && inDisc(host.pts[b + 1])) b++;
  // the host must flow through with ≥2 nodes to spare on both sides
  if (a < 2 || n - 1 - b < 2) return false;
  if (!host.inc.slice(a, b + 1).every((v) => v === 1)) return false;
  // arm membranes: each merge needs ≥2 nodes outside the disc before its
  // tail, each fork ≥2 after its head; note where each crosses the wall
  const membrane = new Map<number, Pt>(); // arm vein id -> crossing node
  for (const arm of cluster) {
    const v = arm.vein;
    if (arm.kind === 'merge') {
      let e = v.pts.length - 1;
      while (e >= 0 && inDisc(v.pts[e])) e--;
      if (e < 1 || e === v.pts.length - 1) return false;
      if (!v.inc.slice(e + 1).every((q) => q === 1)) return false;
      membrane.set(v.id, v.pts[e + 1]);
    } else {
      let s = 0;
      while (s < v.pts.length && inDisc(v.pts[s])) s++;
      if (s === 0 || v.pts.length - s < 2) return false;
      if (!v.inc.slice(0, s).every((q) => q === 1)) return false;
      membrane.set(v.id, v.pts[s - 1]);
    }
  }
  // no third-party junctions on the doomed stretch — neither on the host's
  // [a..b] nor on any arm's in-disc portion (they'd dangle into the cavity)
  const doomed = (vein: Vein, idx: number): boolean => {
    if (vein.id === host.id) return idx >= a && idx <= b;
    if (cluster.some((x) => x.vein.id === vein.id)) return inDisc(vein.pts[idx]);
    return false;
  };
  for (const q of w.veins.values()) {
    if (cluster.some((x) => x.vein.id === q.id)) continue;
    const checks: Array<{ att: { veinId: number; at: Pt }; end: 'head' | 'tail' }> = [];
    if (q.head.type === 'fork') checks.push({ att: q.head, end: 'head' });
    if (q.tail.type === 'merge') checks.push({ att: q.tail, end: 'tail' });
    for (const { att, end } of checks) {
      const seg = resolveAttach(w, att, { selfId: q.id, end });
      if (seg && doomed(seg.vein, seg.idx)) return false;
    }
  }
  // the disc must clear other organs and sources
  for (const o2 of w.organs.values()) if (dist(o2.c, center) < R_ORGAN + o2.r + 6) return false;
  for (const s of w.sources) if (dist(s.pt, center) < R_ORGAN + SRC_R + 6) return false;

  // ---- role -> port assignment ----
  const merges = cluster.filter((x) => x.kind === 'merge');
  const forks = cluster.filter((x) => x.kind === 'fork');
  // inputs indexed as in spawnStep: 0 = host upstream, then the merges
  const inPts: Pt[] = [host.pts[a], ...merges.map((m) => membrane.get(m.vein.id)!)];
  const outPts: Pt[] = [host.pts[b], ...forks.map((f) => membrane.get(f.vein.id)!)];
  const theta = (pt: Pt) => Math.atan2(pt[1] - center[1], pt[0] - center[0]);
  const TAU = Math.PI * 2;
  const inKeys = new Array<string>(inPts.length);
  const outKeys = new Array<string>(outPts.length);
  if (kind === 'filter') {
    inKeys[roles.mix!] = 'in';
    inKeys[roles.fuel] = 'fuel';
    const cw0 = (theta(outPts[0]) - theta(inPts[roles.fuel]) + TAU) % TAU;
    const cw1 = (theta(outPts[1]) - theta(inPts[roles.fuel]) + TAU) % TAU;
    outKeys[cw0 <= cw1 ? 0 : 1] = 'out';
    outKeys[cw0 <= cw1 ? 1 : 0] = 'side';
  } else {
    inKeys[roles.hot!] = 'hot-in';
    inKeys[roles.cold!] = 'cold-in';
    inKeys[roles.fuel] = 'fuel';
    const ccw0 = (theta(inPts[roles.hot!]) - theta(outPts[0]) + TAU) % TAU;
    const ccw1 = (theta(inPts[roles.hot!]) - theta(outPts[1]) + TAU) % TAU;
    outKeys[ccw0 <= ccw1 ? 0 : 1] = 'hot-out';
    outKeys[ccw0 <= ccw1 ? 1 : 0] = 'cold-out';
  }
  const chamberOf = (key: string) => ORGAN_SPECS[kind].ports.find((p) => p.key === key)!.chamber;
  const o: Organ = {
    id: w.nextId++,
    kind,
    c: [center[0], center[1]],
    r: R_ORGAN,
    ports: [
      ...inKeys.map((key, i) => ({ key, dir: 'in' as const, chamber: chamberOf(key), pt: [inPts[i][0], inPts[i][1]] as Pt })),
      ...outKeys.map((key, i) => ({ key, dir: 'out' as const, chamber: chamberOf(key), pt: [outPts[i][0], outPts[i][1]] as Pt })),
    ],
    chambers: null,
    growth: 0,
    pending: null,
    load: 0,
    starve: 0,
    vents: {},
  };

  // ---- eat the junction: snip the host at the center (as tryBud does),
  // retarget the merges to their in-ports, queue everyone's membrane trim
  const downId = snipVeinAt(w, host, centerIdx);
  host.tail = { type: 'organ-in', organId: o.id, port: inKeys[0] };
  const trims: NonNullable<Organ['pending']>['trims'] = [{ veinId: host.id, end: 'tail', port: inKeys[0] }];
  if (downId !== null) trims.push({ veinId: downId, end: 'head', port: outKeys[0] });
  merges.forEach((arm, i) => {
    arm.vein.tail = { type: 'organ-in', organId: o.id, port: inKeys[i + 1] };
    trims.push({ veinId: arm.vein.id, end: 'tail', port: inKeys[i + 1] });
  });
  forks.forEach((arm, i) => {
    trims.push({ veinId: arm.vein.id, end: 'head', port: outKeys[i + 1] });
  });
  o.pending = { trims };
  w.organs.set(o.id, o);
  reindex(w);
  return true;
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
    if (hit(o.c, R_ERASE + o.r) || o.ports.some((port) => hit(port.pt, R_ERASE))) {
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
  for (let i = i0; i <= i1 && i < n; i++) if (p.hist[i]) w.histCount--;
  const frag = (s: number, e: number, head: Head, tail: Tail) => {
    if (e - s + 1 < 2) {
      for (let i = s; i <= e; i++) if (p.hist[i]) w.histCount--;
      return;
    }
    const f: Vein = {
      id: w.nextId++,
      pts: p.pts.slice(s, e + 1),
      parcels: p.parcels.slice(s, e + 1),
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
    const portFuel = rimPick([portIn, portOut, portSide]);

    const instant = opts?.instant ?? false;
    const o: Organ = {
      id: w.nextId++,
      kind: 'filter',
      c: [center[0], center[1]],
      r: R_ORGAN,
      ports: [
        { key: 'in', dir: 'in', chamber: 'inlet', pt: portIn },
        { key: 'fuel', dir: 'in', chamber: 'fuel', pt: portFuel },
        { key: 'out', dir: 'out', chamber: 'out', pt: portOut },
        { key: 'side', dir: 'out', chamber: 'side', pt: portSide },
      ],
      chambers: null,
      growth: instant ? GROW_TICKS : 0,
      pending: null,
      load: 0,
      starve: 0,
      vents: {},
    };
    // The bud itself is LOCAL: snip the host once, at the organ's center.
    // Both halves stay intact — their in-disc portions hidden under the
    // opaque growing blob — until completeBud() trims them back to the
    // membrane on completion. The upstream half keeps the host's id, so
    // anchors referencing the host keep resolving.
    const downId = snipVeinAt(w, p, idx);
    p.tail = { type: 'organ-in', organId: o.id, port: 'in' };
    o.pending = {
      trims: [
        { veinId: p.id, end: 'tail', port: 'in' },
        ...(downId !== null ? [{ veinId: downId, end: 'head' as const, port: 'out' }] : []),
      ],
    };
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
          ports: o.ports.map((p) => ({ ...p, pt: [p.pt[0], p.pt[1]] as Pt })),
          pending: o.pending ? { trims: o.pending.trims.map((t) => ({ ...t })) } : null,
          vents: {}, // view-only trackers regrow after a restore
          chambers: o.chambers
            ? Object.fromEntries(Object.entries(o.chambers).map(([k, p]) => [k, cloneParcel(p)]))
            : null,
        } satisfies Organ,
      ]),
    ),
    nextId: w.nextId,
    sources: w.sources,
    nodeHash: new NodeHash<Vein>(),
    histCount: 0,
    spawnDwell: new Map(w.spawnDwell),
  };
  reindex(snap);
  return snap;
}
