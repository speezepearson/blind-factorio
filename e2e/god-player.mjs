// The observation split: players get color/width/flow and field notes;
// probes, temperature, and stickiness are god-only.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, rightClickPt } = d;

// player view (default)
ok('player: no probe tool', (await page.locator('button:has-text("Probe")').count()) === 0);
ok('player: no temp overlay button', (await page.locator('button:has-text("Temp")').count()) === 0);
ok('player: no streams toggle', (await page.locator('button:has-text("Streams")').count()) === 0);
ok('player: no stickiness sliders', (await page.locator('.stickrow').count()) === 0);
ok('player: field notes shown', /lossy projection/.test(await page.locator('.panel').innerText()));

// a point on the demo trunk, read from the world
const spot = await page.evaluate(() => {
  const w = window.__veins.world();
  const trunk = [...w.veins.values()].find((p) => p.head.type === 'source');
  return trunk.pts[Math.floor(trunk.pts.length / 2)];
});

// right-click on the trunk must NOT create a probe for the player
await rightClickPt(...spot);
await page.waitForTimeout(150);
ok('player: right-click adds no probe', !/·vein|\(\d+,\d+\)/.test(await page.locator('.panel').innerText()));

// god view
await page.keyboard.press('g');
await page.waitForTimeout(200);
ok('god: probe tool appears', (await page.locator('button:has-text("Probe")').count()) === 1);
ok('god: streams toggle appears', (await page.locator('button:has-text("Streams")').count()) === 1);
ok('god: stickiness sliders appear', (await page.locator('.stickrow').count()) === 1);
await rightClickPt(...spot);
await page.waitForTimeout(400);
{
  const panel = await page.locator('.panel').innerText();
  ok('god: right-click probes the vein', /#1 \(\d+,\d+\)/.test(panel));
}

// hovering a vein in god mode pins the two cursor charts (history +
// along-the-vein profile); moving off the vein clears them
{
  const p = await d.at(...spot);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(400);
  const panel = await page.locator('.panel').innerText();
  ok('god: hover shows cursor history chart', /cursor · node \d+ · history/.test(panel));
  ok('god: hover shows along-the-vein chart', /cursor · along the vein/.test(panel));
  const off = await d.at(spot[0], Math.min(600, spot[1] + 200)); // empty cavity
  await page.mouse.move(off.x, off.y);
  await page.waitForTimeout(400);
  ok('god: cursor charts clear off-vein', !/along the vein/.test(await page.locator('.panel').innerText()));
}

// leaving god mode hides the probes again and resets the tool
await page.click('button:has-text("Probe")');
await page.keyboard.press('g');
await page.waitForTimeout(200);
ok('player again: probes hidden', /Field notes/.test(await page.locator('.panel').innerText()));

await finish(d);
