import { chromium } from 'playwright';

// Shared harness for the Veins e2e suites. Each test is standalone
// (`node e2e/<name>.mjs`) against a dev server on 5173 (E2E_URL to
// override). Coordinates are WORLD PIXELS (966×630 canvas, continuous —
// there is no grid). The dev build exposes `window.__veins` — {world(),
// chem, tick(), tempOf(parcel), resolveAttach(att)} — which the suites use
// to fast-forward the sim deterministically and to read hidden state
// through the real physics formulas.
//
// Sources sit at (26, 42 + 72·spIdx): R (26,42), G (26,114), B (26,186)…

export const WORLD_W = 966;
export const WORLD_H = 630;
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

  // the world canvas specifically — probe charts are canvases too
  const canvas = page.locator('.stage canvas');
  const at = async (x, y) => {
    const box = await canvas.boundingBox();
    return { x: box.x + (x / WORLD_W) * box.width, y: box.y + (y / WORLD_H) * box.height };
  };
  const clickPt = async (x, y) => {
    const p = await at(x, y);
    await page.mouse.click(p.x, p.y);
  };
  const dblClickPt = async (x, y) => {
    const p = await at(x, y);
    await page.mouse.dblclick(p.x, p.y);
  };
  const rightClickPt = async (x, y) => {
    const p = await at(x, y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
  };
  // freehand drag through waypoints (Playwright interpolates the steps, so
  // the pen visits plenty of intermediate points)
  const drawVein = async (waypoints) => {
    const p0 = await at(...waypoints[0]);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    for (const wp of waypoints.slice(1)) {
      const p = await at(...wp);
      await page.mouse.move(p.x, p.y, { steps: 12 });
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
          const lastTotals = {};
          for (let i = 0; i < chem.nsp; i++) {
            if (p.parcels[0].c[i] > 0) firstTotals[chem.species[i]] = p.parcels[0].c[i];
            const lastC = p.parcels[p.parcels.length - 1].c[i];
            if (lastC > 0) lastTotals[chem.species[i]] = lastC;
          }
          return {
            id: p.id,
            n: p.pts.length,
            head: p.head.type,
            tail: p.tail.type,
            first: p.pts[0],
            last: p.pts[p.pts.length - 1],
            totals,
            firstTotals,
            lastTotals,
            incCount: p.inc.reduce((a, b) => a + b, 0),
          };
        }),
        organs: [...w.organs.values()].map((o) => ({
          cx: o.c[0], cy: o.c[1], r: o.r, growth: o.growth, load: o.load,
          portIn: o.portIn, portOut: o.portOut, portSide: o.portSide,
        })),
        maxTemp: Math.max(
          1,
          ...[...w.veins.values()].flatMap((p) => p.parcels.map((pc) => window.__veins.tempOf(pc))),
        ),
      };
    });

  return { browser, page, errors, canvas, at, clickPt, dblClickPt, rightClickPt, drawVein, pause, ticks, worldInfo };
}

export async function finish({ browser, errors }) {
  ok('no console errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5));
  await browser.close();
  process.exit(failures ? 1 : 0);
}
