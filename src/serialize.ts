import { GROW_TICKS, commitVein, makeWorld, reindex } from './world';
import type { Head, Organ, Tail, VeinCell, World } from './world';
import type { Chemistry } from './chem';

// World <-> shareable code: JSON, deflated, URL-safe base64. Serializes
// structure only — vein routes, attachments, organs, and the stickiness
// table (shared worlds keep their physics). Fluid state, heat, and probe
// history are not serialized: an imported world starts empty and fills
// from its sources.
//
// This is doc format 1 of the radical-chemistry game ("rv" marker). Codes
// from the old wavelength-era game are rejected as unrecognized.

interface VeinDoc {
  cells: Array<[number, number]>;
  head: Head; // fork/merge veinIds are *indices into the veins array*
  tail: Tail;
  inc?: number[]; // per-cell incarnation (omitted = fully incarnate)
}

interface OrganDoc {
  cx: number;
  cy: number;
  in: [number, number];
  out: [number, number];
  side: [number, number];
  cw: boolean;
}

interface WorldDoc {
  rv: 1;
  stick: Record<string, number>;
  veins: VeinDoc[];
  organs: OrganDoc[];
}

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
  // understretches (host-vein remnants beneath growing organs) are doomed
  // transients — exported organs arrive fully grown, so skip them
  const doomed = new Set([...w.organs.values()].map((o) => o.understretchId).filter((id) => id !== null));
  const veins = [...w.veins.values()].filter((p) => !doomed.has(p.id));
  const veinIndex = new Map(veins.map((p, i) => [p.id, i]));
  const organs = [...w.organs.values()];
  const organIndex = new Map(organs.map((o, i) => [o.id, i]));
  const remapHead = (h: Head): Head =>
    h.type === 'fork'
      ? { ...h, veinId: veinIndex.get(h.veinId) ?? -1 }
      : h.type === 'port'
        ? { ...h, organId: organIndex.get(h.organId) ?? -1 }
        : h;
  const remapTail = (t: Tail): Tail =>
    t.type === 'merge'
      ? { ...t, veinId: veinIndex.get(t.veinId) ?? -1 }
      : t.type === 'organ-in'
        ? { ...t, organId: organIndex.get(t.organId) ?? -1 }
        : t;
  const doc: WorldDoc = {
    rv: 1,
    stick: { ...w.chem.stick },
    veins: veins.map((p) => ({
      cells: p.cells.map((c) => [c.x, c.y] as [number, number]),
      head: remapHead(p.head),
      tail: remapTail(p.tail),
      ...(p.inc.every((v) => v === 1) ? {} : { inc: [...p.inc] }),
    })),
    organs: organs.map((o) => ({
      cx: o.cx,
      cy: o.cy,
      in: [o.portIn.x, o.portIn.y],
      out: [o.portOut.x, o.portOut.y],
      side: [o.portSide.x, o.portSide.y],
      cw: o.sideCW,
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytesToB64(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
}

export async function worldFromCode(chem: Chemistry, code: string): Promise<World> {
  const bytes = b64ToBytes(code.replace(/\s+/g, ''));
  const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  const doc = JSON.parse(json) as WorldDoc;
  if (doc.rv !== 1 || !Array.isArray(doc.veins)) throw new Error('not a recognized world document');

  const w = makeWorld(chem);
  // stickiness is applied at the very end, after everything that can throw
  // — a rejected code must not leave the live chemistry mutated
  const stick: Record<string, number> = {};
  if (doc.stick && typeof doc.stick === 'object') {
    for (const r of chem.radicals) {
      const v = Number(doc.stick[r.id]);
      if (Number.isFinite(v)) stick[r.id] = Math.max(0, Math.min(4, v)); // match the god slider's range
    }
  }

  // organs first (veins reference them); then veins with ids remapped from
  // array indices back to live ids
  const organIds: number[] = [];
  for (const od of Array.isArray(doc.organs) ? doc.organs : []) {
    const mk = ([x, y]: [number, number]): VeinCell => ({ x, y, k: `${x},${y}` });
    const foot = new Set<string>();
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) foot.add(`${od.cx + dx},${od.cy + dy}`);
    }
    const o: Organ = {
      id: w.nextId++,
      cx: od.cx,
      cy: od.cy,
      footprint: foot,
      portIn: mk(od.in),
      portOut: mk(od.out),
      portSide: mk(od.side),
      sideCW: !!od.cw,
      inAccum: null,
      outReady: null,
      sideReady: null,
      growth: GROW_TICKS,
      understretchId: null,
      load: 0,
    };
    w.organs.set(o.id, o);
    organIds.push(o.id);
  }
  const veinIds: number[] = [];
  const pending: Array<{ veinIdx: number; head: Head; tail: Tail }> = [];
  for (const vd of doc.veins) {
    const cells = vd.cells.filter(
      (c): c is [number, number] => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1]),
    );
    // the whole engine assumes veins are 4-connected paths — reject any
    // crafted code whose cells jump
    const connected = cells.every(
      (c, i) => i === 0 || Math.abs(c[0] - cells[i - 1][0]) + Math.abs(c[1] - cells[i - 1][1]) === 1,
    );
    const p = connected
      ? commitVein(w, cells.map(([x, y]) => ({ x, y })), { type: 'open' }, { type: 'open' }, true)
      : null;
    if (p && Array.isArray(vd.inc)) {
      for (let i = 0; i < p.cells.length; i++) {
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
    } else if (head?.type === 'fork' && veinIds[head.veinId] > 0) {
      p.head = { type: 'fork', veinId: veinIds[head.veinId], cellKey: head.cellKey };
    } else if (head?.type === 'port' && organIds[head.organId] > 0) {
      p.head = { type: 'port', organId: organIds[head.organId], port: head.port === 'side' ? 'side' : 'out' };
    }
    if (tail?.type === 'merge' && veinIds[tail.veinId] > 0) {
      p.tail = { type: 'merge', veinId: veinIds[tail.veinId], cellKey: tail.cellKey };
    } else if (tail?.type === 'organ-in' && organIds[tail.organId] > 0) {
      p.tail = { type: 'organ-in', organId: organIds[tail.organId] };
    }
  }
  reindex(w);
  chem.setStickiness(stick);
  return w;
}
