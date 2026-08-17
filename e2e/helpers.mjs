import { chromium } from 'playwright';

// Shared harness for the Veins e2e suites. Each test is standalone
// (`node e2e/<name>.mjs`) against a dev server on 5173 (E2E_URL to
// override). The dev build exposes `window.__veins` — {world(), chem,
// tick(), tempOf(parcel)} — which the suites use to fast-forward the sim
// deterministically and to read world state (including temperature via the
// real formula) that the player-facing UI deliberately hides.

export const COLS = 46;
export const ROWS = 30;
export const BASE_URL = process.env.E2E_URL ?? 'http://localhost:5173/';

let failures = 0;
export const ok = (name, cond) => {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
};

export async function launch(hash = '') {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1420, height: 950 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE_URL + hash);
  await page.waitForTimeout(800);

  const canvas = page.locator('canvas');
  const at = async (cx, cy) => {
    const box = await canvas.boundingBox();
    return {
      x: box.x + ((cx + 0.5) / COLS) * box.width,
      y: box.y + ((cy + 0.5) / ROWS) * box.height,
    };
  };
  const clickCell = async (cx, cy) => {
    const p = await at(cx, cy);
    await page.mouse.click(p.x, p.y);
  };
  const dblClickCell = async (cx, cy) => {
    const p = await at(cx, cy);
    await page.mouse.dblclick(p.x, p.y);
  };
  const drawVein = async (waypoints) => {
    const p0 = await at(...waypoints[0]);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    for (const wp of waypoints.slice(1)) {
      const p = await at(...wp);
      await page.mouse.move(p.x, p.y, { steps: 6 });
    }
    await page.mouse.up();
  };
  const pause = async () => {
    const btn = page.locator('button:has-text("Pause")');
    if (await btn.count()) await btn.click();
  };
  // advance the sim n ticks synchronously, bypassing the rAF pacing
  const ticks = (n) => page.evaluate((k) => {
    for (let i = 0; i < k; i++) window.__veins.tick();
  }, n);
  // serializable snapshot of world structure + per-vein species totals
  const worldInfo = () =>
    page.evaluate(() => {
      const w = window.__veins.world();
      const chem = window.__veins.chem;
      return {
        tick: w.tick,
        veins: [...w.veins.values()].map((p) => {
          const totals = {};
          for (const parcel of p.parcels) {
            for (let i = 0; i < chem.nsp; i++) {
              if (parcel.c[i] > 0) totals[chem.species[i]] = (totals[chem.species[i]] ?? 0) + parcel.c[i];
            }
          }
          const firstTotals = {};
          for (let i = 0; i < chem.nsp; i++) {
            if (p.parcels[0].c[i] > 0) firstTotals[chem.species[i]] = p.parcels[0].c[i];
          }
          return {
            id: p.id,
            len: p.cells.length,
            head: p.head.type,
            tail: p.tail.type,
            first: [p.cells[0].x, p.cells[0].y],
            last: [p.cells[p.cells.length - 1].x, p.cells[p.cells.length - 1].y],
            totals,
            firstTotals,
            incCount: p.inc.reduce((a, b) => a + b, 0),
          };
        }),
        organs: [...w.organs.values()].map((o) => ({ cx: o.cx, cy: o.cy, growth: o.growth })),
        maxTemp: Math.max(
          1,
          ...[...w.veins.values()].flatMap((p) => p.parcels.map((pc) => window.__veins.tempOf(pc))),
        ),
      };
    });

  return { browser, page, errors, canvas, at, clickCell, dblClickCell, drawVein, pause, ticks, worldInfo };
}

export async function finish({ browser, errors }) {
  ok('no console errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5));
  await browser.close();
  process.exit(failures ? 1 : 0);
}
