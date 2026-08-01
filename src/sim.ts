import { DX, DY, cellKey, opposite, orientPath, placeMachine } from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID } from './machines';
import type { Cell, FluidMap, Machine, ParamValue, Pipeline, World } from './types';

const EPS = 1e-4;
const RATE_CAP = 1000;

export interface SimState {
  // pipelineId -> per-cell contents, aligned with Pipeline.cells
  pipeFluids: Map<number, FluidMap[]>;
  junctionFlows: Map<number, FluidMap>; // junctionId -> this tick's summed inflow
  machineIO: Map<number, { inputs: Record<string, FluidMap>; outputs: Record<string, FluidMap> }>;
  machineStates: Map<number, Record<string, unknown>>; // per-machine persistent state
}

export const emptySim = (): SimState => ({
  pipeFluids: new Map(),
  junctionFlows: new Map(),
  machineIO: new Map(),
  machineStates: new Map(),
});

export const placeAll = (world: World): PlacedMachine[] =>
  world.machines.map((m) => placeMachine(m, TYPE_BY_ID[m.typeId]));

// Every machine port edge, keyed by "x,y,side" of the machine-side cell.
export type PortMap = Map<string, { machineId: number; portId: string; kind: 'in' | 'out' }>;
export const portEdgeKey = (x: number, y: number, s: number) => `${x},${y},${s}`;
export function portMapOf(placed: PlacedMachine[]): PortMap {
  const map: PortMap = new Map();
  for (const pm of placed) {
    for (const port of pm.ports) {
      for (const [[x, y], s] of port.edges) {
        map.set(portEdgeKey(x, y, s), { machineId: pm.machine.id, portId: port.def.id, kind: port.def.kind });
      }
    }
  }
  return map;
}

// The most recently drawn pipeline whose tail ends at `cell` unattached — no
// junction under it, no machine in-port past it. Starting a pipe drag there
// picks the pipeline back up and keeps extending it.
export function danglingTailAt(world: World, cell: Cell): Pipeline | null {
  const ports = portMapOf(placeAll(world).filter((pm) => !pm.machine.ghost));
  const junctionCells = new Set(world.junctions.map((j) => cellKey(j.cell[0], j.cell[1])));
  for (let i = world.pipelines.length - 1; i >= 0; i--) {
    const pl = world.pipelines[i];
    if (pl.ghost || pl.cells.length === 0) continue;
    const last = pl.cells[pl.cells.length - 1];
    if (last[0] !== cell[0] || last[1] !== cell[1]) continue;
    if (pl.cells.length > 1 && junctionCells.has(cellKey(last[0], last[1]))) continue;
    const o = orientPath(pl.cells)[pl.cells.length - 1];
    const beyond = ports.get(
      portEdgeKey(last[0] + DX[o.outSide], last[1] + DY[o.outSide], opposite(o.outSide)),
    );
    if (beyond?.kind === 'in') continue;
    return pl;
  }
  return null;
}

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
  // ghosts (unfunded placeholders) take no part in the sim at all
  const placed = placeAll(world).filter((pm) => !pm.machine.ghost);
  const pipelines = world.pipelines.filter((pl) => !pl.ghost);

  const edgeKey = portEdgeKey;
  const portKey = (machineId: number, portId: string) => `${machineId}:${portId}`;
  const portAtEdge = portMapOf(placed);

  const junctionAt = new Map<string, number>(); // cellKey -> junctionId
  for (const j of world.junctions) junctionAt.set(cellKey(j.cell[0], j.cell[1]), j.id);

  // Resolve each pipeline's endpoint attachments; collect deliveries (from
  // last tick's contents) and count each source's consumers. Sources/sinks
  // are keyed "p:machineId:portId" for ports, "j:junctionId" for junctions;
  // a head/tail cell sitting on a junction attaches there, otherwise the
  // cell just beyond the endpoint may be a machine port edge.
  const srcOf = new Map<number, string>(); // pipelineId -> source key
  const consumers = new Map<string, number>(); // source key -> #pipelines drawing
  const deliveries = new Map<string, FluidMap>(); // in-portKey -> summed arrivals
  const junctionFlows = new Map<number, FluidMap>(); // junctionId -> summed arrivals
  for (const pl of pipelines) {
    if (pl.cells.length === 0) continue;
    const oriented = orientPath(pl.cells);
    const first = oriented[0];
    const last = oriented[oriented.length - 1];

    const headJunction = junctionAt.get(cellKey(first.cell[0], first.cell[1]));
    if (headJunction !== undefined) {
      const key = `j:${headJunction}`;
      srcOf.set(pl.id, key);
      consumers.set(key, (consumers.get(key) ?? 0) + 1);
    } else {
      const src = portAtEdge.get(
        edgeKey(first.cell[0] + DX[first.inSide], first.cell[1] + DY[first.inSide], opposite(first.inSide)),
      );
      if (src?.kind === 'out') {
        const key = `p:${portKey(src.machineId, src.portId)}`;
        srcOf.set(pl.id, key);
        consumers.set(key, (consumers.get(key) ?? 0) + 1);
      }
    }

    const arriving = prev.pipeFluids.get(pl.id)?.[pl.cells.length - 1];
    // a single-cell pipeline on a junction only draws from it (no self-loop)
    const tailJunction =
      pl.cells.length > 1 ? junctionAt.get(cellKey(last.cell[0], last.cell[1])) : undefined;
    if (tailJunction !== undefined) {
      const into = junctionFlows.get(tailJunction) ?? {};
      addFluids(into, arriving);
      junctionFlows.set(tailJunction, into);
    } else {
      const dst = portAtEdge.get(
        edgeKey(last.cell[0] + DX[last.outSide], last.cell[1] + DY[last.outSide], opposite(last.outSide)),
      );
      if (dst?.kind === 'in' && arriving) {
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
      if (out && Object.keys(out).length > 0) outputsByPort.set(`p:${portKey(pm.machine.id, port.def.id)}`, out);
    }
  }

  // advance every pipeline one cell
  const pipeFluids: SimState['pipeFluids'] = new Map();
  for (const pl of pipelines) {
    if (pl.cells.length === 0) continue;
    const prevArr = prev.pipeFluids.get(pl.id) ?? [];
    const arr: FluidMap[] = new Array(pl.cells.length);
    for (let i = pl.cells.length - 1; i > 0; i--) arr[i] = prevArr[i - 1] ?? {};
    const intake: FluidMap = {};
    const srcKey = srcOf.get(pl.id);
    const out = srcKey?.startsWith('j:')
      ? junctionFlows.get(Number(srcKey.slice(2)))
      : srcKey
        ? outputsByPort.get(srcKey)
        : undefined;
    if (srcKey && out) {
      const share = Math.max(1, consumers.get(srcKey) ?? 1);
      for (const [wl, rate] of Object.entries(out)) {
        if (rate / share > EPS) intake[wl] = rate / share;
      }
    }
    arr[0] = intake;
    pipeFluids.set(pl.id, arr);
  }

  deployFabricators(world, placed, machineStates);

  return { pipeFluids, junctionFlows, machineIO, machineStates };
}

// A fabricator whose build is done spends the finished item on a ghost of
// the matching kind, then starts over. Machine ghosts fill whole (nearest
// first); pipe ghosts fill one cell at a time from their intake end,
// extending an adjacent dangling real pipeline when there is one so a
// part-built route grows as a single pipeline. With no ghost to fill, the
// item stays queued (the fab holds `ready` until one appears).
function deployFabricators(world: World, placed: PlacedMachine[], states: SimState['machineStates']) {
  for (const pm of placed) {
    if (pm.machine.typeId !== 'fabricator') continue;
    const st = states.get(pm.machine.id) as
      | { making?: string; progress?: number; ready?: boolean }
      | undefined;
    if (!st?.ready) continue;
    if (deployOne(world, String(st.making ?? 'pipe'), pm.machine.origin)) {
      st.ready = false;
      st.progress = 0;
    }
  }
}

function deployOne(world: World, kind: string, near: Cell): boolean {
  if (kind === 'pipe') {
    const gp = world.pipelines.find((pl) => pl.ghost && pl.cells.length > 0);
    if (!gp) return false;
    const head = gp.cells[0];
    gp.cells = gp.cells.slice(1);
    if (gp.cells.length === 0) world.pipelines = world.pipelines.filter((pl) => pl.id !== gp.id);
    for (let s = 0; s < 4; s++) {
      const pl = danglingTailAt(world, [head[0] + DX[s], head[1] + DY[s]]);
      if (pl) {
        pl.cells = [...pl.cells, head];
        return true;
      }
    }
    world.pipelines.push({ id: world.nextPipelineId++, cells: [head] });
    return true;
  }
  const ghosts = world.machines.filter((m) => m.ghost && m.typeId === kind);
  if (ghosts.length === 0) return false;
  const dist = (m: Machine) => Math.abs(m.origin[0] - near[0]) + Math.abs(m.origin[1] - near[1]);
  ghosts.sort((a, b) => dist(a) - dist(b));
  delete ghosts[0].ghost;
  return true;
}
