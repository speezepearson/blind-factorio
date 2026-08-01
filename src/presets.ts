import { buildStarterWorld } from './starter';
import type { Cell, ParamValue, World } from './types';

export interface Preset {
  id: string;
  name: string;
  build: (w: number, h: number) => World;
}

function emptyWorld(w: number, h: number): World {
  return { w, h, pumps: new Map(), machines: [], nextMachineId: 1 };
}

// Two sources and two sinks, all four of which *look* the same chartreuse
// green. One source is pure 556 nm light; the other is red 650 nm + green
// 540 nm flowing together, whose combined light is nearly identical. Each
// sink wants one of those mixtures and lights up only when fed the right
// wavelengths, so the player has to work out which lookalike is which (a
// blender averages 650+540 into ~595 nm orange — visibly different! — so
// telling them apart is possible, but takes thought).
function buildLookalikeWorld(w: number, h: number): World {
  const world = emptyWorld(w, h);
  const add = (typeId: string, origin: Cell, params?: Record<string, ParamValue>) => {
    world.machines.push({ id: world.nextMachineId++, typeId, origin, rotation: 0, params });
  };
  add('spring', [20, 25], { mixture: [{ wl: 556, rate: 2 }] });
  add('spring', [20, 70], { mixture: [{ wl: 650, rate: 1 }, { wl: 540, rate: 1 }] });
  add('sink', [135, 25], { colorA: 650, colorB: 540, mixB: 0.5, tol: 12 });
  add('sink', [135, 70], { colorA: 556, tol: 12 });
  return world;
}

export const PRESETS: Preset[] = [
  { id: 'starter', name: 'Starter tour', build: buildStarterWorld },
  { id: 'lookalike', name: 'Green, two ways', build: buildLookalikeWorld },
  { id: 'blank', name: 'Blank canvas', build: emptyWorld },
];
