import { chromium } from 'playwright';

// Shared harness for the end-to-end suites. Each test file is a standalone
// script: `node e2e/<name>.mjs` against a dev server already running on
// 5173 (override with E2E_URL). Tests print PASS/FAIL lines and exit
// non-zero if anything failed; e2e/run.mjs runs them all.

export const GRID_W = 170;
export const GRID_H = 110;
export const BASE_URL = process.env.E2E_URL ?? 'http://localhost:5173/';

let failures = 0;

export const ok = (name, cond) => {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
};

// Boot a page and return it wrapped in cell-coordinate driver helpers.
export async function launch(hash = '') {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE_URL + hash);
  await page.waitForTimeout(900);

  const canvas = page.locator('canvas');
  let box = await canvas.boundingBox();
  const refreshBox = async () => {
    box = await canvas.boundingBox();
  };
  // viewport point at the center of a world cell
  const at = (cx, cy) => ({
    x: box.x + ((cx + 0.5) / GRID_W) * box.width,
    y: box.y + ((cy + 0.5) / GRID_H) * box.height,
  });
  const panel = async () => (await page.locator('.panel').innerText()).replace(/\s+/g, ' ');
  // Toggling god mode reflows the toolbar and MOVES the canvas — the cached
  // bounding box must be refreshed afterwards, which this helper does.
  const godToggle = async () => {
    await page.keyboard.press('g');
    await page.waitForTimeout(300);
    await refreshBox();
  };
  const loadPreset = async (id) => {
    await page.selectOption('.toolbar select', id);
    await page.waitForTimeout(300);
    await refreshBox();
  };
  // React-controlled range/number inputs ignore plain .fill(); go through the
  // native value setter so React sees the change.
  const setInput = (locator, v) =>
    locator.evaluate((el, val) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(v));
  const setSpeed = (v) => setInput(page.locator('label.slider:has-text("Speed") input'), v);
  const drawPipe = async (waypoints) => {
    await page.mouse.move(at(...waypoints[0]).x, at(...waypoints[0]).y);
    await page.mouse.down();
    for (const wp of waypoints.slice(1)) await page.mouse.move(at(...wp).x, at(...wp).y, { steps: 5 });
    await page.mouse.up();
  };
  const clickCell = async (cx, cy) => {
    await page.mouse.click(at(cx, cy).x, at(cx, cy).y);
  };
  const moveToCell = async (cx, cy) => {
    await page.mouse.move(at(cx, cy).x, at(cx, cy).y);
  };
  const hoverText = async (cx, cy) => {
    await moveToCell(cx, cy);
    await page.waitForTimeout(250);
    return await panel();
  };

  return {
    browser, page, errors, canvas,
    refreshBox, at, panel, godToggle, loadPreset, setInput, setSpeed,
    drawPipe, clickCell, moveToCell, hoverText,
  };
}

// Standard epilogue: assert a clean console, close, exit by failure count.
export async function finish({ browser, errors }) {
  ok('no console errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5));
  await browser.close();
  process.exit(failures ? 1 : 0);
}
