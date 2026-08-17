// The observation split: players get color/width/flow and field notes;
// probes, temperature, and stickiness are god-only.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, at } = d;

// player view (default)
ok('player: no probe tool', (await page.locator('button:has-text("Probe")').count()) === 0);
ok('player: no temp overlay button', (await page.locator('button:has-text("Temp")').count()) === 0);
ok('player: no stickiness sliders', (await page.locator('.stickrow').count()) === 0);
ok('player: field notes shown', /lossy projection/.test(await page.locator('.panel').innerText()));

// right-click on the demo trunk must NOT create a probe for the player
{
  const p = await at(20, 14);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForTimeout(150);
  ok('player: right-click adds no probe', !/vein \d|\(\d+,\d+\)/.test(await page.locator('.panel').innerText()));
}

// god view
await page.keyboard.press('g');
await page.waitForTimeout(200);
ok('god: probe tool appears', (await page.locator('button:has-text("Probe")').count()) === 1);
ok('god: stickiness sliders appear', (await page.locator('.stickrow').count()) === 1);
{
  const p = await at(20, 14);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForTimeout(400);
  const panel = await page.locator('.panel').innerText();
  ok('god: right-click probes the vein', /#1 \(20,14\)/.test(panel));
}

// leaving god mode hides the probes again and resets the tool
await page.click('button:has-text("Probe")');
await page.keyboard.press('g');
await page.waitForTimeout(200);
ok('player again: probes hidden', /Field notes/.test(await page.locator('.panel').innerText()));

await finish(d);
