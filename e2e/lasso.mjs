// Free-select (lasso) copy/erase: lassoed captures, mid-drag overlay,
// erase+undo, click-square fallback, clipboard rotation.
import { GRID_W, finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, at, panel, godToggle, clickCell, moveToCell, drawPipe, canvas } = d;

// A lassoed machine keeps its offset inside the clipboard bbox (and may even
// stick out of it), so after a paste we scan around the click point for it.
const springNear = async (cx, cy) => {
  for (let y = cy - 12; y <= cy + 16; y += 4) {
    for (let x = cx - 12; x <= cx + 16; x += 4) {
      await moveToCell(x, y);
      await page.waitForTimeout(60);
      if (/Spring/.test(await panel())) return true;
    }
  }
  return false;
};

// circle of viewport points around a cell
const circle = async (cx, cy, rCells, n = 28) => {
  const c = at(cx, cy);
  const box = await canvas.boundingBox();
  const r = (rCells / GRID_W) * box.width;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
};
const lasso = async (pts) => {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts) await page.mouse.move(p.x, p.y);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.up();
};

// --- lasso copy in player mode: circle the spring at (25,35) ---
await page.click('button:has-text("Copy/paste")');
await lasso(await circle(25, 35, 9));
await moveToCell(60, 100); // empty ground: hover outranks clipboard summary
await page.waitForTimeout(250);
ok('lasso copy captured spring', /holds 1 machine/.test(await panel()));

// paste it far away, verify in god mode
await clickCell(120, 20);
await page.keyboard.press('Escape');
await godToggle();
ok('lasso-pasted spring visible to god', await springNear(120, 20));

// --- overlay visibly drawn mid-lasso (god mode, crisp) ---
await page.click('button:has-text("Erase")');
const grab = () => page.evaluate(() => {
  const ctx = document.querySelector('canvas').getContext('2d');
  return Array.from(ctx.getImageData(500, 300, 120, 120).data);
});
const before = await grab();
const pts = await circle(95, 55, 12);
await page.mouse.move(pts[0].x, pts[0].y);
await page.mouse.down();
for (const p of pts.slice(0, 20)) await page.mouse.move(p.x, p.y);
await page.waitForTimeout(100);
const during = await grab();
let diff = 0;
for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - during[i]) > 8) diff++;
ok('lasso overlay visible mid-drag', diff > 50);
// abandon this lasso: finish the loop where it started
for (const p of pts.slice(20)) await page.mouse.move(p.x, p.y);
await page.mouse.up();
await page.keyboard.press('Control+z'); // undo that stray erase, if it hit anything

// --- lasso erase: draw a pipe, circle it, verify gone; undo restores ---
await page.click('button:has-text("Pipes")');
await drawPipe([[45, 94], [70, 94]]);
await page.waitForTimeout(200);
await moveToCell(55, 94);
await page.waitForTimeout(250);
ok('pipe placed', /Pipeline #/.test(await panel()));
await page.click('button:has-text("Erase")');
await lasso(await circle(57, 94, 14));
await page.click('button:has-text("Pipes")');
await moveToCell(55, 94);
await moveToCell(56, 94);
await page.waitForTimeout(250);
ok('lasso erase removed pipe', !/Pipeline #/.test(await panel()));
await page.keyboard.press('Control+z');
await moveToCell(55, 94);
await moveToCell(56, 94);
await page.waitForTimeout(250);
ok('undo restored pipe', /Pipeline #/.test(await panel()));

// --- click still selects the square (copy + erase) ---
await godToggle(); // back to player mode
await page.click('button:has-text("Copy/paste")');
await clickCell(55, 94); // 19x19 square over the pipe
await moveToCell(60, 105);
await page.waitForTimeout(250);
{
  const t = await panel();
  ok('click-copy square captured the pipe', /holds 0 machines and [1-9]\d* pipes?/.test(t));
  if (!/holds 0 machines and [1-9]\d* pipes?/.test(t)) console.log('  panel was:', t.slice(0, 140));
}
await page.keyboard.press('Escape');
await page.click('button:has-text("Erase")');
await clickCell(55, 94);
await page.click('button:has-text("Pipes")');
await moveToCell(55, 94);
await moveToCell(56, 94);
await page.waitForTimeout(250);
ok('click-erase square removed pipe', !/Pipeline #/.test(await panel()));
await page.keyboard.press('Control+z');

// --- rotate a lasso clipboard, paste, no crash ---
await page.click('button:has-text("Copy/paste")');
await lasso(await circle(25, 35, 9));
await page.keyboard.press('r');
await clickCell(140, 90);
await page.keyboard.press('Escape');
await godToggle();
ok('rotated lasso clipboard pasted', await springNear(140, 88));

await finish(d);
