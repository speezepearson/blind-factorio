import { commitVein, makeWorld, tryBud } from './world';
import type { World } from './world';
import type { Chemistry } from './chem';

export interface Preset {
  id: string;
  name: string;
  build: (chem: Chemistry) => World;
}

// axis-aligned path through waypoints, inclusive of the first
function pathThrough(waypoints: Array<[number, number]>): Array<{ x: number; y: number }> {
  const path = [{ x: waypoints[0][0], y: waypoints[0][1] }];
  for (const [wx, wy] of waypoints.slice(1)) {
    let { x, y } = path[path.length - 1];
    while (x !== wx || y !== wy) {
      if (x !== wx) x += Math.sign(wx - x);
      else y += Math.sign(wy - y);
      path.push({ x, y });
    }
  }
  return path;
}

// A worked example: an R vein and a G vein merge and run east — the joined
// stretch turns yellow and warms as fusion releases bond energy — then a
// radical filter splits survivors from composites. Sources sit at x=1,
// y = 2 + 4·spIdx (R:2, G:6, B:10).
function buildDemo(chem: Chemistry): World {
  const w = makeWorld(chem);
  const R = chem.speciesIndex('R');
  const G = chem.speciesIndex('G');
  // wild anatomy is born incarnate — only player-drawn veins start as ghosts
  const trunk = commitVein(
    w,
    pathThrough([[2, 2], [8, 2], [8, 14], [40, 14]]),
    { type: 'source', spIdx: R },
    { type: 'open' },
    true,
  )!;
  // ends beside the trunk's x=8 column; the tail merges into cell (8,6)
  commitVein(
    w,
    pathThrough([[2, 6], [7, 6]]),
    { type: 'source', spIdx: G },
    { type: 'merge', veinId: trunk.id, cellKey: '8,6' },
    true,
  );
  tryBud(w, '24,14', { instant: true });
  return w;
}

export const PRESETS: Preset[] = [
  { id: 'demo', name: 'Fuse & filter demo', build: buildDemo },
  { id: 'blank', name: 'Fresh slate', build: (chem) => makeWorld(chem) },
];
