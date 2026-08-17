// Generalized budding: no straightness requirement. The organ eats the
// contiguous in-footprint stretch (bends and all); ports sit where the vein
// crossed the wall; a vein terminating inside gets its out port relocated.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickCell, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// an L-shaped vein from the R source; bud ON the bend at (14,3): the old
// rule (5 straight cells centered here) would refuse this
await drawVein([[1, 2], [14, 2], [14, 12]]);
await ticks(60); // incarnate fully
await dblClickCell(14, 3);
{
  const info = await worldInfo();
  ok('bud accepted on a bend', info.organs.length === 1);
  const ports = await page.evaluate(() => {
    const o = [...window.__veins.world().organs.values()][0];
    return { in: [o.portIn.x, o.portIn.y], out: [o.portOut.x, o.portOut.y] };
  });
  ok('in port where the vein entered the wall', ports.in[0] === 12 && ports.in[1] === 2);
  ok('out port where the vein left the wall', ports.out[0] === 14 && ports.out[1] === 5);
  ok('feeder and continuation both attached', info.veins.some((v) => v.tail === 'organ-in') && info.veins.some((v) => v.head === 'port'));
}
await ticks(12); // organ grows in, understretch collected
{
  const info = await worldInfo();
  ok('bent understretch collected after growth', !info.veins.some((v) => v.head === 'open' && v.tail === 'open'));
}
// flow passes through the bend-budded organ (filter passes nothing for pure
// R — all singles exit the side port — so probe the organ's intake instead)
await ticks(60);
{
  const load = await page.evaluate(() => [...window.__veins.world().organs.values()][0].load);
  ok('organ drinks through its relocated in port', load > 5000);
}

// a vein that terminates inside the footprint: bud accepted, out port
// relocated to the ring
await drawVein([[1, 6], [8, 6]]);
await ticks(30);
await dblClickCell(7, 6);
{
  const info = await worldInfo();
  ok('bud accepted over a terminating vein', info.organs.length === 2);
  const o2 = await page.evaluate(() => {
    const o = [...window.__veins.world().organs.values()][1];
    return { in: [o.portIn.x, o.portIn.y], out: [o.portOut.x, o.portOut.y] };
  });
  ok('in port at the entry cell', o2.in[0] === 5 && o2.in[1] === 6);
  const onRing = Math.max(Math.abs(o2.out[0] - 7), Math.abs(o2.out[1] - 6)) === 2;
  ok('terminating vein: out port relocated to the wall', onRing && !(o2.out[0] === 5 && o2.out[1] === 6));
}

await finish(d);
