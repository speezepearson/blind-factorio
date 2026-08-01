import { DX, DY, opposite, orientPath, placeMachine } from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID } from './machines';
import type { FluidMap, ParamValue, World } from './types';

const EPS = 1e-4;
const RATE_CAP = 1000;

export interface SimState {
  // pipelineId -> per-cell contents, aligned with Pipeline.cells
  pipeFluids: Map<number, FluidMap[]>;
  machineIO: Map<number, { inputs: Record<string, FluidMap>; outputs: Record<string, FluidMap> }>;
  machineStates: Map<number, Record<string, unknown>>; // per-machine persistent state
}

export const emptySim = (): SimState => ({
  pipeFluids: new Map(),
  machineIO: new Map(),
  machineStates: new Map(),
});

export const placeAll = (world: World): PlacedMachine[] =>
  world.machines.map((m) => placeMachine(m, TYPE_BY_ID[m.typeId]));

function addFluids(into: FluidMap, from: FluidMap | undefined) {
  if (!from) return;
  for (const [wl, rate] of Object.entries(from)) {
    if (rate > EPS) into[wl] = (into[wl] ?? 0) + rate;
  }
}

// One synchronous propagation step. Pipelines are directed machine-to-machine
// edges: each tick, a pipeline's contents shift one cell toward its far end;
// whatever falls off the end is delivered to the attached in-port (reading
// last tick's contents), and the head cell refills from the attached
// out-port's freshly computed output, split evenly among the pipelines
// drawing from that port.
export function step(world: World, prev: SimState, dt = 0.11): SimState {
  const placed = placeAll(world);

  // every machine port edge, keyed by "x,y,side" of the machine-side cell
  const edgeKey = (x: number, y: number, s: number) => `${x},${y},${s}`;
  const portKey = (machineId: number, portId: string) => `${machineId}:${portId}`;
  const portAtEdge = new Map<string, { machineId: number; portId: string; kind: 'in' | 'out' }>();
  for (const pm of placed) {
    for (const port of pm.ports) {
      for (const [[x, y], s] of port.edges) {
        portAtEdge.set(edgeKey(x, y, s), { machineId: pm.machine.id, portId: port.def.id, kind: port.def.kind });
      }
    }
  }

  // Resolve each pipeline's endpoint attachments; collect deliveries (from
  // last tick's contents) and count each out-port's consumers.
  const srcOf = new Map<number, string>(); // pipelineId -> out-portKey
  const consumers = new Map<string, number>(); // out-portKey -> #pipelines drawing
  const deliveries = new Map<string, FluidMap>(); // in-portKey -> summed arrivals
  for (const pl of world.pipelines) {
    if (pl.cells.length === 0) continue;
    const oriented = orientPath(pl.cells);
    const first = oriented[0];
    const last = oriented[oriented.length - 1];
    const src = portAtEdge.get(
      edgeKey(first.cell[0] + DX[first.inSide], first.cell[1] + DY[first.inSide], opposite(first.inSide)),
    );
    if (src?.kind === 'out') {
      const key = portKey(src.machineId, src.portId);
      srcOf.set(pl.id, key);
      consumers.set(key, (consumers.get(key) ?? 0) + 1);
    }
    const dst = portAtEdge.get(
      edgeKey(last.cell[0] + DX[last.outSide], last.cell[1] + DY[last.outSide], opposite(last.outSide)),
    );
    if (dst?.kind === 'in') {
      const arriving = prev.pipeFluids.get(pl.id)?.[pl.cells.length - 1];
      if (arriving) {
        const key = portKey(dst.machineId, dst.portId);
        const into = deliveries.get(key) ?? {};
        addFluids(into, arriving);
        deliveries.set(key, into);
      }
    }
  }

  const machineIO: SimState['machineIO'] = new Map();
  // carry forward state for machines that still exist (dropping the rest)
  const machineStates: SimState['machineStates'] = new Map();
  const outputsByPort = new Map<string, FluidMap>();
  for (const pm of placed) {
    const inputs: Record<string, FluidMap> = {};
    for (const port of pm.ports) {
      inputs[port.def.id] = deliveries.get(portKey(pm.machine.id, port.def.id)) ?? {};
    }

    const params: Record<string, ParamValue> = {};
    for (const pd of pm.type.params ?? []) params[pd.key] = pd.default;
    Object.assign(params, pm.machine.params);

    const state = prev.machineStates.get(pm.machine.id) ?? {};
    machineStates.set(pm.machine.id, state);

    let outputs: Record<string, FluidMap>;
    try {
      outputs = pm.type.compute(inputs, params, { dt, state }) ?? {};
    } catch {
      outputs = {};
    }
    for (const fm of Object.values(outputs)) {
      for (const [wl, rate] of Object.entries(fm)) {
        if (!Number.isFinite(rate) || rate <= EPS) delete fm[wl];
        else fm[wl] = Math.min(rate, RATE_CAP);
      }
    }
    machineIO.set(pm.machine.id, { inputs, outputs });

    for (const port of pm.ports) {
      const out = outputs[port.def.id];
      if (out && Object.keys(out).length > 0) outputsByPort.set(portKey(pm.machine.id, port.def.id), out);
    }
  }

  // advance every pipeline one cell
  const pipeFluids: SimState['pipeFluids'] = new Map();
  for (const pl of world.pipelines) {
    if (pl.cells.length === 0) continue;
    const prevArr = prev.pipeFluids.get(pl.id) ?? [];
    const arr: FluidMap[] = new Array(pl.cells.length);
    for (let i = pl.cells.length - 1; i > 0; i--) arr[i] = prevArr[i - 1] ?? {};
    const intake: FluidMap = {};
    const srcKey = srcOf.get(pl.id);
    const out = srcKey ? outputsByPort.get(srcKey) : undefined;
    if (srcKey && out) {
      const share = Math.max(1, consumers.get(srcKey) ?? 1);
      for (const [wl, rate] of Object.entries(out)) {
        if (rate / share > EPS) intake[wl] = rate / share;
      }
    }
    arr[0] = intake;
    pipeFluids.set(pl.id, arr);
  }

  return { pipeFluids, machineIO, machineStates };
}
