// Freehand drawing: source-fed curves, mid-vein forks, merge-on-release,
// erase-brush splitting, and undo.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo, at } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// R source sits at (26,42): drag from it, a gentle curve east
await drawVein([[26, 42], [200, 60], [420, 48], [560, 90]]);
{
  const info = await worldInfo();
  ok('vein laid from the R source', info.veins.length === 1 && info.veins[0].head === 'source');
}
await ticks(110);
{
  const info = await worldInfo();
  ok('R flows down the vein', (info.veins[0].totals.R ?? 0) > 5000);
}

// fork: start a drag ON the vein, run it somewhere open
await drawVein([[420, 48], [430, 200], [520, 260]]);
await ticks(80);
{
  const info = await worldInfo();
  const fork = info.veins.find((v) => v.head === 'fork');
  ok('fork vein exists and carries fluid', !!fork && (fork.totals.R ?? 0) > 1000);
}

// merge: G source (26,114) into the trunk — release ON the trunk
await drawVein([[26, 114], [140, 130], [200, 62]]);
{
  const info = await worldInfo();
  const merge = info.veins.find((v) => v.tail === 'merge');
  ok('release on a vein merges', !!merge && merge.head === 'source');
}
await ticks(260);
{
  const info = await worldInfo();
  const all = {};
  for (const v of info.veins) for (const [s, n] of Object.entries(v.totals)) all[s] = (all[s] ?? 0) + n;
  ok('merged flow fuses into RG', (all.RG ?? 0) > 500);
}

// undo removes the merge vein; redo restores it
const before = (await worldInfo()).veins.length;
await page.keyboard.press('Control+z');
ok('undo removed the last vein', (await worldInfo()).veins.length === before - 1);
await page.keyboard.press('Control+Shift+Z');
ok('redo restored it', (await worldInfo()).veins.length === before);

// erase-brush across the trunk splits it into fragments
await page.click('button:has-text("Erase")');
{
  const p0 = await at(300, 20);
  const p1 = await at(300, 100);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 10 });
  await page.mouse.up();
}
{
  const info = await worldInfo();
  ok('erase split the trunk', info.veins.some((v) => v.head === 'open' && v.first[0] > 300));
}

await finish(d);
