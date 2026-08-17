// The "Green, two ways" lookalike preset: sinks judge wavelengths (not
// looks), lookalike mixtures render pixel-identical, inspector lists
// mixture components.
import { GRID_H, GRID_W, finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, panel, godToggle, loadPreset, setSpeed, drawPipe, hoverText, moveToCell } = d;

await godToggle();
await loadPreset('lookalike');
ok('preset loaded: pure spring hoverable', /Spring/.test(await hoverText(25, 30)));
ok('preset loaded: sink hoverable', /Sink/.test(await hoverText(137, 30)));
await setSpeed(8);

// wrong pigments: pure 556 into the red+green sink -> dark
await page.click('button:has-text("Pipes")');
await drawPipe([[25, 24], [25, 20], [130, 20], [130, 30], [134, 30]]);
await page.waitForTimeout(3000);
{
  const t = await hoverText(137, 30);
  ok('wrong pigments stay dark', /Drinking [12]\.\d+ L\/s — 0% match, dark/.test(t));
  if (!/0% match, dark/.test(t)) console.log('  panel:', t.slice(0, 120));
}
await page.keyboard.press('Control+z');

// right pigments: pure->pure sink, red+green->red+green sink (paths cross)
await drawPipe([[25, 24], [25, 20], [130, 20], [130, 74], [134, 74]]);
await drawPipe([[25, 69], [25, 60], [120, 60], [120, 30], [134, 30]]);
await page.waitForTimeout(4500);
{
  const t1 = await hoverText(137, 74);
  ok('pure-556 sink LIT at 100%', /100% match, LIT/.test(t1));
  if (!/LIT/.test(t1)) console.log('  panel:', t1.slice(0, 120));
  const t2 = await hoverText(137, 30);
  ok('red+green sink LIT', /match, LIT/.test(t2));
  if (!/LIT/.test(t2)) console.log('  panel:', t2.slice(0, 120));
}

// the two pipes should be visually identical: sample the line color at the
// center of a straight cell on each run
const px = await page.evaluate(([a, b]) => {
  const ctx = document.querySelector('canvas').getContext('2d');
  const grab = (p) => {
    // most saturated pixel in a 5x5 patch (the pipe line is thin)
    let best = null, bestSat = -1;
    const data = ctx.getImageData(p.x - 2, p.y - 2, 5, 5).data;
    for (let i = 0; i < data.length; i += 4) {
      const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (sat > bestSat) { bestSat = sat; best = [data[i], data[i + 1], data[i + 2]]; }
    }
    return best;
  };
  return [grab(a), grab(b)];
}, [
  { x: Math.round(((60 + 0.5) / GRID_W) * (GRID_W * 6)), y: Math.round(((20 + 0.5) / GRID_H) * (GRID_H * 6)) },
  { x: Math.round(((60 + 0.5) / GRID_W) * (GRID_W * 6)), y: Math.round(((60 + 0.5) / GRID_H) * (GRID_H * 6)) },
]);
const close = px[0].every((v, i) => Math.abs(v - px[1][i]) <= 12);
console.log(`  pure pipe rgb(${px[0]}) vs mixture pipe rgb(${px[1]})`);
ok('lookalike pipes draw the same color', close);

// pipe inspector lists the mixture's components
await moveToCell(60, 60);
await page.waitForTimeout(300);
{
  const t = await panel();
  ok('pipe inspector shows 650 + 540 nm', /650 nm \(red\)/.test(t) && /540 nm \(green\)/.test(t));
  if (!(/650 nm \(red\)/.test(t) && /540 nm \(green\)/.test(t))) console.log('  panel:', t.slice(0, 160));
}

// starter preset still loads and runs
await loadPreset('starter');
await page.waitForTimeout(500);
ok('starter preset loads', /Spring/.test(await hoverText(25, 35)));

await finish(d);
