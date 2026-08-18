// Ghost veins: player-drawn veins start unreal and only grow in — at 1
// node per 2 ticks — from points of contact with the live network.
// Unconnected ghosts stay ghosts; a later connecting vein incarnates them.
// Fluid vents at the incarnation frontier (a visible open end) but never
// occupies a ghost node.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// a vein floating in open space, touching nothing: stays a ghost forever
await drawVein([[300, 400], [460, 420]]);
await ticks(40);
{
  const info = await worldInfo();
  ok('unconnected vein stays a ghost', info.veins.length === 1 && info.veins[0].incCount === 0);
}

// a vein from the B source incarnates from the source end, ~1 node/2 ticks
await drawVein([[26, 186], [186, 186]]);
await ticks(6);
{
  const info = await worldInfo();
  const v = info.veins.find((p) => p.head === 'source');
  ok('source-fed ghost incarnates from the head', !!v && v.incCount >= 2 && v.incCount <= 5);
}
await ticks(40);
{
  const info = await worldInfo();
  const v = info.veins.find((p) => p.head === 'source');
  ok('fully grown in and carrying B', !!v && v.incCount === v.n && (v.totals.B ?? 0) > 5000);
  const ghost = info.veins.find((p) => p.head === 'open' && p.tail === 'open');
  ok('the floater is still a ghost', !!ghost && ghost.incCount === 0);
}

// connect live network to the floater: fork off the live vein, release ON
// the ghost — once the connector grows in, incarnation jumps the junction
await drawVein([[100, 186], [140, 300], [250, 380], [340, 405]]);
{
  const info = await worldInfo();
  const conn = info.veins.find((p) => p.head === 'fork');
  ok('connector forks the live vein and merges into the ghost', !!conn && conn.tail === 'merge');
}
await ticks(110);
{
  const info = await worldInfo();
  const ghost = info.veins.find((p) => p.head === 'open' && p.tail === 'open');
  ok('junction incarnates the old ghost', !!ghost && ghost.incCount === ghost.n);
  ok('and fluid reaches it through the junction', !!ghost && (ghost.totals.B ?? 0) > 500);
}

// invariant spot-check: fluid only ever occupies incarnate nodes — the
// frontier vents, it never admits
{
  const bad = await page.evaluate(() => {
    const w = window.__veins.world();
    const chem = window.__veins.chem;
    let count = 0;
    for (const p of w.veins.values()) {
      for (let i = 0; i < p.pts.length; i++) {
        let n = 0;
        for (let s = 0; s < chem.nsp; s++) n += p.parcels[i].c[s];
        if (!p.inc[i] && n > 0) count++;
      }
    }
    return count;
  });
  ok('no fluid ever sits in a ghost node', bad === 0);
}

await finish(d);
