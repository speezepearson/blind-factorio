// Drawing veins: source-fed lines, mid-vein forks, merge-on-release, erase
// splitting, and undo.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, drawVein, pause, ticks, worldInfo } = d;

await page.selectOption('select', 'blank');
await page.waitForTimeout(200);
await pause();

// R source sits at (1,2): drag from it, east then down
await drawVein([[1, 2], [12, 2], [12, 20]]);
{
  const info = await worldInfo();
  ok('vein laid from the R source', info.veins.length === 1 && info.veins[0].head === 'source');
}
await ticks(80);
{
  const info = await worldInfo();
  ok('R flows down the vein', (info.veins[0].totals.R ?? 0) > 5000);
}

// fork: start a drag mid-vein, run it somewhere open
await drawVein([[12, 10], [24, 10]]);
await ticks(60);
{
  const info = await worldInfo();
  const fork = info.veins.find((v) => v.head === 'fork');
  ok('fork vein exists and carries fluid', !!fork && (fork.totals.R ?? 0) > 1000);
}

// merge: G source (1,6) into the trunk — release ON the trunk column
await drawVein([[1, 6], [8, 6], [12, 6]]);
{
  const info = await worldInfo();
  const merge = info.veins.find((v) => v.tail === 'merge');
  ok('release on a vein merges', !!merge && merge.head === 'source');
}
await ticks(200);
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

// erase mid-vein splits the trunk into fragments
await page.click('button:has-text("Erase")');
const p = await d.at(12, 14);
await page.mouse.click(p.x, p.y);
{
  const info = await worldInfo();
  ok('erase split the trunk', info.veins.some((v) => v.head === 'open' && v.first[1] > 14));
}

await finish(d);
