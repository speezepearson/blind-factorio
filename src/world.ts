import {
  addInto, ambientLeak, cloneParcel, emptyParcel, exchangeHeat, radCount, reactParcel, rnd,
  sourceParcel, splitHalf, stochRound, tempOf, totalParticles,
  K_ALONG, K_CROSS,
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
// Organs sit on 5×5 footprints, grown by budding on a straight stretch of
// vein (the host vein is cut around them). One organ type exists so far —
// the radical filter — with its behavior hard-coded in organProcess().

export const COLS = 46;
export const ROWS = 30;
export const CELL = 21;
export const HIST = 400; // rolling probe-history window, ticks
const HIST_CAP = 1600; // max segments carrying passive history

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
}

export interface Organ {
  id: number;
  cx: number;
  cy: number;
  footprint: Set<string>;
  portIn: VeinCell;
  portOut: VeinCell;
  portSide: VeinCell;
  sideCW: boolean;
  inAccum: Parcel | null;
  outReady: Parcel | null;
  sideReady: Parcel | null;
}

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

function newVein(w: World, cells: Array<{ x: number; y: number }>, head: Head, tail: Tail): Vein {
  const p: Vein = {
    id: w.nextId++,
    cells: cells.map((c) => ({ x: c.x, y: c.y, k: key(c.x, c.y) })),
    head,
    tail,
    parcels: cells.map(() => emptyParcel(w.chem)),
    hist: cells.map(() => null),
    flow: cells.map(() => 0),
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

export function doTick(w: World): void {
  const chem = w.chem;

  // 1) HEAT — along veins, across co-located veins, ambient leak
  for (const p of w.veins.values()) {
    for (let i = 0; i + 1 < p.parcels.length; i++) exchangeHeat(chem, p.parcels[i], p.parcels[i + 1], K_ALONG);
  }
  for (const segs of w.cellSegs.values()) {
    if (segs.length > 1) {
      for (let i = 0; i + 1 < segs.length; i++) {
        exchangeHeat(chem, segs[i].vein.parcels[segs[i].idx], segs[i + 1].vein.parcels[segs[i + 1].idx], K_CROSS);
      }
    }
  }
  for (const p of w.veins.values()) for (const parcel of p.parcels) ambientLeak(chem, parcel);

  // 2) REACTIONS
  for (const p of w.veins.values()) for (const parcel of p.parcels) reactParcel(chem, parcel);

  // 3) ADVECTION — forks extract pre-shift, tails deliver post-shift
  const headIn = new Map<number, Parcel>();
  for (const p of w.veins.values()) {
    if (p.head.type === 'fork') {
      const seg = resolveAttach(w, p.head);
      headIn.set(p.id, seg ? splitHalf(chem, seg.vein.parcels[seg.idx]) : emptyParcel(chem));
    }
  }
  const tailOut = new Map<number, Parcel>();
  for (const p of w.veins.values()) tailOut.set(p.id, p.parcels[p.parcels.length - 1]);
  for (const p of w.veins.values()) {
    for (let i = p.parcels.length - 1; i >= 1; i--) p.parcels[i] = p.parcels[i - 1];
    let fill: Parcel | null = null;
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
    p.parcels[0] = fill ?? emptyParcel(chem);
  }
  for (const p of w.veins.values()) {
    const out = tailOut.get(p.id)!;
    if (p.tail.type === 'merge') {
      const seg = resolveAttach(w, p.tail);
      if (seg) addInto(chem, seg.vein.parcels[seg.idx], out);
    } else if (p.tail.type === 'organ-in') {
      const o = w.organs.get(p.tail.organId);
      if (o) {
        if (o.inAccum) addInto(chem, o.inAccum, out);
        else o.inAccum = out;
      }
    }
    // open tails vent (discarded)
  }
  for (const o of w.organs.values()) organProcess(w, o);

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
      for (let s = 0; s < chem.nsp; s++) h[base + s] = parcel.c[s] / 10000;
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

export function commitVein(
  w: World,
  rawCells: Array<{ x: number; y: number }>,
  head: Head,
  tail: Tail,
): Vein | null {
  if (rawCells.length < 2) return null;
  const p = newVein(w, rawCells, head, tail);
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
    type Run = { cell: VeinCell; parcel: Parcel; hist: Float32Array | null; flow: number; i: number };
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
        run.push({ cell: p.cells[i], parcel: p.parcels[i], hist: p.hist[i], flow: p.flow[i], i });
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

// Bud an organ on a straight 5-cell stretch of vein centered at cellKey.
// The host vein is cut: upstream feeds the organ's in, downstream grows
// from its out port. (Hard-coded to the radical filter for now — the
// mixture-determined budding grammar is a later milestone.)
export function tryBud(w: World, cellKey: string): { ok: boolean; msg: string } {
  const segs = w.cellSegs.get(cellKey);
  if (!segs || segs.length === 0) return { ok: false, msg: 'no vein here' };
  for (const { vein: p, idx: i } of segs) {
    if (i < 2 || i > p.cells.length - 3) continue;
    const run = p.cells.slice(i - 2, i + 3);
    const horiz = run.every((c) => c.y === run[0].y);
    const vert = run.every((c) => c.x === run[0].x);
    if (!horiz && !vert) continue;
    const mono = run.every(
      (c, j) =>
        j === 0 ||
        (horiz
          ? Math.abs(c.x - run[j - 1].x) === 1 && c.y === run[j - 1].y
          : Math.abs(c.y - run[j - 1].y) === 1 && c.x === run[j - 1].x),
    );
    if (!mono) continue;
    const cx = p.cells[i].x;
    const cy = p.cells[i].y;
    if (cx - 2 < 0 || cy - 2 < 0 || cx + 2 >= COLS || cy + 2 >= ROWS) {
      return { ok: false, msg: 'too close to the edge' };
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
    if (blocked) return { ok: false, msg: 'footprint blocked' };
    const din = { x: p.cells[i].x - p.cells[i - 1].x, y: p.cells[i].y - p.cells[i - 1].y };
    const cw = rnd() < 0.5;
    const sideDir = cw ? { x: -din.y, y: din.x } : { x: din.y, y: -din.x };
    const mk = (x: number, y: number): VeinCell => ({ x, y, k: key(x, y) });
    const o: Organ = {
      id: w.nextId++,
      cx,
      cy,
      footprint: foot,
      portIn: mk(cx - din.x * 2, cy - din.y * 2),
      portOut: mk(cx + din.x * 2, cy + din.y * 2),
      portSide: mk(cx + sideDir.x * 2, cy + sideDir.y * 2),
      sideCW: cw,
      inAccum: null,
      outReady: null,
      sideReady: null,
    };
    // cut the host: upstream keeps head, tail -> organ-in; downstream head
    // -> out port, keeps tail
    const upCells = p.cells.slice(0, i - 2);
    const downCells = p.cells.slice(i + 3);
    w.veins.delete(p.id);
    for (let j = i - 2; j <= i + 2; j++) if (p.hist[j]) w.histCount--;
    if (upCells.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        cells: upCells,
        parcels: p.parcels.slice(0, i - 2),
        hist: p.hist.slice(0, i - 2),
        flow: p.flow.slice(0, i - 2),
        head: p.head,
        tail: { type: 'organ-in', organId: o.id },
        probed: p.probed,
      });
    }
    if (downCells.length >= 2) {
      w.veins.set(w.nextId, {
        id: w.nextId++,
        cells: downCells,
        parcels: p.parcels.slice(i + 3),
        hist: p.hist.slice(i + 3),
        flow: p.flow.slice(i + 3),
        head: { type: 'port', organId: o.id, port: 'out' },
        tail: p.tail,
        probed: p.probed,
      });
    }
    w.organs.set(o.id, o);
    reindex(w);
    return { ok: true, msg: `Radical Filter grown (side port ${cw ? 'cw' : 'ccw'})` };
  }
  return { ok: false, msg: 'bud failed: need 5 straight cells of vein centered here' };
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
