// Endpoint snapping: a stroke starting on an open tail EXTENDS the vein
// (no fork, no halving — the reported narrowing bug); a stroke ending on
// an open head feeds it; a stroke bridging tail→head fuses the veins.
// Plus shift-click erase of a whole junction-to-junction stretch, and the
// vent haze at open tails.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo, at } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// A: from the R source
await drawVein([[26, 42], [160, 50], [300, 60]]);
await ticks(90);
{
  const info = await worldInfo();
  ok('base vein flows', info.veins.length === 1 && (info.veins[0].totals.R ?? 0) > 5000);
}
const n1 = (await worldInfo()).veins[0].n;

// B: start ON A's open tail — must extend, not fork
await drawVein([[300, 60], [420, 80], [520, 90]]);
{
  const info = await worldInfo();
  ok('stroke from open tail extends the vein', info.veins.length === 1 && info.veins[0].n > n1);
}
await ticks(90);
{
  // entropy-engine: flow[] is arrival flux; an extension must carry the
  // full stream to the tail (a fork would halve it)
  const info = await worldInfo();
  ok(
    'full flow reaches the extended tail (no halving)',
    info.veins[0].flowLast > 2000 && info.veins[0].flowLast > 0.5 * info.veins[0].flowFirst,
  );
}

// C: chain again — still one vein, still full flow
await drawVein([[520, 90], [620, 105], [700, 120]]);
await ticks(80);
{
  const info = await worldInfo();
  ok(
    'second extension: still one vein at full flow',
    info.veins.length === 1 && info.veins[0].flowLast > 2000 && info.veins[0].flowLast > 0.5 * info.veins[0].flowFirst,
  );
}

// vent haze: the open tail at (700,120) sprays red into the cavity
{
  await page.waitForTimeout(250); // let a frame render
  const px = await page.evaluate(() => {
    const ctx = document.querySelector('canvas').getContext('2d');
    const s = ctx.getImageData(716, 124, 1, 1).data;
    return [s[0], s[1], s[2]];
  });
  ok('red haze vents past the open tail', px[0] > 60 && px[0] > 1.8 * px[1]);
  console.log(`  haze pixel: rgb(${px})`);
}

// floater with an open head; a stroke ending on that head prepends to it
await drawVein([[500, 300], [700, 300]]);
{
  const info = await worldInfo();
  ok('floater laid', info.veins.length === 2);
}
const fN = (await worldInfo()).veins.find((v) => v.head === 'open' && v.tail === 'open').n;
await drawVein([[350, 250], [460, 290], [498, 299]]);
{
  const info = await worldInfo();
  const f = info.veins.find((v) => v.head === 'open' && v.tail === 'open');
  ok('stroke ending on an open head prepends (no new vein)', info.veins.length === 2 && !!f && f.n > fN);
}

// bridge A's open tail to the floater's open head: all fuse into ONE vein
await drawVein([[700, 120], [520, 200], [355, 248]]);
{
  const info = await worldInfo();
  ok('bridging tail to head fuses the veins', info.veins.length === 1);
}
await ticks(220);
{
  const info = await worldInfo();
  ok(
    'fused vein carries R end to end',
    info.veins[0].flowLast > 2000 && (info.veins[0].lastTotals.R ?? 0) > 200,
  );
}

// a fork creates a junction; shift-click downstream severs only up to it
await drawVein([[160, 50], [220, 220], [320, 260]]);
await ticks(30);
{
  const info = await worldInfo();
  ok('fork attached for the snip test', info.veins.length === 2);
}
const mainN = (await worldInfo()).veins.find((v) => v.head === 'source').n;
await page.click('button:has-text("Erase")');
{
  const p = await at(520, 90);
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}
{
  const info = await worldInfo();
  const main = info.veins.find((v) => v.head === 'source');
  ok('shift-click severed downstream of the junction only', info.veins.length === 2 && !!main && main.n < mainN && main.n > 5);
  const fork = info.veins.find((v) => v.head === 'fork');
  ok('the forking vein survives', !!fork);
}
await ticks(40);
{
  const info = await worldInfo();
  const fork = info.veins.find((v) => v.head === 'fork');
  ok('fork still fed after the snip', !!fork && (fork.totals.R ?? 0) > 1000);
}

// shift-click a junction-free vein: the whole vein goes
{
  const p = await at(250, 235);
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}
{
  const info = await worldInfo();
  ok('shift-click removed the whole junction-free vein', info.veins.length === 1 && !info.veins.some((v) => v.head === 'fork'));
}

// ---- anchor-heal regression: deleting a merge's host must OPEN the
// dependent's tail, never heal it onto itself (the black-hole bug) ----
await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await page.click('button:has-text("Draw")'); // the snip block left Erase active
await drawVein([[26, 42], [160, 42], [300, 42]]); // host H
await drawVein([[26, 114], [150, 110], [200, 52]]); // M merges into H
await ticks(60);
{
  const info = await worldInfo();
  ok('heal setup: M merges into H', info.veins.some((v) => v.tail === 'merge'));
}
// shift-click ON the junction node itself is a no-op (junction must survive)
const juncPt = await page.evaluate(() => {
  const w = window.__veins.world();
  const m = [...w.veins.values()].find((v) => v.tail.type === 'merge');
  const seg = window.__veins.resolveAttach(m.tail);
  return seg.vein.pts[seg.idx];
});
await page.click('button:has-text("Erase")');
const veinsBefore = (await worldInfo()).veins.length;
{
  const p = await at(...juncPt);
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}
ok('shift-click on the junction node itself is a no-op', (await worldInfo()).veins.length === veinsBefore);
// sever H on both sides of the junction: H fully gone, M's tail heals OPEN
{
  const p1 = await at(80, 42);
  await page.keyboard.down('Shift');
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.click(p1.x, p1.y);
  const p2 = await at(260, 42);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.click(p2.x, p2.y);
  await page.keyboard.up('Shift');
}
await ticks(60);
{
  const info = await worldInfo();
  const m = info.veins.find((v) => v.head === 'source');
  ok('host fully severed; M tail healed OPEN (no self-merge)', !!m && m.tail === 'open');
  ok('no black-hole accumulation at the healed tail', !!m && (m.lastTotals.G ?? 0) < 30000);
}

await finish(d);
