// The branch's law: parcels in pipes are sealed sample vials. No reactions
// (a mixed R+G trunk never grows RG), no heat flow (a hot parcel rides the
// whole vein without cooling). Organs are the only chemistry/heat sites.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, pause, ticks } = d;
await pause();
await ticks(300); // the demo: R+G merge into a trunk feeding the filter

const r = await page.evaluate(() => {
  const w = window.__veins.world();
  const chem = window.__veins.chem;
  const idxRG = chem.speciesIndex('RG');
  // the R+G trunk, not the RGB fuel line (both run source -> organ-in now)
  const trunk = [...w.veins.values()].find(
    (v) => v.head.type === 'source' && v.tail.type === 'organ-in' && v.tail.port === 'in',
  );
  const outV = [...w.veins.values()].find((v) => v.head.type === 'port' && v.head.port === 'out');
  let trunkRG = 0;
  let trunkR = 0;
  let trunkG = 0;
  for (const pc of trunk.parcels) {
    trunkRG += pc.c[idxRG];
    trunkR += pc.c[chem.speciesIndex('R')];
    trunkG += pc.c[chem.speciesIndex('G')];
  }
  // temperatures of the out vein's OCCUPIED parcels, head to tail
  const temps = outV.parcels
    .filter((pc) => pc.c.some((n) => n > 0))
    .map((pc) => window.__veins.tempOf(pc));
  let outRG = 0;
  for (const pc of outV.parcels) outRG += pc.c[idxRG];
  return { trunkR, trunkG, trunkRG, outRG, tempHead: temps[0], tempTail: temps[temps.length - 1] };
});

ok('trunk mixes R and G after the merge', r.trunkR > 5000 && r.trunkG > 5000);
ok('pipes never react: zero RG in the trunk', r.trunkRG === 0);
ok('the organ is where fusion happens: RG flows from its out port', r.outRG > 1000);
ok('fusion heat leaves the organ hot', r.tempHead > 1.2);
ok(
  'pipes never cool: temperature survives the whole vein',
  Math.abs(r.tempHead - r.tempTail) < 0.25 * (r.tempHead - 1),
);
console.log(`  out vein temps: head ${r.tempHead.toFixed(2)} -> tail ${r.tempTail.toFixed(2)}`);

await finish(d);
