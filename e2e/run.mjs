import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run every e2e suite in this directory sequentially (they all drive the
// same dev server and the same mouse, so no parallelism), reporting a
// combined result. Usage: npm run e2e (dev server must be up on 5173).

const dir = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('.mjs') && f !== 'run.mjs' && f !== 'helpers.mjs')
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n== ${suite}`);
  const res = spawnSync(process.execPath, [join(dir, suite)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
