// Regression: splicing a junction into a full trunk must not wipe the
// downstream half's in-flight fluid (it gets a new pipeline id; the sim
// seeds its contents at splice time).
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, godToggle, loadPreset, setSpeed, drawPipe, hoverText } = d;

await godToggle();
await loadPreset('lookalike');

// fill a trunk from the pure spring to the bottom sink at 8x
await setSpeed(8);
await page.click('button:has-text("Pipes")');
await drawPipe([[25, 24], [25, 20], [130, 20], [130, 74], [134, 74]]);
await page.waitForTimeout(3500);
ok('trunk full, sink LIT', /100% match, LIT/.test(await hoverText(137, 74)));

// nearly freeze the sim, then splice mid-trunk
await setSpeed(0.25);
await drawPipe([[25, 69], [25, 60], [60, 60], [60, 20]]);

// immediately: the downstream half (40 cells past the junction) must still
// hold the trunk's in-flight fluid — before the fix it was wiped empty
{
  const t = await hoverText(100, 20);
  ok('downstream contents survive the splice', /Pipeline #/.test(t) && /556 nm/.test(t));
  if (!/556 nm/.test(t)) console.log('  panel:', t.slice(0, 160));
}
{
  const t = await hoverText(137, 74);
  ok('sink still fed right after splice', /Drinking 2\.00/.test(t));
  if (!/Drinking 2\.00/.test(t)) console.log('  panel:', t.slice(0, 140));
}

await finish(d);
