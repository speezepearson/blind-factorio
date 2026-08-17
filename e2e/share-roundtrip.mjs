// Share links: a built world exports to a #world= URL that reproduces its
// structure (veins, attachments, organ) in a fresh session.
import { BASE_URL, finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, dblClickCell, pause, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

await drawVein([[1, 2], [8, 2], [8, 20], [30, 20]]);
await dblClickCell(19, 20);
const before = await worldInfo();
ok('built: vein + organ', before.veins.length >= 1 && before.organs.length === 1);

await page.click('button:has-text("Share link")');
await page.waitForTimeout(300);
const url = await page.evaluate(() => navigator.clipboard.readText());
ok('share link copied', url.startsWith(BASE_URL) && url.includes('#world='));

await page.goto(url.replace(/^.*#/, BASE_URL + '#'));
await page.waitForTimeout(800);
const after = await worldInfo();
ok('reimport: same vein count', after.veins.length === before.veins.length);
ok('reimport: organ survives', after.organs.length === 1 && after.organs[0].cx === before.organs[0].cx);
ok(
  'reimport: source attachment survives',
  after.veins.some((v) => v.head === 'source'),
);
ok(
  'reimport: organ attachments survive',
  after.veins.some((v) => v.tail === 'organ-in') && after.veins.some((v) => v.head === 'port'),
);

await finish(d);
