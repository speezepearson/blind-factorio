// Regression: a pipe whose head/tail runs *alongside* a machine (flow
// parallel to the port edge) must still attach by touch. Loads the exact
// world code from the original bug report.
import { finish, launch, ok } from './helpers.mjs';

const BAD_CODE = 'ZZDBboMwEET_Zc57wLgJaP-g34A4GGOIW9cgx6SqEP8emRiJqKc3Wu_saLziAZaEX7CoCsINLERB-FH6Zr25g5sVtgeLCyH-zeazB-M-B-tHEKZgR-vBTSWprFtCmKKKdvJgsVF2Xs9O67_Pvrr672sJs52Ne8svBUEb59KkqSVJ0dLOMlMmfmReMq-Jbbr4tXidApK_JXRLP5oIXveoVP7ceT0ackEIRuk4BXD6l2Hx3riX7pzxvTkerIuH7pZhOPRe-LWhumC1yqe2bXsC';

const d = await launch(`#world=${BAD_CODE}`);
const { page, godToggle, hoverText } = d;
await page.waitForTimeout(400); // hash world load + prewarm

await godToggle();

// pipe: [83,31] south along the spring's east edge to [83,33], then east to
// [86,33] beside the sink. Prewarm already ran, so fluid should be there.
{
  const t = await hoverText(83, 32);
  ok('side-hugging head attaches to the spring', /650 nm/.test(t));
  if (!/650 nm/.test(t)) console.log('  panel:', t.slice(0, 200));
}
{
  const t = await hoverText(91, 32); // the sink
  ok('sink drinks through the once-broken pipe', /Drinking 2\.00/.test(t));
  if (!/Drinking 2\.00/.test(t)) console.log('  panel:', t.slice(0, 200));
}

await finish(d);
