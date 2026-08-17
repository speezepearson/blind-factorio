import {
  addInto, ambientLeak, cloneParcel, emptyParcel, exchangeHeat, radCount, reactParcel,
  sourceParcel, splitHalf, stochRound, tempOf, totalParticles,
  K_ALONG, K_CROSS, SCALE,
} from './chem';
import type { Chemistry, Parcel } from './chem';

// The world is a grid of cells. Fluid lives in VEINS: ordered paths of
// cells, one parcel per cell, advecting one cell per tick from head to
// tail. Any number of veins may pass through the same cell (drawn in
// offset lanes); co-located parcels exchange heat but not matter.
//
// A vein's endpoints attach:
//   head:  open | source | fork (splits half of a host vein's parcel)
//        | port (an organ's out or side port)
//   tail:  open (vents) | merge (adds into a host vein's parcel)
//        | organ-in (feeds an organ)
//
// Organs sit on 5×5 footprints, grown by budding anywhere on a vein that
// flows in from outside the footprint (the in-footprint stretch is eaten;
// ports sit where the vein crossed the wall). One organ type exists so far
// — the radical filter — with its behavior hard-coded in organProcess().

export const COLS = 46;
export const ROWS = 30;
export const CELL = 21;
export const HIST = 400; // rolling probe-history window, ticks
const HIST_CAP = 1600; // max segments carrying passive history
export const GROW_TICKS = 10; // ticks for a budded organ to grow in
export const INC_PERIOD = 2; // ticks per cell of ghost-vein incarnation

export const key = (x: number, y: number) => x + ',' + y;
export const parseKey = (k: string): [number, number] => k.split(',').map(Number) as [number, number];

export interface VeinCell {
  x: number;
  y: number;
  k: string;
}

export type Head =
  | { type: 'open' }
  | { type: 'source'; spIdx: number }
  | { type: 'fork'; veinId: number; cellKey: string }
  | { type: 'port'; organId: number; port: 'out' | 'side' };
export type Tail =
  | { type: 'open' }
  | { type: 'merge'; veinId: number; cellKey: string }
  | { type: 'organ-in'; organId: number };

export interface Vein {
  id: number;
  cells: VeinCell[];
  head: Head;
  tail: Tail;
  parcels: Parcel[];
  flow: number[]; // smoothed radicals/tick per cell, drives drawn width
  hist: Array<Float32Array | null>; // per-cell probe history ring buffers
  probed?: boolean;
  // Incarnation: drawn veins start as ghosts (inc all 0) and grow real,
  // one cell per INC_PERIOD ticks, spreading from every contact with the
  // live network. Ghost cells have no walls: they carry no fluid and
  // exchange no heat — fluid reaching the frontier vents into the cavity.
  inc: number[]; // 1 = incarnate
  incTick: number[]; // world tick the cell incarnated (-1 = never), for smooth extrusion
}

export interface Organ {
  id: number;
  cx: number;
  cy: number;
  footprint: Set<string>;
  portIn: VeinCell;
  portOut: VeinCell;
  portSide: VeinCell;
  sideCW: boolean; // vestigial (pre-generalized-budding); kept for the doc format
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
  x: number;
  y: number;
  k: string;
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
  sourceMap: Map<string, Source>;
  cellSegs: Map<string, Array<{ vein: Vein; idx: number }>>;
  organCells: Map<string, { organ: Organ; role: 'body' | 'in' | 'out' | 'side' }>;
  histCount: number;
}

export function makeWorld(chem: Chemistry): World {
  const sources: Source[] = chem.species.map((s, i) => ({
    x: 1,
    y: 2 + i * 4,
    k: key(1, 2 + i * 4),
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
    sourceMap: new Map(sources.map((s) => [s.k, s])),
    cellSegs: new Map(),
    organCells: new Map(),
    histCount: 0,
  };
}

export function reindex(w: World): void {
  w.cellSegs = new Map();
  for (const p of w.veins.values()) {
    p.cells.forEach((c, i) => {
      let arr = w.cellSegs.get(c.k);
      if (!arr) {
        arr = [];
        w.cellSegs.set(c.k, arr);
      }
      arr.push({ vein: p, idx: i });
    });
  }
  w.organCells = new Map();
  for (const o of w.organs.values()) {
    for (const k2 of o.footprint) w.organCells.set(k2, { organ: o, role: 'body' });
    w.organCells.set(o.portIn.k, { organ: o, role: 'in' });
    w.organCells.set(o.portOut.k, { organ: o, role: 'out' });
    w.organCells.set(o.portSide.k, { organ: o, role: 'side' });
  }
}

function newVein(w: World, cells: Array<{ x: number; y: number }>, head: Head, tail: Tail, incarnate: boolean): Vein {
  const p: Vein = {
    id: w.nextId++,
    cells: cells.map((c) => ({ x: c.x, y: c.y, k: key(c.x, c.y) })),
    head,
    tail,
    parcels: cells.map(() => emptyParcel(w.chem)),
    hist: cells.map(() => null),
    flow: cells.map(() => 0),
    inc: cells.map(() => (incarnate ? 1 : 0)),
    incTick: cells.map(() => (incarnate ? 0 : -1)),
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

export function resolveAttach(
  w: World,
  att: { veinId: number; cellKey: string },
): { vein: Vein; idx: number } | null {
  const segs = w.cellSegs.get(att.cellKey);
  if (!segs) return null;
  let s = segs.find((s2) => s2.vein.id === att.veinId);
  if (!s) {
    s = segs[0];
    if (s) att.veinId = s.vein.id;
  }
  return s ?? null;
}

// ---------------- the tick ----------------

// One step of ghost-vein incarnation: every ghost cell touching the live
// network — along its own vein, or at any attachment or junction with an
// incarnate cell, a source, or a grown organ — becomes incarnate. Called
// every INC_PERIOD ticks, so fronts advance one cell per period.
function growthStep(w: World): void {
  const grow: Array<{ p: Vein; i: number }> = [];
  const liveAt = (att: { veinId: number; cellKey: string }): boolean => {
    const seg = resolveAttach(w, att);
    return !!seg && seg.vein.inc[seg.idx] === 1;
  };
  const grownOrgan = (id: number): boolean => {
    const o = w.organs.get(id);
    return !!o && organGrown(o);
  };
  for (const p of w.veins.values()) {
    const n = p.cells.length;
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
  // junction seeds: an incarnate vein end touching a ghost cell mid-vein
  for (const q of w.veins.values()) {
    if (q.head.type === 'fork' && q.inc[0] === 1) {
      const seg = resolveAttach(w, q.head);
      if (seg && !seg.vein.inc[seg.idx]) grow.push({ p: seg.vein, i: seg.idx });
    }
    if (q.tail.type === 'merge' && q.inc[q.cells.length - 1] === 1) {
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

  // 1) HEAT — along veins, across co-located veins, ambient leak. Ghost
  // cells have no walls: they take no part in any of it.
  for (const p of w.veins.values()) {
    for (let i = 0; i + 1 < p.parcels.length; i++) {
      if (p.inc[i] && p.inc[i + 1]) exchangeHeat(chem, p.parcels[i], p.parcels[i + 1], K_ALONG);
    }
  }
  for (const segs of w.cellSegs.values()) {
    if (segs.length > 1) {
      for (let i = 0; i + 1 < segs.length; i++) {
        const a = segs[i];
        const b = segs[i + 1];
        if (a.vein.inc[a.idx] && b.vein.inc[b.idx]) {
          exchangeHeat(chem, a.vein.parcels[a.idx], b.vein.parcels[b.idx], K_CROSS);
        }
      }
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
  // cell every tick, nothing ever stalls. Fluid that runs out of vein
  // vents into the cavity; every vent is structurally visible — an open
  // tail, the frontier of a still-incarnating ghost, a growing organ's
  // mouth — so mass-balance inference stays honest: what goes missing went
  // missing somewhere the player can point at.
  // forks extract pre-shift (only where both junction cells are incarnate)
  const headIn = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && p.inc[0]) {
      const seg = resolveAttach(w, p.head);
      if (seg && seg.vein.inc[seg.idx]) headIn.set(p.id, splitHalf(chem, seg.vein.parcels[seg.idx]));
    }
  }
  const tailOut = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    const n = p.cells.length;
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
      // a parcel shifting into a not-yet-incarnate cell vents at the frontier
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
// incarnate: true to lay live vasculature.
export function commitVein(
  w: World,
  rawCells: Array<{ x: number; y: number }>,
  head: Head,
  tail: Tail,
  incarnate = false,
): Vein | null {
  if (rawCells.length < 2) return null;
  const p = newVein(w, rawCells, head, tail, incarnate);
  reindex(w);
  return p;
}

export function eraseCells(w: World, keys: Set<string>): void {
  // organs die if any footprint/port cell is hit; their attached veins go open
  for (const o of [...w.organs.values()]) {
    const cells = [...o.footprint, o.portIn.k, o.portOut.k, o.portSide.k];
    if (cells.some((k2) => keys.has(k2))) {
      for (const p of w.veins.values()) {
        if (p.head.type === 'port' && p.head.organId === o.id) p.head = { type: 'open' };
        if (p.tail.type === 'organ-in' && p.tail.organId === o.id) p.tail = { type: 'open' };
      }
      w.organs.delete(o.id);
    }
  }
  // erase vein cells, splitting survivors into fragments (parcels ride along)
  const newVeins: Vein[] = [];
  for (const p of [...w.veins.values()]) {
    if (!p.cells.some((c) => keys.has(c.k))) {
      newVeins.push(p);
      continue;
    }
    w.veins.delete(p.id);
    type Run = {
      cell: VeinCell; parcel: Parcel; hist: Float32Array | null; flow: number;
      inc: number; incTick: number; i: number;
    };
    let run: Run[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const isFirst = run[0].i === 0;
        const isLast = run[run.length - 1].i === p.cells.length - 1;
        newVeins.push({
          id: w.nextId++,
          cells: run.map((r) => r.cell),
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
    for (let i = 0; i < p.cells.length; i++) {
      if (keys.has(p.cells[i].k)) {
        flush();
        if (p.hist[i]) w.histCount--;
      } else {
        run.push({
          cell: p.cells[i], parcel: p.parcels[i], hist: p.hist[i], flow: p.flow[i],
          inc: p.inc[i], incTick: p.incTick[i], i,
        });
      }
    }
    flush();
  }
  w.veins = new Map(newVeins.map((p) => [p.id, p]));
  reindex(w);
  // attachments pointing at vanished segments go open
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork' && !resolveAttach(w, p.head)) p.head = { type: 'open' };
    if (p.tail.type === 'merge' && !resolveAttach(w, p.tail)) p.tail = { type: 'open' };
  }
}

// Bud an organ centered on any incarnate vein cell: its 5×5 footprint eats
// the contiguous in-footprint stretch of that vein. The host is cut:
// upstream feeds the organ's in port, downstream grows from its out port,
// both sitting where the vein crossed the organ wall. (Hard-coded to the
// radical filter for now — the mixture-determined budding grammar is a
// later milestone.)
export function tryBud(w: World, cellKey: string, opts?: { instant?: boolean }): { ok: boolean; msg: string } {
  const segs = w.cellSegs.get(cellKey);
  if (!segs || segs.length === 0) return { ok: false, msg: 'no vein here' };
  let why = 'bud failed: needs a vein flowing through from outside';
  for (const { vein: p, idx } of segs) {
    const cx = p.cells[idx].x;
    const cy = p.cells[idx].y;
    if (cx - 2 < 0 || cy - 2 < 0 || cx + 2 >= COLS || cy + 2 >= ROWS) {
      why = 'too close to the edge';
      continue;
    }
    // The organ eats the contiguous in-footprint stretch of vein around the
    // clicked cell. No straightness requirement: the stretch may bend
    // freely, and other stretches of the same vein crossing the footprint
    // are untouched.
    const inFoot = (c: VeinCell) => Math.abs(c.x - cx) <= 2 && Math.abs(c.y - cy) <= 2;
    const n = p.cells.length;
    let a = idx;
    while (a - 1 >= 0 && inFoot(p.cells[a - 1])) a--;
    let b = idx;
    while (b + 1 < n && inFoot(p.cells[b + 1])) b++;
    // (a) upstream must flow in from outside the footprint
    if (a === 0) {
      why = 'the vein must flow in from outside';
      continue;
    }
    // (b) downstream must exit the footprint, or terminate openly inside it
    if (b === n - 1 && p.tail.type !== 'open') {
      why = p.tail.type === 'merge' ? "there's a junction in the way" : 'too close to another organ';
      continue;
    }
    // never strand a 1-cell fragment (veins are always >= 2 cells)
    if (a === 1 || n - 1 - b === 1) {
      why = 'too close to the end of the vein';
      continue;
    }
    if (!p.inc.slice(a, b + 1).every((v) => v === 1)) {
      why = 'the vein here is not grown in yet';
      continue;
    }
    // Refuse if any OTHER vein junctions onto the doomed stretch: when the
    // understretch is collected, that fork/merge would dangle and become a
    // permanent vent hidden under the organ body — exactly the invisible
    // sink the venting model forbids.
    const doomedKeys = new Set(p.cells.slice(a, b + 1).map((c) => c.k));
    let junction = false;
    for (const q of w.veins.values()) {
      if (q.id === p.id) continue;
      if (
        (q.head.type === 'fork' && doomedKeys.has(q.head.cellKey)) ||
        (q.tail.type === 'merge' && doomedKeys.has(q.tail.cellKey))
      ) {
        junction = true;
        break;
      }
    }
    if (junction) {
      why = "there's a junction in the way";
      continue;
    }
    const foot = new Set<string>();
    let blocked = false;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const k2 = key(cx + dx, cy + dy);
        if (w.sourceMap.has(k2) || w.organCells.has(k2)) blocked = true;
        foot.add(k2);
      }
    }
    if (blocked) {
      why = 'footprint blocked';
      continue;
    }

    // ---- placement: ports sit where the vein crossed the organ wall ----
    const mk = (x: number, y: number): VeinCell => ({ x, y, k: key(x, y) });
    const ring: VeinCell[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) ring.push(mk(cx + dx, cy + dy));
      }
    }
    const manh = (u: VeinCell, v: VeinCell) => Math.abs(u.x - v.x) + Math.abs(u.y - v.y);
    // ring cell farthest (min-distance) from the cells to avoid
    const farthestRing = (avoid: VeinCell[]) =>
      ring.reduce((best, c) => {
        const d = Math.min(...avoid.map((v) => manh(c, v)));
        const bd = Math.min(...avoid.map((v) => manh(best, v)));
        return d > bd ? c : best;
      });
    const portIn = mk(p.cells[a].x, p.cells[a].y);
    let portOut: VeinCell;
    const downPrepend: VeinCell[] = [];
    if (b < n - 1) {
      const natural = p.cells[b];
      if (natural.k !== portIn.k) {
        portOut = mk(natural.x, natural.y);
      } else {
        // the vein exits through its own entry square: shove the out port
        // one over and grow a stub of vein so the downstream tail still
        // leaves from its port
        const alt = ring.find((c) => manh(c, natural) === 1 && c.k !== portIn.k) ?? farthestRing([portIn]);
        portOut = alt;
        downPrepend.push(mk(alt.x, alt.y), mk(natural.x, natural.y));
      }
    } else {
      // the vein terminates inside: the out port goes wherever there's room
      portOut = farthestRing([portIn]);
    }
    const portSide = farthestRing([portIn, portOut]);

    const instant = opts?.instant ?? false;
    const o: Organ = {
      id: w.nextId++,
      cx,
      cy,
      footprint: foot,
      portIn,
      portOut,
      portSide,
      sideCW: false,
      inAccum: null,
      outReady: null,
      sideReady: null,
      growth: instant ? GROW_TICKS : 0,
      understretchId: null,
      load: 0,
    };
    // cut the host: upstream keeps head, tail -> organ-in; downstream head
    // -> out port, keeps tail. Unless the organ arrives instantly (preset
    // building), the eaten stretch survives as a doomed "understretch" —
    // still visible beneath the growing organ until it covers them.
    const upCells = p.cells.slice(0, a);
    const downCells = [...downPrepend, ...p.cells.slice(b + 1)];
    w.veins.delete(p.id);
    if (instant) {
      for (let j = a; j <= b; j++) if (p.hist[j]) w.histCount--;
    } else {
      const stretch: Vein = {
        id: w.nextId++,
        cells: p.cells.slice(a, b + 1),
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
    if (upCells.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        cells: upCells,
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
    if (downCells.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        cells: downCells,
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
          cells: p.cells.map((c) => ({ ...c })),
          head: { ...p.head },
          tail: { ...p.tail },
          parcels: p.parcels.map(cloneParcel),
          hist: p.cells.map(() => null),
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
          footprint: new Set(o.footprint),
          portIn: { ...o.portIn },
          portOut: { ...o.portOut },
          portSide: { ...o.portSide },
          inAccum: o.inAccum ? cloneParcel(o.inAccum) : null,
          outReady: o.outReady ? cloneParcel(o.outReady) : null,
          sideReady: o.sideReady ? cloneParcel(o.sideReady) : null,
        } satisfies Organ,
      ]),
    ),
    nextId: w.nextId,
    sources: w.sources,
    sourceMap: w.sourceMap,
    cellSegs: new Map(),
    organCells: new Map(),
    histCount: 0,
  };
  reindex(snap);
  return snap;
}
