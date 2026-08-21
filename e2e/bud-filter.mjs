// Budding: double-click a vein grows the radical filter, cuts the host,
// and its ports route singles vs composites.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickPt, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// R and G merge into a trunk running east, so the filter gets a genuine
// mixture (R, G, RG) to split. Drawn veins are ghosts: give the incarnation
// front (1 node / 2 ticks) time to build them in.
await drawVein([[26, 42], [300, 60], [640, 70]]);
await drawVein([[26, 114], [140, 120], [200, 55]]);
await ticks(140);

await dblClickPt(450, 65);
{
  const info = await worldInfo();
  ok('bud grew an organ', info.organs.length === 1);
  ok('host vein was cut around it', info.veins.some((v) => v.tail === 'organ-in'));
  // the bud snips the host locally: the downstream half is detached
  // (open head) until the organ finishes and claims it
  ok('downstream half detached beneath the growing organ', info.veins.some((v) => v.head === 'open' && v.tail === 'open'));
  ok('organ starts ungrown', info.organs[0].growth === 0);
}
await ticks(12); // GROW_TICKS = 10: organ finishes and trims to its membrane
{
  const info = await worldInfo();
  ok('grown organ claims the downstream half', !info.veins.some((v) => v.head === 'open' && v.tail === 'open'));
}

// feed the organ: a hot filter burns through its yolk in ~70 ticks and
// atrophy is snappy, so an unfueled organ would dissolve mid-test. The
// fuel port lands deterministically at (448,12); approach along the top.
await drawVein([[26, 474], [120, 300], [220, 100], [330, 14], [440, 10], [448, 12]]);
{
  const fueled = await page.evaluate(() =>
    [...window.__veins.world().veins.values()].some((v) => v.tail.type === 'organ-in' && v.tail.port === 'fuel'),
  );
  ok('fuel line took the fuel port', fueled);
}

// grow veins from both output ports, straight away from the organ center
const ports = await page.evaluate(() => {
  const o = [...window.__veins.world().organs.values()][0];
  const at = (key) => o.ports.find((p) => p.key === key).pt;
  return { c: o.c, out: at('out'), side: at('side') };
});
const away = (pt, c, len) => {
  const dx = pt[0] - c[0];
  const dy = pt[1] - c[1];
  const m = Math.hypot(dx, dy);
  return [pt[0] + (dx / m) * len, pt[1] + (dy / m) * len];
};
await drawVein([ports.out, away(ports.out, ports.c, 130)]);
await drawVein([ports.side, away(ports.side, ports.c, 110)]);
await ticks(320);
{
  const info = await worldInfo();
  const portVeins = info.veins.filter((v) => v.head === 'port');
  ok('both ports have veins', portVeins.length === 2);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const outVein = portVeins.reduce((best, v) => (dist(v.first, ports.out) < dist(best.first, ports.out) ? v : best));
  const radVein = portVeins.find((v) => v !== outVein);
  // Judge at the port mouth (first node): downstream, chemistry re-runs —
  // free R+G re-fuses in the rad vein and hot RG dissociates in the out
  // vein, so whole-vein totals drift back toward equilibrium by design.
  const singles = (t) => Object.entries(t).filter(([s]) => s.length === 1).reduce((a, [, n]) => a + n, 0);
  const composites = (t) => Object.entries(t).filter(([s]) => s.length > 1).reduce((a, [, n]) => a + n, 0);
  ok(
    'rad port emits (nearly) pure free radicals',
    !!radVein && singles(radVein.firstTotals) > 500 &&
      composites(radVein.firstTotals) < 0.2 * singles(radVein.firstTotals),
  );
  // inert-pipes: the out stream is composite-DOMINATED, not pure — the out
  // chamber is one of the only places chemistry runs, so hot RG partially
  // cracks back to R+G right there before emission (chamber equilibrium)
  ok(
    'out port emits mostly composites',
    !!outVein && composites(outVein.firstTotals) > 500 &&
      singles(outVein.firstTotals) < 0.8 * composites(outVein.firstTotals),
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
