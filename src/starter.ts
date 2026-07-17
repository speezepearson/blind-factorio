import { cellKey, mergePumps, orientPath } from './geom';
import { GREEN } from './machines';
import type { Cell, ParamValue, World } from './types';

// Walk axis-aligned segments between waypoints, returning every cell passed.
function pathThrough(waypoints: Cell[]): Cell[] {
  const path: Cell[] = [waypoints[0]];
  for (const wp of waypoints.slice(1)) {
    let [x, y] = path[path.length - 1];
    while (x !== wp[0] || y !== wp[1]) {
      if (x !== wp[0]) x += Math.sign(wp[0] - x);
      else y += Math.sign(wp[1] - y);
      path.push([x, y]);
    }
  }
  return path;
}

// A small working factory: red + green springs feed the reactor, whose black
// output passes through one funnel and merges with more green in a second;
// the resulting blend runs through a green-targeting filter that splits it.
export function buildStarterWorld(w: number, h: number): World {
  const world: World = { w, h, pumps: new Map(), machines: [], nextMachineId: 1 };
  const add = (typeId: string, origin: Cell, params?: Record<string, ParamValue>) => {
    world.machines.push({ id: world.nextMachineId++, typeId, origin, rotation: 0, params });
  };
  const pipe = (...waypoints: Cell[]) => {
    for (const { cell, inSide, outSide } of orientPath(pathThrough(waypoints))) {
      const k = cellKey(cell[0], cell[1]);
      world.pumps.set(k, mergePumps(world.pumps.get(k), { inSide, outSide }));
    }
  };

  add('spring', [20, 30]); // red by default
  add('spring', [55, 30], { color: GREEN });
  add('reactor', [38, 58]);
  add('funnel', [70, 40]);
  add('funnel', [100, 60]);
  add('filter', [125, 58], { target: GREEN });

  pipe([25, 29], [25, 26], [33, 26], [33, 62], [37, 62]); // red spring -> reactor A
  pipe([58, 29], [58, 26], [52, 26], [52, 65], [48, 65]); // green spring -> reactor B
  // reactor C -> first funnel (crosses the green feed at (52,50))
  pipe([40, 57], [40, 50], [68, 50], [68, 42], [69, 42]);
  pipe([85, 42], [90, 42], [90, 62], [99, 62]); // first funnel -> second funnel
  pipe([61, 29], [61, 22], [97, 22], [97, 60], [99, 60]); // green spring -> second funnel
  pipe([115, 62], [124, 62]); // second funnel's blend -> filter
  pipe([155, 60], [161, 60]); // filtrate (pulled toward green), spilling
  pipe([155, 65], [161, 65]); // waste (pushed away from green), spilling

  return world;
}
