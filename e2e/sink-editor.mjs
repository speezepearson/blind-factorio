// Sinks configure their target with the same mixture-list editor springs
// use; tolerance stays its own param.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, panel, godToggle, loadPreset, clickCell } = d;

await godToggle();
await loadPreset('lookalike');

await page.click('button:has-text("Edit")');
await clickCell(137, 74); // the pure-556 sink
await page.waitForTimeout(200);
{
  const t = await panel();
  ok('sink edit panel opens', /Edit: Sink/.test(t));
  ok('sink has the mixture-list editor', /Target mixture/.test(t) && /556 nm/.test(t) && /\+ Add wavelength/.test(t));
  ok('tolerance survives as its own param', /Tolerance \(nm\): 12/.test(t));
  if (!/Target mixture/.test(t)) console.log('  panel:', t.slice(0, 260));
}
await page.click('.panel .mixture button:has-text("+ Add wavelength")');
await page.waitForTimeout(200);
{
  const rows = await page.locator('.panel .mixture-row').count();
  ok('adding a target wavelength row works', rows === 2);
}

await finish(d);
