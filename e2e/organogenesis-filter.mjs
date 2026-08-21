// Spontaneous organogenesis: a 2in-2out junction whose inputs hold the
// filter trigger (mix >40% R >30% G <1% RGB; fuel >1% RGB) buds a filter
// by itself — no user input. Then starving it of fuel atrophies it: the
// organ dissolves and the pipes simply rejoin.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo, at } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// R trunk east; G merges in early -> a mixed (but unreacted) trunk
await drawVein([[26, 42], [200, 80], [480, 95], [780, 100]]);
await drawVein([[26, 114], [120, 130], [170, 80]]);
await ticks(220);
{
  const info = await worldInfo();
  ok('junction-free network grows no organs', info.organs.length === 0);
}

// the junction: a fork out of the trunk and the RGB fuel line merging in,
// both near (480, 95) -> 2 inputs (mix, fuel), 2 outputs
await drawVein([[480, 95], [540, 220], [640, 280]]);
await drawVein([[26, 474], [240, 420], [430, 200], [476, 99]]);
await ticks(450); // fuel line incarnates, flow arrives, trigger dwells, organ grows

{
  const info = await worldInfo();
  ok('a filter budded itself at the junction', info.organs.length === 1 && info.organs[0].kind === 'filter');
  ok('it grew in', info.organs[0].growth >= 10);
}
await ticks(250);
const r = await page.evaluate(() => {
  const w = window.__veins.world();
  const chem = window.__veins.chem;
  const o = [...w.organs.values()][0];
  const att = {};
  for (const v of w.veins.values()) {
    if (v.tail.type === 'organ-in' && v.tail.organId === o.id) att[`in:${v.tail.port}`] = v.id;
    if (v.head.type === 'port' && v.head.organId === o.id) att[`out:${v.head.port}`] = v.id;
  }
  const mouth = (key) => {
    const v = [...w.veins.values()].find((q) => q.head.type === 'port' && q.head.port === key);
    if (!v) return null;
    const p = v.parcels[1];
    const sum = (pred) => {
      let n = 0;
      for (let s = 0; s < chem.nsp; s++) if (pred(chem.species[s])) n += p.c[s];
      return n;
    };
    return { singles: sum((sp) => sp.length === 1), composites: sum((sp) => sp.length > 1) };
  };
  return {
    att: Object.keys(att).sort(),
    fuelStock: o.chambers.fuel.c[chem.speciesIndex('RGB')],
    out: mouth('out'),
    side: mouth('side'),
  };
});
ok(
  'all four ports took their veins (in, fuel, out, side)',
  JSON.stringify(r.att) === JSON.stringify(['in:fuel', 'in:in', 'out:out', 'out:side']),
);
ok('the fuel line stocked the reservoir', r.fuelStock > 1000);
ok('out port runs composite-rich', !!r.out && r.out.composites > r.out.singles);
ok('side port runs single-rich', !!r.side && r.side.singles > 3 * r.side.composites);

// ---- atrophy: sever the fuel line; the starving organ dissolves ----
await page.click('button:has-text("Erase")');
{
  const p0 = await at(300, 330);
  const p1 = await at(380, 270);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 10 });
  await page.mouse.up();
}
{
  const info = await worldInfo();
  ok('fuel line severed, organ still alive', info.organs.length === 1);
}
await ticks(900); // reservoir burns out, starvation dwell elapses
{
  const info = await worldInfo();
  ok('starved organ atrophied away', info.organs.length === 0);
  // the pipes rejoined: the trunk runs source -> somewhere again, and no
  // vein is left pointing at a dead organ
  ok(
    'no attachment points at the dead organ',
    !info.veins.some((v) => v.head === 'port' || v.tail === 'organ-in'),
  );
  const trunk = info.veins.find((v) => v.head === 'source' && (v.totals.R ?? 0) > 3000 && (v.totals.G ?? 0) > 3000);
  ok('the rejoined trunk carries the mix through', !!trunk);
}

await finish(d);
