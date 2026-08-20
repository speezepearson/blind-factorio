// The entropy engine's books: radical and energy conservation are exact
// integer statements modulo the declared boundary accounts (sources,
// vents, growing organs, surgery, ambient). Runs the full demo — merge,
// junction, filter, open-tail and portless-port vents — and audits.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, pause, ticks } = d;
await pause();

const snap = () =>
  page.evaluate(() => {
    const V = window.__veins;
    const w = V.world();
    const chem = V.chem;
    const radOf = (c) => {
      let n = 0;
      for (let s = 0; s < chem.nsp; s++) n += c[s] * chem.radcount[s];
      return n;
    };
    // energy content = heat − bond depth: U − E_bond is the invariant
    const eOf = (p) => {
      let e = p.U;
      for (let s = 0; s < chem.nsp; s++) e -= p.c[s] * chem.bondEq[s];
      return e;
    };
    let rad = 0;
    let E = 0;
    for (const p of w.veins.values()) {
      for (const pc of p.parcels) {
        rad += radOf(pc.c);
        E += eOf(pc);
      }
    }
    for (const o of w.organs.values()) {
      if (!o.chambers) continue;
      for (const k of ['inlet', 'main', 'side']) {
        rad += radOf(o.chambers[k].c);
        E += eOf(o.chambers[k]);
      }
    }
    return { rad, E, S: V.entropy(), m: { ...V.meters() } };
  });

const t0 = await snap();
await ticks(400);
const t1 = await snap();

const dm = (k) => t1.m[k] - t0.m[k];
const radBoundary = dm('srcRad') - dm('ventRad') - dm('grownRad') - dm('cutRad');
ok('radical audit exact', t1.rad - t0.rad === radBoundary);
console.log(`  Δworld ${t1.rad - t0.rad} = src ${dm('srcRad')} − vent ${dm('ventRad')} − grown ${dm('grownRad')} − cut ${dm('cutRad')}`);

const eBoundary = dm('srcE') - dm('ventE') - dm('grownE') - dm('cutE') - dm('ambQ');
ok('energy audit exact', t1.E - t0.E === eBoundary);
console.log(`  Δworld ${t1.E - t0.E} quanta vs boundary ${eBoundary}`);

ok('the sim actually ran fluid (audits are not vacuous)', dm('srcRad') > 100000 && dm('ventRad') > 10000);
ok('entropy grew', t1.S > t0.S);
ok('the heart did work', dm('heartS') > 0);

await finish(d);
