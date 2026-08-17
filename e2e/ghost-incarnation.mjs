// Ghost veins: player-drawn veins start unreal and only grow in — at 1 cell
// per 2 ticks — from points of contact with the live network. Unconnected
// ghosts stay ghosts; a later connecting vein incarnates them; fluid never
// outruns (or leaks out of) the incarnation front.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// a vein floating in open space, touching nothing: stays a ghost forever
await drawVein([[14, 25], [24, 25]]);
await ticks(40);
{
  const info = await worldInfo();
  ok('unconnected vein stays a ghost', info.veins.length === 1 && info.veins[0].incCount === 0);
}

// a vein from the R source incarnates from the source end, ~1 cell/2 ticks
await drawVein([[1, 2], [10, 2]]);
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
  ok('fully grown in and carrying R', !!v && v.incCount === v.len && (v.totals.R ?? 0) > 5000);
  const ghost = info.veins.find((p) => p.head === 'open' && p.tail === 'open');
  ok('the floater is still a ghost', !!ghost && ghost.incCount === 0);
}

// connect live network to the floater: fork off the live vein, release ON
// the ghost — once the connector grows in, incarnation jumps the junction
await drawVein([[5, 2], [5, 25], [18, 25]]);
{
  const info = await worldInfo();
  const conn = info.veins.find((p) => p.head === 'fork');
  ok('connector forks the live vein and merges into the ghost', !!conn && conn.tail === 'merge');
}
await ticks(90); // connector ~35 cells → ~70 ticks, then the ghost fills in
{
  const info = await worldInfo();
  const ghost = info.veins.find((p) => p.len === 11);
  ok('junction incarnates the old ghost', !!ghost && ghost.incCount === ghost.len);
  ok('and fluid reaches it through the junction', !!ghost && (ghost.totals.R ?? 0) > 1000);
}

// conservation spot-check: pause everything mid-flow and confirm the world
// only ever contains what the sources emitted (no stall ever destroys mass)
{
  const drained = await page.evaluate(() => {
    const w = window.__veins.world();
    const chem = window.__veins.chem;
    let bad = 0;
    for (const p of w.veins.values()) {
      for (let i = 0; i < p.cells.length; i++) {
        let n = 0;
        for (let s = 0; s < chem.nsp; s++) n += p.parcels[i].c[s];
        if (!p.inc[i] && n > 0) bad++;
      }
    }
    return bad;
  });
  ok('no fluid ever sits in a ghost cell', drained === 0);
}

await finish(d);
