// Starter-world basics: player secrecy, blind pipe drawing, undo,
// copy/paste, god-mode editing/moving/erasing, buffer state line.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { page, panel, clickCell, moveToCell, hoverText, drawPipe, godToggle } = d;

// player: hover
ok('player machine hover', /keeps its secrets/.test(await hoverText(25, 35)));

// blind pipe draw + undo
await drawPipe([[45, 94], [70, 94]]);
await page.waitForTimeout(250);
ok('pipe placed + hoverable', /pipe keeps its secrets/.test(await hoverText(55, 94)));
await page.keyboard.press('Control+z');
await moveToCell(55, 94);
ok('undo removed pipe', !/pipe keeps its secrets/.test(await hoverText(56, 94)));

// copy/paste round trip (read the panel from empty ground: hover outranks
// the clipboard summary)
await page.click('button:has-text("Copy/paste")');
await clickCell(25, 35);
ok('copy captured spring', /holds 1 machine/.test(await hoverText(60, 100)));
await moveToCell(120, 20);
await clickCell(120, 20);
await page.waitForTimeout(300);
await page.keyboard.press('Escape');

// god mode: sliders, param edit, drag machine, erase
await godToggle();
const sliders = (await page.locator('.toolbar label.slider').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
ok('2 sliders w/ defaults', JSON.stringify(sliders) === JSON.stringify(['19×19', 'Speed: 1×']));
ok('pasted spring visible to god', /Spring/.test(await hoverText(120, 20)));
await page.click('button:has-text("Edit")');
await clickCell(120, 20);
await page.waitForTimeout(200);
ok('edit panel has mixture editor', /Produced mixture/.test(await panel()) && /650 nm/.test(await panel()));
// drag the pasted spring right
await moveToCell(122, 22);
await page.mouse.down();
await moveToCell(135, 22);
await page.mouse.up();
await page.waitForTimeout(200);
ok('machine dragged', /Spring/.test(await hoverText(133, 22)));
// erase it
await page.click('button:has-text("Erase")');
await clickCell(133, 22);
await page.waitForTimeout(200);
await page.click('button:has-text("Edit")');
{
  const t = await hoverText(133, 22);
  ok('machine erased', !/Spring [AB]?/.test(t.split('Edit')[0]) || /Click a machine/.test(t));
}

// buffer state line (leave edit mode first: its panel replaces the inspector)
await page.click('button:has-text("Pipes")');
ok('buffer state line', /Holding .* L/.test(await hoverText(155, 80)));

await finish(d);
