import { DX, DY, cellKey, opposite, parseKey, placeMachine } from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID, dominant } from './machines';
import type { Flow, FluidMap, World } from './types';

const EPS = 1e-4;
const RATE_CAP = 1000;

export interface SimState {
  pumpFluids: Map<string, Flow | null>;
  machineIO: Map<number, { inputs: Record<string, FluidMap>; outputs: Record<string, FluidMap> }>;
}

export const emptySim = (): SimState => ({ pumpFluids: new Map(), machineIO: new Map() });

export const placeAll = (world: World): PlacedMachine[] =>
  world.machines.map((m) => placeMachine(m, TYPE_BY_ID[m.typeId]));

function addFluid(into: FluidMap, color: string, rate: number) {
  if (rate > EPS) into[color] = (into[color] ?? 0) + rate;
}

// One synchronous propagation step. Machine port inputs are read from last
// tick's pump contents; machine outputs are recomputed and immediately visible
// to pumps drawing from them; pump-to-pump flow advances one cell per tick.
export function step(world: World, prev: SimState): SimState {
  const placed = placeAll(world);
  const pumpAt = (x: number, y: number) => world.pumps.get(cellKey(x, y));

  const machineIO: SimState['machineIO'] = new Map();
  // Machine-boundary edges that currently emit fluid, keyed "x,y,side",
  // with how many pumps are drawing from that port (output is split evenly).
  const emitting = new Map<string, { fluids: FluidMap; consumers: number }>();

  for (const pm of placed) {
    const inputs: Record<string, FluidMap> = {};
    for (const port of pm.ports) {
      const fm: FluidMap = {};
      for (const [[x, y], side] of port.edges) {
        const nx = x + DX[side];
        const ny = y + DY[side];
        const p = pumpAt(nx, ny);
        if (p && p.outSide === opposite(side)) {
          const f = prev.pumpFluids.get(cellKey(nx, ny));
          if (f) addFluid(fm, f.color, f.rate);
        }
      }
      inputs[port.def.id] = fm;
    }

    let outputs: Record<string, FluidMap>;
    try {
      outputs = pm.type.compute(inputs) ?? {};
    } catch {
      outputs = {};
    }
    for (const fm of Object.values(outputs)) {
      for (const [color, rate] of Object.entries(fm)) {
        if (!Number.isFinite(rate) || rate <= EPS) delete fm[color];
        else fm[color] = Math.min(rate, RATE_CAP);
      }
    }
    machineIO.set(pm.machine.id, { inputs, outputs });

    for (const port of pm.ports) {
      const out = outputs[port.def.id];
      if (!out || Object.keys(out).length === 0) continue;
      const info = { fluids: out, consumers: 0 };
      for (const [[x, y], side] of port.edges) {
        const nx = x + DX[side];
        const ny = y + DY[side];
        const p = pumpAt(nx, ny);
        if (p && p.inSide === opposite(side)) info.consumers++;
        emitting.set(`${x},${y},${side}`, info);
      }
    }
  }

  const pumpFluids: SimState['pumpFluids'] = new Map();
  for (const [k, pump] of world.pumps) {
    const [x, y] = parseKey(k);
    const s = pump.inSide;
    const nx = x + DX[s];
    const ny = y + DY[s];
    const fm: FluidMap = {};

    const np = pumpAt(nx, ny);
    if (np && np.outSide === opposite(s)) {
      const f = prev.pumpFluids.get(cellKey(nx, ny));
      if (f) addFluid(fm, f.color, f.rate);
    }
    const src = emitting.get(`${nx},${ny},${opposite(s)}`);
    if (src) {
      const share = Math.max(1, src.consumers);
      for (const [color, rate] of Object.entries(src.fluids)) addFluid(fm, color, rate / share);
    }

    pumpFluids.set(k, dominant(fm));
  }

  return { pumpFluids, machineIO };
}
