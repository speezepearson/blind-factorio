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
// joined stretch turns yellow and warms as fusion releases bond energy —
// then a radical filter splits survivors from composites. Sources sit at
// (26, 42 + 72·spIdx): R (26,42), G (26,114).
function buildDemo(chem: Chemistry): World {
  const w = makeWorld(chem);
  const R = chem.speciesIndex('R');
  const G = chem.speciesIndex('G');
  // wild anatomy is born incarnate — only player-drawn veins start as ghosts
  const trunk = commitVein(
    w,
    curve([44, 42], [150, 48], [190, 120], [230, 290], [420, 310], [700, 296], [860, 300]),
    { type: 'source', spIdx: R },
    { type: 'open' },
    true,
  )!;
  // ends beside the trunk; the tail merges into it around (230, 290)
  const mergeAt = trunk.pts.reduce((best, pt) =>
    Math.hypot(pt[0] - 230, pt[1] - 290) < Math.hypot(best[0] - 230, best[1] - 290) ? pt : best,
  );
  commitVein(
    w,
    curve([44, 114], [120, 140], [180, 220], [mergeAt[0] - 14, mergeAt[1] - 10]),
    { type: 'source', spIdx: G },
    { type: 'merge', veinId: trunk.id, at: [mergeAt[0], mergeAt[1]] },
    true,
  );
  tryBud(w, [540, 305], { instant: true });
  return w;
}

export const PRESETS: Preset[] = [
  { id: 'demo', name: 'Fuse & filter demo', build: buildDemo },
  { id: 'blank', name: 'Fresh slate', build: (chem) => makeWorld(chem) },
];
