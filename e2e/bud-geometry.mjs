// Continuous budding geometry: the organ disc eats the in-disc stretch of
// a curving vein; ports sit where the curve pierced the membrane; a vein
// terminating inside gets its out port relocated to the rim.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickPt, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// an S-curving vein from the R source; bud in the middle of the curve
await drawVein([[26, 42], [200, 120], [320, 260], [520, 300], [700, 260]]);
await ticks(160); // incarnate fully
await dblClickPt(420, 290);
{
  const info = await worldInfo();
  ok('bud accepted on a curve', info.organs.length === 1);
  const o = info.organs[0];
  const port = (org, key) => org.ports.find((q) => q.key === key).pt;
  ok('in port sits on the membrane', Math.abs(dist(port(o, 'in'), [o.cx, o.cy]) - o.r) < 18);
  ok('out port sits on the membrane', Math.abs(dist(port(o, 'out'), [o.cx, o.cy]) - o.r) < 18);
  ok('ports are distinct wall crossings', dist(port(o, 'in'), port(o, 'out')) > 30);
  // budding is local: feeder attaches immediately; the downstream half
  // stays detached (open/open) until the organ finishes and claims it
  ok('feeder attached, continuation detached', info.veins.some((v) => v.tail === 'organ-in') && info.veins.some((v) => v.head === 'open' && v.tail === 'open'));
}
await ticks(12); // organ grows in, halves trimmed to the membrane
{
  const info = await worldInfo();
  ok('halves trimmed and attached after growth', !info.veins.some((v) => v.head === 'open' && v.tail === 'open'));
  ok('continuation claimed by the out port', info.veins.some((v) => v.head === 'port'));
}
await ticks(80);
{
  const info = await worldInfo();
  ok('organ drinks through its curved feeder', info.organs[0].load > 5000);
}

// a vein that terminates inside the disc: bud accepted, out port relocated
await drawVein([[26, 114], [140, 160], [220, 170]]);
await ticks(60);
await dblClickPt(200, 168);
{
  const info = await worldInfo();
  ok('bud accepted over a terminating vein', info.organs.length === 2);
  const o = info.organs[1];
  const port = (org, key) => org.ports.find((q) => q.key === key).pt;
  ok('terminating vein: out port relocated to the rim', Math.abs(dist(port(o, 'out'), [o.cx, o.cy]) - o.r) < 6);
  ok('relocated out port is away from the in port', dist(port(o, 'out'), port(o, 'in')) > 40);
}

await finish(d);
