// Starting a pipe drag on a pipeline's dangling tail extends it as ONE
// pipeline (same id, in-flight fluid kept, no junction at the seam).
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, panel, godToggle, loadPreset, setSpeed, drawPipe, hoverText } = d;

await godToggle();
await loadPreset('lookalike');
await setSpeed(8);

// half a route: pure-556 spring out into open space, tail dangling at (80,20)
await page.click('button:has-text("Pipes")');
await drawPipe([[25, 24], [25, 20], [80, 20]]);
await page.waitForTimeout(1200);
{
  const t = await hoverText(60, 20);
  ok('first stretch laid (60 cells)', /Pipeline #(\d+): 60 cells/.test(t));
  ok('fluid reaches the dangling half', /556 nm/.test(t));
}
const firstId = (await panel()).match(/Pipeline #(\d+):/)?.[1];

// pick the tail back up and finish the route into the bottom sink
await drawPipe([[80, 20], [130, 20], [130, 74], [134, 74]]);
await page.waitForTimeout(3500);
{
  const t = await hoverText(100, 20);
  ok('extension joined as one pipeline', new RegExp(`Pipeline #${firstId}: 168 cells`).test(t));
  if (!/168 cells/.test(t)) console.log('  panel:', t.slice(0, 160));
}
{
  const t = await hoverText(80, 20);
  ok('no junction at the old tail', /Pipeline/.test(t) && !/Junction/.test(t));
}
{
  const t = await hoverText(137, 74);
  ok('sink fed through the extended pipe, LIT', /100% match, LIT/.test(t));
  if (!/LIT/.test(t)) console.log('  panel:', t.slice(0, 140));
}

await finish(d);
