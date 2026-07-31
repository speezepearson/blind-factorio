import { BLUE, MAGENTA, RED } from './machines';
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

// Two sources and two sinks, all four of which *look* magenta. One source is
// pure magenta pigment, the other is red + blue flowing together — visually
// identical in a pipe. Each sink wants one of those mixtures and lights up
// only when fed the right pigments, so the player has to work out which
// lookalike is which (a blender turns red+blue into true magenta; nothing
// turns magenta back).
function buildMagentaWorld(w: number, h: number): World {
  const world = emptyWorld(w, h);
  const add = (typeId: string, origin: Cell, params?: Record<string, ParamValue>) => {
    world.machines.push({ id: world.nextMachineId++, typeId, origin, rotation: 0, params });
  };
  add('spring', [20, 25], { color: MAGENTA });
  add('spring', [20, 70], { color: RED, colorB: BLUE, mixB: 0.5 });
  add('sink', [135, 25], { colorA: RED, colorB: BLUE, mixB: 0.5 });
  add('sink', [135, 70], { colorA: MAGENTA });
  return world;
}

export const PRESETS: Preset[] = [
  { id: 'starter', name: 'Starter tour', build: buildStarterWorld },
  { id: 'magenta', name: 'Magenta, two ways', build: buildMagentaWorld },
  { id: 'blank', name: 'Blank canvas', build: emptyWorld },
];
