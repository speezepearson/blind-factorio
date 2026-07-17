import { TYPE_BY_ID } from './machines';
import type { Pump, World } from './types';

// World <-> shareable code: JSON, deflated, base64.

interface WorldDocV1 {
  v: 1;
  w: number;
  h: number;
  machines: World['machines'];
  pumps: Array<[string, Pump[]]>;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function worldToCode(world: World): Promise<string> {
  const doc: WorldDocV1 = {
    v: 1,
    w: world.w,
    h: world.h,
    machines: world.machines,
    pumps: [...world.pumps.entries()],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytesToB64(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
}

export async function worldFromCode(code: string): Promise<World> {
  const bytes = b64ToBytes(code.replace(/\s+/g, ''));
  const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  const doc = JSON.parse(json) as WorldDocV1;
  if (doc.v !== 1 || !Array.isArray(doc.machines) || !Array.isArray(doc.pumps)) {
    throw new Error('not a v1 world document');
  }
  const machines = doc.machines.filter((m) => TYPE_BY_ID[m.typeId]);
  const isSide = (s: unknown) => typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 3;
  const pumps = new Map<string, Pump[]>();
  for (const [k, list] of doc.pumps) {
    const good = (list ?? []).filter((p) => isSide(p.inSide) && isSide(p.outSide));
    if (good.length > 0) pumps.set(k, good);
  }
  return {
    w: doc.w,
    h: doc.h,
    machines,
    pumps,
    nextMachineId: machines.reduce((a, m) => Math.max(a, m.id), 0) + 1,
  };
}
