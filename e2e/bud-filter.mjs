// Budding: double-click a straight stretch grows the radical filter, cuts
// the host vein, and its ports route singles vs composites.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickCell, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// R and G merge into a trunk running east at y=14, so the filter gets a
// genuine mixture (R, G, RG) to split. Drawn veins are ghosts: give the
// incarnation front (1 cell / 2 ticks) time to build them in.
await drawVein([[1, 2], [6, 2], [6, 14], [38, 14]]);
await drawVein([[1, 6], [4, 6], [4, 13], [6, 13]]); // releases ON the trunk column: merge
await ticks(130);

// budding is refused on a ghost — but the trunk is grown-in by now
await dblClickCell(22, 14);
{
  const info = await worldInfo();
  ok('bud grew an organ', info.organs.length === 1);
  ok('host vein was cut around it', info.veins.some((v) => v.tail === 'organ-in'));
  ok('understretch survives beneath the growing organ', info.veins.some((v) => v.len === 5 && v.head === 'open' && v.tail === 'open'));
  ok('organ starts ungrown', info.organs[0].growth === 0);
}
await ticks(12); // GROW_TICKS = 10: organ finishes, understretch is collected
{
  const info = await worldInfo();
  ok('grown organ collects the understretch', !info.veins.some((v) => v.len === 5 && v.head === 'open' && v.tail === 'open'));
}

// grow veins from both output ports (out: east of center; rad: north or south)
await drawVein([[24, 14], [34, 14]]);
{
  const info = await worldInfo();
  ok('out-port vein attached', info.veins.some((v) => v.head === 'port'));
}
const sidePort = await page.evaluate(() => {
  const w = window.__veins.world();
  const o = [...w.organs.values()][0];
  return [o.portSide.x, o.portSide.y];
});
const sideDir = sidePort[1] > 14 ? 1 : -1;
await drawVein([sidePort, [sidePort[0], sidePort[1] + sideDir * 6]]);
await ticks(300); // port veins incarnate from the grown organ, then flow
{
  const info = await worldInfo();
  const ports = info.veins.filter((v) => v.head === 'port');
  ok('both ports have veins', ports.length === 2);
  // identify by position: the out vein runs east at y=14
  const outVein = ports.find((v) => v.first[1] === 14);
  const radVein = ports.find((v) => v.first[1] !== 14);
  // Judge at the port mouth (first cell): downstream, chemistry re-runs —
  // free R+G re-fuses in the rad vein and hot RG dissociates in the out
  // vein, so whole-vein totals drift back toward equilibrium by design.
  const singles = (t) => Object.entries(t).filter(([s]) => s.length === 1).reduce((a, [, n]) => a + n, 0);
  const composites = (t) => Object.entries(t).filter(([s]) => s.length > 1).reduce((a, [, n]) => a + n, 0);
  ok(
    'rad port emits (nearly) pure free radicals',
    !!radVein && singles(radVein.firstTotals) > 500 &&
      composites(radVein.firstTotals) < 0.2 * singles(radVein.firstTotals),
  );
  ok(
    'out port emits (nearly) pure composites',
    !!outVein && composites(outVein.firstTotals) > 500 &&
      singles(outVein.firstTotals) < 0.3 * composites(outVein.firstTotals),
  );
  ok(
    'downstream re-equilibration is visible (rad vein grows composites)',
    !!radVein && composites(radVein.totals) > 0,
  );
  if (radVein && outVein) {
    console.log(`  rad mouth: ${JSON.stringify(radVein.firstTotals)} | out mouth: ${JSON.stringify(outVein.firstTotals)}`);
  }
}

await finish(d);
