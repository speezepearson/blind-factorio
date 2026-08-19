import { GROW_TICKS, commitVein, makeWorld, organGrown, reindex } from './world';
import type { Head, Organ, Tail, World } from './world';
import type { Chemistry } from './chem';
import { R_ORGAN, SEG, quant, resample } from './geom';
import type { Pt } from './geom';

// World <-> shareable code: JSON, deflated, URL-safe base64. Serializes
// structure only — vein curves, attachments, organs, the stickiness
// table, and the ambient temperature (shared worlds keep their physics).
// Fluid state, heat, and probe history are not serialized: an imported
// world starts empty and fills from its sources.
//
// rv 2: continuous geometry. Points are stored as integer quarter-pixels
// (x*4, y*4) — exactly the engine's quantization, so codes round-trip
// losslessly. rv 1 (the old square-grid format) still imports: cells map
// to their pixel centers, keeping their 21px spacing (within the engine's
// tolerance, so old veins advect slightly faster per px than SEG=16 ones);
// partial incarnation from v1 codes is dropped — they load fully incarnate.

type PtDoc = [number, number]; // quarter-pixel ints

interface VeinDoc {
  pts: PtDoc[];
  head: HeadDoc;
  tail: TailDoc;
  inc?: number[]; // per-node incarnation (omitted = fully incarnate)
}

type HeadDoc =
  | { type: 'open' }
  | { type: 'source'; spIdx: number }
  | { type: 'fork'; veinId: number; at: PtDoc } // veinId = index into veins array
  | { type: 'port'; organId: number; port: 'out' | 'side' }; // organId = index into organs array
type TailDoc =
  | { type: 'open' }
  | { type: 'merge'; veinId: number; at: PtDoc }
  | { type: 'organ-in'; organId: number };

interface OrganDoc {
  c: PtDoc;
  r: number;
  in: PtDoc;
  out: PtDoc;
  side: PtDoc;
  // present only for organs exported mid-growth: ticks grown + the two
  // snipped host halves (as vein-array indices) awaiting the completion trim
  g?: number;
  up?: number;
  down?: number;
}

interface WorldDoc {
  rv: 2;
  stick: Record<string, number>;
  amb?: number; // ambient temperature; absent in codes from before it was tunable
  veins: VeinDoc[];
  organs: OrganDoc[];
}

// the old square-grid format, kept for migration
interface WorldDocV1 {
  rv: 1;
  stick: Record<string, number>;
  veins: Array<{
    cells: Array<[number, number]>;
    head: { type: string; spIdx?: number; veinId?: number; cellKey?: string; organId?: number; port?: string };
    tail: { type: string; veinId?: number; cellKey?: string; organId?: number };
  }>;
  organs: Array<{ cx: number; cy: number; in: [number, number]; out: [number, number]; side: [number, number] }>;
}

const enc = (pt: Pt): PtDoc => [Math.round(pt[0] * 4), Math.round(pt[1] * 4)];
const dec = (pd: PtDoc): Pt => [quant(pd[0] / 4), quant(pd[1] / 4)];
const isPtDoc = (v: unknown): v is PtDoc =>
  Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]);

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(b64: string): Uint8Array {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function worldToCode(w: World): Promise<string> {
  const veins = [...w.veins.values()];
  const veinIndex = new Map(veins.map((p, i) => [p.id, i]));
  const organs = [...w.organs.values()];
  const organIndex = new Map(organs.map((o, i) => [o.id, i]));
  const remapHead = (h: Head): HeadDoc =>
    h.type === 'fork'
      ? { type: 'fork', veinId: veinIndex.get(h.veinId) ?? -1, at: enc(h.at) }
      : h.type === 'port'
        ? { type: 'port', organId: organIndex.get(h.organId) ?? -1, port: h.port }
        : h;
  const remapTail = (t: Tail): TailDoc =>
    t.type === 'merge'
      ? { type: 'merge', veinId: veinIndex.get(t.veinId) ?? -1, at: enc(t.at) }
      : t.type === 'organ-in'
        ? { type: 'organ-in', organId: organIndex.get(t.organId) ?? -1 }
        : t;
  const doc: WorldDoc = {
    rv: 2,
    stick: { ...w.chem.stick },
    amb: w.chem.ambient,
    veins: veins.map((p) => ({
      pts: p.pts.map(enc),
      head: remapHead(p.head),
      tail: remapTail(p.tail),
      ...(p.inc.every((v) => v === 1) ? {} : { inc: [...p.inc] }),
    })),
    organs: organs.map((o) => ({
      c: enc(o.c),
      r: o.r,
      in: enc(o.portIn),
      out: enc(o.portOut),
      side: enc(o.portSide),
      // mid-growth organs round-trip their growth state so completion (the
      // membrane trim + port attachment) still happens after import
      ...(o.pending
        ? {
            g: o.growth,
            up: veinIndex.get(o.pending.upId) ?? -1,
            ...(o.pending.downId !== null ? { down: veinIndex.get(o.pending.downId) ?? -1 } : {}),
          }
        : {}),
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytesToB64(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
}

// convert an rv:1 grid doc into rv:2 shape (cells -> pixel centers)
function migrateV1(doc: WorldDocV1): WorldDoc {
  const CELL = 21;
  const cellPt = ([x, y]: [number, number]): PtDoc => [(x * CELL + 10) * 4 + 2, (y * CELL + 10) * 4 + 2];
  return {
    rv: 2,
    stick: doc.stick,
    veins: (Array.isArray(doc.veins) ? doc.veins : []).map((vd) => {
      const pts = (Array.isArray(vd.cells) ? vd.cells : []).filter(isPtDoc).map(cellPt);
      const head: HeadDoc =
        vd.head?.type === 'source' && Number.isInteger(vd.head.spIdx)
          ? { type: 'source', spIdx: vd.head.spIdx! }
          : vd.head?.type === 'fork' && typeof vd.head.cellKey === 'string' && Number.isInteger(vd.head.veinId)
            ? {
                type: 'fork',
                veinId: vd.head.veinId!,
                at: cellPt(vd.head.cellKey.split(',').map(Number) as [number, number]),
              }
            : vd.head?.type === 'port' && Number.isInteger(vd.head.organId)
              ? { type: 'port', organId: vd.head.organId!, port: vd.head.port === 'side' ? 'side' : 'out' }
              : { type: 'open' };
      const tail: TailDoc =
        vd.tail?.type === 'merge' && typeof vd.tail.cellKey === 'string' && Number.isInteger(vd.tail.veinId)
          ? {
              type: 'merge',
              veinId: vd.tail.veinId!,
              at: cellPt(vd.tail.cellKey.split(',').map(Number) as [number, number]),
            }
          : vd.tail?.type === 'organ-in' && Number.isInteger(vd.tail.organId)
            ? { type: 'organ-in', organId: vd.tail.organId! }
            : { type: 'open' };
      return { pts, head, tail };
    }),
    organs: (Array.isArray(doc.organs) ? doc.organs : []).map((od) => ({
      c: cellPt([od.cx, od.cy]),
      r: R_ORGAN,
      in: isPtDoc(od.in) ? cellPt(od.in) : cellPt([od.cx - 2, od.cy]),
      out: isPtDoc(od.out) ? cellPt(od.out) : cellPt([od.cx + 2, od.cy]),
      side: isPtDoc(od.side) ? cellPt(od.side) : cellPt([od.cx, od.cy - 2]),
    })),
  };
}

export async function worldFromCode(chem: Chemistry, code: string): Promise<World> {
  const bytes = b64ToBytes(code.replace(/\s+/g, ''));
  const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  let doc = JSON.parse(json) as WorldDoc | WorldDocV1;
  if (doc.rv === 1) doc = migrateV1(doc as WorldDocV1);
  if (doc.rv !== 2 || !Array.isArray(doc.veins)) throw new Error('not a recognized world document');

  const w = makeWorld(chem);
  // stickiness and ambient are applied at the very end, after everything
  // that can throw — a rejected code must not leave the live chemistry
  // mutated. Values are clamped to the god sliders' ranges; codes that
  // predate a knob leave its current setting alone.
  const stick: Record<string, number> = {};
  if (doc.stick && typeof doc.stick === 'object') {
    for (const r of chem.radicals) {
      const v = Number(doc.stick[r.id]);
      if (Number.isFinite(v)) stick[r.id] = Math.max(0, Math.min(4, v));
    }
  }
  const ambRaw = Number(doc.amb);
  const amb = Number.isFinite(ambRaw) ? Math.max(0.05, Math.min(10, ambRaw)) : null;

  const organIds: number[] = [];
  for (const od of Array.isArray(doc.organs) ? doc.organs : []) {
    if (!isPtDoc(od.c) || !isPtDoc(od.in) || !isPtDoc(od.out) || !isPtDoc(od.side)) continue;
    const o: Organ = {
      id: w.nextId++,
      c: dec(od.c),
      r: Number.isFinite(od.r) && od.r > 8 ? od.r : R_ORGAN,
      portIn: dec(od.in),
      portOut: dec(od.out),
      portSide: dec(od.side),
      inAccum: null,
      outReady: null,
      sideReady: null,
      growth: GROW_TICKS,
      pending: null,
      ventOut: null,
      ventSide: null,
      load: 0,
    };
    w.organs.set(o.id, o);
    organIds.push(o.id);
  }
  const veinIds: number[] = [];
  const pending: Array<{ veinIdx: number; head: HeadDoc; tail: TailDoc }> = [];
  for (const vd of doc.veins) {
    const pts = (Array.isArray(vd.pts) ? vd.pts : []).filter(isPtDoc).map(dec);
    // the engine assumes node chains stepped ~SEG apart; reject crafted
    // codes whose nodes jump or bunch (rv1 migration resamples instead)
    const spaced = pts.every((pt, i) => {
      if (i === 0) return true;
      const d = Math.hypot(pt[0] - pts[i - 1][0], pt[1] - pts[i - 1][1]);
      return d >= SEG * 0.3 && d <= SEG * 2.5;
    });
    const usable = spaced ? pts : pts.length >= 2 ? resample(pts, SEG) : [];
    const p = usable.length >= 2 ? commitVein(w, usable, { type: 'open' }, { type: 'open' }, true) : null;
    if (p && Array.isArray(vd.inc) && vd.inc.length === p.pts.length) {
      for (let i = 0; i < p.pts.length; i++) {
        p.inc[i] = vd.inc[i] === 1 ? 1 : 0;
        p.incTick[i] = p.inc[i] ? 0 : -1;
      }
    }
    veinIds.push(p ? p.id : -1);
    if (p) pending.push({ veinIdx: veinIds.length - 1, head: vd.head, tail: vd.tail });
  }
  for (const { veinIdx, head, tail } of pending) {
    const p = w.veins.get(veinIds[veinIdx]);
    if (!p) continue;
    if (head?.type === 'source' && Number.isInteger(head.spIdx) && head.spIdx >= 0 && head.spIdx < chem.nsp) {
      p.head = { type: 'source', spIdx: head.spIdx };
    } else if (head?.type === 'fork' && veinIds[head.veinId] > 0 && isPtDoc(head.at)) {
      p.head = { type: 'fork', veinId: veinIds[head.veinId], at: dec(head.at) };
    } else if (head?.type === 'port' && organIds[head.organId] > 0) {
      p.head = { type: 'port', organId: organIds[head.organId], port: head.port === 'side' ? 'side' : 'out' };
    }
    if (tail?.type === 'merge' && veinIds[tail.veinId] > 0 && isPtDoc(tail.at)) {
      p.tail = { type: 'merge', veinId: veinIds[tail.veinId], at: dec(tail.at) };
    } else if (tail?.type === 'organ-in' && organIds[tail.organId] > 0) {
      p.tail = { type: 'organ-in', organId: organIds[tail.organId] };
    }
  }
  // reconnect mid-growth organs to their snipped halves
  const organDocs = Array.isArray(doc.organs) ? doc.organs : [];
  [...w.organs.values()].forEach((o, i) => {
    const od = organDocs[i];
    if (!od || organGrown(o)) return;
    const upId = Number.isInteger(od.up) ? veinIds[od.up!] : -1;
    const downId = od.down !== undefined && Number.isInteger(od.down) ? veinIds[od.down] : null;
    if (upId > 0) o.pending = { upId, downId: downId !== null && downId > 0 ? downId : null };
    else o.growth = GROW_TICKS; // halves missing: arrive grown rather than stuck
  });
  reindex(w);
  chem.setStickiness(stick);
  if (amb !== null) chem.setAmbient(amb);
  return w;
}
