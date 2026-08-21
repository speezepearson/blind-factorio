// Spontaneous heat exchanger: a 3in-2out junction fed a hot stream, a
// cold stream, and RGB fuel buds an exchanger that swaps the streams'
// temperatures counter-currently WITHOUT touching their chemistry.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickPt, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// hot supply: R+G merge into a manually budded filter (its ports land
// deterministically: fuel@434,42), fed fuel so its out stream runs hot
await drawVein([[26, 42], [200, 80], [450, 95], [800, 110]]);
await drawVein([[26, 114], [120, 130], [170, 80]]);
await ticks(160);
await dblClickPt(430, 93);
await ticks(20);
await drawVein([[26, 474], [120, 380], [210, 190], [300, 30], [420, 18], [434, 42]]);
await ticks(200);

// the junction on the hot out vein near (656,105): cold R merges from the
// south-west, RGB fuel merges from the east, a fork exits south
await drawVein([[655, 105], [700, 240], [660, 320]]);
await drawVein([[26, 42], [150, 300], [450, 300], [610, 170], [640, 108]]);
await drawVein([[26, 474], [260, 560], [560, 540], [780, 300], [690, 130], [672, 110]]);
await ticks(450);

{
  const info = await worldInfo();
  const ex = info.organs.find((o) => o.kind === 'exchanger');
  ok('an exchanger budded itself at the 3in-2out junction', !!ex && ex.growth >= 10);
  ok('the filter upstream is untouched', info.organs.some((o) => o.kind === 'filter'));
}
await ticks(400); // let the temperature profile settle

const r = await page.evaluate(() => {
  const w = window.__veins.world();
  const chem = window.__veins.chem;
  const ex = [...w.organs.values()].find((o) => o.kind === 'exchanger');
  if (!ex) return null;
  const vFor = (pred) => [...w.veins.values()].find(pred);
  const t = (v, i) => (v && v.parcels[i].c.some((n) => n > 0) ? window.__veins.tempOf(v.parcels[i]) : null);
  const hotIn = vFor((v) => v.tail.type === 'organ-in' && v.tail.organId === ex.id && v.tail.port === 'hot-in');
  const coldIn = vFor((v) => v.tail.type === 'organ-in' && v.tail.organId === ex.id && v.tail.port === 'cold-in');
  const hotOut = vFor((v) => v.head.type === 'port' && v.head.organId === ex.id && v.head.port === 'hot-out');
  const coldOut = vFor((v) => v.head.type === 'port' && v.head.organId === ex.id && v.head.port === 'cold-out');
  const sp = (v, name) => (v ? v.parcels[1].c[chem.speciesIndex(name)] : 0);
  return {
    hotInT: t(hotIn, hotIn.parcels.length - 2),
    coldInT: t(coldIn, coldIn.parcels.length - 2),
    hotOutT: t(hotOut, 1),
    coldOutT: t(coldOut, 1),
    hotOutR: sp(hotOut, 'R'),
    hotOutRG: sp(hotOut, 'RG'),
    coldOutRG: sp(coldOut, 'RG'),
  };
});
ok('exchanger wired: all four stream veins attached', !!r && r.hotInT !== null && r.hotOutT !== null && r.coldOutT !== null);
console.log(`  hot in ${r.hotInT?.toFixed(2)} cold in ${r.coldInT?.toFixed(2)} -> hot out ${r.hotOutT?.toFixed(2)} cold out ${r.coldOutT?.toFixed(2)}`);
ok('a real temperature gap arrives', !!r && r.hotInT - r.coldInT > 0.3);
ok('the cold stream leaves HOT (past the midpoint: counter-current, not mixing)', !!r && r.hotOutT > (r.hotInT + r.coldInT) / 2);
ok('the hot stream leaves COLD (past the midpoint)', !!r && r.coldOutT < (r.hotInT + r.coldInT) / 2);
// chemistry untouched: the heated stream is still the cold arm's pure R,
// the cooled stream still carries the filter's RG
ok('heated stream kept its species (R, no RG)', !!r && r.hotOutR > 5000 && r.hotOutRG === 0);
ok('cooled stream kept its species (RG-rich)', !!r && r.coldOutRG > 1000);

await finish(d);
