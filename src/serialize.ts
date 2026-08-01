import { TYPE_BY_ID, defaultBudget } from './machines';
import type { Budget, Pipeline, World } from './types';

// World <-> shareable code: JSON, deflated, base64.
//
// Known limitation, by design: only world *structure* is serialized (machines,
// params, pipelines). Sim fluid and per-machine internal state (e.g. a
// buffer's contents) are not — importing re-runs prewarm() to regenerate
// flow, so a buffer shared mid-drain arrives empty and refills naturally.

// v2: pipelines replaced per-cell pumps. v1 codes still load their machines,
// but their pumps are dropped (the old cell-pump model has no translation
// worth keeping in a prototype). v3 added the player budget and ghost flags;
// pre-v3 codes get a roomy default budget.
interface WorldDoc {
  v: 1 | 2 | 3;
  w: number;
  h: number;
  machines: World['machines'];
  pipelines?: Pipeline[];
  junctions?: World['junctions'];
  budget?: Budget;
}

// URL-safe base64 (- and _ instead of + and /) so codes survive in URL
// fragments; decoding accepts either alphabet and missing padding.
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

export async function worldToCode(world: World): Promise<string> {
  const doc: WorldDoc = {
    v: 3,
    w: world.w,
    h: world.h,
    machines: world.machines,
    pipelines: world.pipelines,
    junctions: world.junctions,
    budget: world.budget,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytesToB64(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
}

export async function worldFromCode(code: string): Promise<World> {
  const bytes = b64ToBytes(code.replace(/\s+/g, ''));
  const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  const doc = JSON.parse(json) as WorldDoc;
  if ((doc.v !== 1 && doc.v !== 2 && doc.v !== 3) || !Array.isArray(doc.machines)) {
    throw new Error('not a recognized world document');
  }
  const machines = doc.machines.filter((m) => TYPE_BY_ID[m.typeId]);
  const isCell = (c: unknown): c is [number, number] =>
    Array.isArray(c) && c.length === 2 && c.every((n) => Number.isInteger(n));
  const pipelines: Pipeline[] = (Array.isArray(doc.pipelines) ? doc.pipelines : [])
    .filter((pl) => Array.isArray(pl?.cells) && pl.cells.length > 0 && pl.cells.every(isCell))
    .map((pl, i) => ({ id: i + 1, cells: pl.cells, ...(pl.ghost === true ? { ghost: true } : {}) }));
  const junctions = (Array.isArray(doc.junctions) ? doc.junctions : [])
    .filter((j) => isCell(j?.cell))
    .map((j, i) => ({ id: i + 1, cell: j.cell }));
  const budget = defaultBudget();
  if (doc.budget && typeof doc.budget === 'object') {
    if (Number.isFinite(doc.budget.pipe)) budget.pipe = Math.max(0, doc.budget.pipe);
    if (doc.budget.machines && typeof doc.budget.machines === 'object') {
      budget.machines = {};
      for (const [k, v] of Object.entries(doc.budget.machines)) {
        if (TYPE_BY_ID[k] && Number.isFinite(v)) budget.machines[k] = Math.max(0, v);
      }
    }
  }
  return {
    w: doc.w,
    h: doc.h,
    machines,
    pipelines,
    junctions,
    budget,
    nextMachineId: machines.reduce((a, m) => Math.max(a, m.id), 0) + 1,
    nextPipelineId: pipelines.length + 1,
    nextJunctionId: junctions.length + 1,
  };
}
