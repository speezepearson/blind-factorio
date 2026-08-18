// Share links: a built world exports to a #world= URL that reproduces its
// structure (curves, attachments, organ) in a fresh session.
import { BASE_URL, finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickPt, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

await drawVein([[26, 42], [220, 130], [420, 200], [640, 190]]);
await ticks(140); // let the ghost incarnate — budding refuses ghost nodes
await dblClickPt(420, 200);
await ticks(12); // organ grows in; halves trimmed to the membrane
const before = await worldInfo();
ok('built: veins + organ', before.veins.length >= 1 && before.organs.length === 1);

await page.click('button:has-text("Share link")');
await page.waitForTimeout(300);
const url = await page.evaluate(() => navigator.clipboard.readText());
ok('share link copied', url.startsWith(BASE_URL) && url.includes('#world='));

await page.goto(url.replace(/^.*#/, BASE_URL + '#'));
await page.waitForTimeout(800);
const after = await worldInfo();
ok('reimport: same vein count', after.veins.length === before.veins.length);
ok(
  'reimport: organ survives at the same spot',
  after.organs.length === 1 && Math.hypot(after.organs[0].cx - before.organs[0].cx, after.organs[0].cy - before.organs[0].cy) < 1,
);
ok('reimport: source attachment survives', after.veins.some((v) => v.head === 'source'));
ok(
  'reimport: organ attachments survive',
  after.veins.some((v) => v.tail === 'organ-in') && after.veins.some((v) => v.head === 'port'),
);
ok(
  'reimport: node counts identical (lossless geometry)',
  JSON.stringify(after.veins.map((v) => v.n).sort()) === JSON.stringify(before.veins.map((v) => v.n).sort()),
);

await finish(d);
