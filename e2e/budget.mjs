// Player budget: drawing/pasting spends it, erasing refunds it, and
// unaffordable pastes land as ghosts (which refund nothing when erased).
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, panel, loadPreset, drawPipe, hoverText, clickCell } = d;

// player mode throughout; lookalike has a limited puzzle budget
await loadPreset('lookalike');

ok('budget strip shows the preset stock', /Budget: pipe ×700/.test(await hoverText(100, 100)) && /Blender ×1/.test(await panel()));

// drawing 51 cells of pipe spends 51 budget
await page.click('button:has-text("Pipes")');
await drawPipe([[30, 90], [80, 90]]);
ok('drawing spends pipe budget', /pipe ×649/.test(await hoverText(100, 100)));

// erasing the stretch refunds it
await page.click('button:has-text("Erase")');
await clickCell(50, 90);
ok('erasing refunds pipe budget', /pipe ×700/.test(await hoverText(100, 100)));

// pasting a spring with zero spring budget lands a ghost
await page.click('button:has-text("Copy/paste")');
await clickCell(25, 29); // copy square over the pure spring
await page.waitForTimeout(200);
await clickCell(60, 90); // paste
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
{
  const t = await hoverText(58, 88);
  ok('unaffordable paste becomes a ghost', /Ghost machine/.test(t) && /unbuilt placeholder/.test(t));
  if (!/Ghost/.test(t)) console.log('  panel:', t.slice(0, 160));
}

// erasing the ghost refunds nothing (it was never paid for)
await page.click('button:has-text("Erase")');
await clickCell(58, 88);
{
  const t = await hoverText(100, 100);
  ok('ghost erase refunds nothing', /pipe ×700/.test(t) && !/Spring ×/.test(t));
}

await finish(d);
