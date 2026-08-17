// Junction merges: splice-on-release, inspector counts, merged contents,
// erase-whole-stretch, player secrecy.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, godToggle, loadPreset, setSpeed, drawPipe, hoverText, clickCell } = d;

await godToggle();
await loadPreset('lookalike');
await setSpeed(8);

// trunk: pure-556 spring -> top sink (wants 650+540)
await page.click('button:has-text("Pipes")');
await drawPipe([[25, 24], [25, 20], [130, 20], [130, 30], [134, 30]]);
// tributary: mixture spring, released ON the trunk at (60,20) -> splice
await drawPipe([[25, 69], [25, 60], [60, 60], [60, 20]]);
await page.waitForTimeout(3500);

{
  const t = await hoverText(60, 20);
  ok('junction inspector', /Junction/.test(t) && /Sums 2 inflows/.test(t) && /into 1 outflow/.test(t));
  if (!/Junction/.test(t)) console.log('  panel:', t.slice(0, 140));
}
{
  const t = await hoverText(100, 20);
  ok('downstream carries all three wavelengths', /556 nm/.test(t) && /650 nm/.test(t) && /540 nm/.test(t));
  if (!(/556 nm/.test(t) && /650 nm/.test(t))) console.log('  panel:', t.slice(0, 200));
}
{
  const t = await hoverText(137, 30);
  ok('diluted sink at 50%, dark', /50% match, dark/.test(t));
  if (!/50% match/.test(t)) console.log('  panel:', t.slice(0, 140));
}

// erase one segment of the upstream stretch: the whole spring->junction
// pipeline goes, junction and downstream stay
await page.click('button:has-text("Erase")');
await clickCell(40, 20);
await page.click('button:has-text("Pipes")');
await page.waitForTimeout(3500);
{
  const t = await hoverText(45, 20);
  ok('upstream stretch fully erased', !/Pipeline #/.test(t));
}
{
  const t = await hoverText(60, 20);
  ok('junction survives erase', /Junction/.test(t) && /Sums 1 inflow,/.test(t));
}
{
  const t = await hoverText(100, 20);
  ok('downstream now pure 650+540', /650 nm/.test(t) && /540 nm/.test(t) && !/556 nm/.test(t));
  if (/556 nm/.test(t)) console.log('  panel:', t.slice(0, 200));
}
{
  const t = await hoverText(137, 30);
  ok('sink now LIT at 100%', /100% match, LIT/.test(t));
  if (!/LIT/.test(t)) console.log('  panel:', t.slice(0, 140));
}

// player mode: the junction keeps its secrets
await godToggle();
{
  const t = await hoverText(60, 20);
  ok('junction secret in player mode', /junction keeps its secrets/.test(t));
  if (!/junction keeps/.test(t)) console.log('  panel:', t.slice(0, 140));
}

await finish(d);
