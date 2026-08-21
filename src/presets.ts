import { commitVein, makeWorld, tryBud } from './world';
import type { World } from './world';
import type { Chemistry } from './chem';
import { SEG, resample, smooth } from './geom';
import type { Pt } from './geom';

export interface Preset {
  id: string;
  name: string;
  build: (chem: Chemistry) => World;
}

// gentle organic polyline through waypoints, resampled to node spacing
const curve = (...waypoints: Pt[]): Pt[] => resample(smooth(waypoints, 3), SEG);

// A worked example: an R vein and a G vein merge and meander east — the
// joined stretch runs yellow (mixed, inert in the pipe) — then a radical
// filter fuses and splits it, fed fuel from the weak RGB wellhead at the
// bottom of the map. Sources sit at (26, 42 + 72·spIdx): R (26,42),
// G (26,114), … RGB (26,474).
function buildDemo(chem: Chemistry): World {
  const w = makeWorld(chem);
  const R = chem.speciesIndex('R');
  const G = chem.speciesIndex('G');
  const RGB = chem.speciesIndex('RGB');
  // wild anatomy is born incarnate — only player-drawn veins start as ghosts
  const trunk = commitVein(
    w,
    curve([44, 42], [150, 48], [190, 120], [230, 290], [420, 310], [700, 296], [860, 300]),
    { type: 'source', spIdx: R },
    { type: 'open' },
    true,
  )!;
  // merges into the trunk around (230, 290), terminating exactly on the
  // junction node (the same invariant player-drawn merges get)
  const mergeAt = trunk.pts.reduce((best, pt) =>
    Math.hypot(pt[0] - 230, pt[1] - 290) < Math.hypot(best[0] - 230, best[1] - 290) ? pt : best,
  );
  commitVein(
    w,
    curve([44, 114], [120, 140], [180, 220], [mergeAt[0], mergeAt[1]]),
    { type: 'source', spIdx: G },
    { type: 'merge', veinId: trunk.id, at: [mergeAt[0], mergeAt[1]] },
    true,
  );
  tryBud(w, [540, 305], { instant: true });
  // fuel line: the RGB wellhead trickles into the filter's fuel port,
  // approaching from the port's outward side (never tunneling under the
  // organ body — the same route a player's pen would have to take)
  const organ = [...w.organs.values()][0];
  const fuel = organ.ports.find((p) => p.key === 'fuel')!;
  const outward: Pt = [
    fuel.pt[0] + (fuel.pt[0] - organ.c[0]) * 1.6,
    fuel.pt[1] + (fuel.pt[1] - organ.c[1]) * 1.6,
  ];
  const fuelPts = curve([44, 474], [200, 520], [380, 480], outward, [fuel.pt[0], fuel.pt[1]]);
  while (fuelPts.length && Math.hypot(fuelPts[fuelPts.length - 1][0] - fuel.pt[0], fuelPts[fuelPts.length - 1][1] - fuel.pt[1]) < 8) fuelPts.pop();
  fuelPts.push([fuel.pt[0], fuel.pt[1]]);
  commitVein(
    w,
    fuelPts,
    { type: 'source', spIdx: RGB },
    { type: 'organ-in', organId: organ.id, port: 'fuel' },
    true,
  );
  return w;
}

export const PRESETS: Preset[] = [
  { id: 'demo', name: 'Fuse & filter demo', build: buildDemo },
  { id: 'blank', name: 'Fresh slate', build: (chem) => makeWorld(chem) },
];
