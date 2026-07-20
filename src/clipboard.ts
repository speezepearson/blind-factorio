import {
  CELL, cellKey, machineCellMap, mergePumps, parseKey, placeMachine, rotateSide,
} from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID } from './machines';
import { placeAll } from './sim';
import type { Cell, Machine, ParamValue, Pump, World } from './types';

// A selected patch of the world: a bounding box, the set of fine cells
// actually inside the selection, and the boundary polygon (for drawing).
// Squares and lassoed blobs are both just Regions.
export interface Region {
  tl: Cell; // bounding-box top-left, cells
  w: number; // bounding box, cells
  h: number;
  cells: Set<string>; // absolute cell keys inside the selection
  outline: Array<[number, number]>; // boundary polygon in px, relative to tl
}

export interface Clipboard {
  w: number; // bounding box, cells
  h: number;
  cells: Set<string>; // cell keys inside the selection, relative to the bbox
  outline: Array<[number, number]>; // boundary polygon in px, relative to the bbox
  machines: Array<{ typeId: string; rotation: number; rel: Cell; params?: Record<string, ParamValue> }>;
  pumps: Array<{ rel: Cell; pump: Pump }>;
  // visual snapshot of the copied region's bounding box at copy time — shown
  // (clipped to the outline) as the paste ghost
  snapshot?: HTMLCanvasElement;
}

// top-left cell that centers a w×h bounding box (roughly) on the cursor
export const bboxTL = (cell: Cell, w: number, h: number): Cell =>
  [cell[0] - Math.floor(w / 2), cell[1] - Math.floor(h / 2)];

export const squareTL = (cell: Cell, n: number): Cell => bboxTL(cell, n, n);

export function squareRegion(anchor: Cell, n: number): Region {
  const tl = squareTL(anchor, n);
  const cells = new Set<string>();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) cells.add(cellKey(tl[0] + x, tl[1] + y));
  }
  const px = n * CELL;
  return { tl, w: n, h: n, cells, outline: [[0, 0], [px, 0], [px, px], [0, px]] };
}

// even-odd ray cast
function pointInPolygon(x: number, y: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Rasterize a freehand lasso (a polygon in map px) to the cells whose centers
// fall inside it. Returns null if it encloses nothing.
export function lassoRegion(points: Array<[number, number]>): Region | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const cx0 = Math.floor(Math.min(...xs) / CELL);
  const cx1 = Math.floor(Math.max(...xs) / CELL);
  const cy0 = Math.floor(Math.min(...ys) / CELL);
  const cy1 = Math.floor(Math.max(...ys) / CELL);
  const cells = new Set<string>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!pointInPolygon((cx + 0.5) * CELL, (cy + 0.5) * CELL, points)) continue;
      cells.add(cellKey(cx, cy));
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
    }
  }
  if (cells.size === 0) return null;
  return {
    tl: [minX, minY],
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    cells,
    outline: points.map(([x, y]) => [x - minX * CELL, y - minY * CELL]),
  };
}

function rotateCanvas90(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.height;
  out.height = src.width;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return out;
}

// Rotate the whole clipboard a quarter-turn clockwise within its bounding
// box: cell (x,y) maps to (h-1-y, x), pump sides advance one step, machine
// rotations advance one step (with their bounding-box origin remapped
// accordingly), and the outline polygon turns with it.
export function rotateClipboard(clip: Clipboard): Clipboard {
  const h = clip.h;
  return {
    w: h,
    h: clip.w,
    cells: new Set(
      [...clip.cells].map((k) => {
        const [x, y] = parseKey(k);
        return cellKey(h - 1 - y, x);
      }),
    ),
    outline: clip.outline.map(([x, y]) => [h * CELL - y, x] as [number, number]),
    machines: clip.machines.map((m) => {
      const pm = placeMachine(
        { id: -1, typeId: m.typeId, origin: [0, 0], rotation: m.rotation },
        TYPE_BY_ID[m.typeId],
      );
      const mh = Math.max(...pm.cells.map((c) => c[1])) + 1;
      return { ...m, rotation: (m.rotation + 1) % 4, rel: [h - mh - m.rel[1], m.rel[0]] as Cell };
    }),
    pumps: clip.pumps.map((p) => ({
      rel: [h - 1 - p.rel[1], p.rel[0]] as Cell,
      pump: { inSide: rotateSide(p.pump.inSide, 1), outSide: rotateSide(p.pump.outSide, 1) },
    })),
    snapshot: clip.snapshot ? rotateCanvas90(clip.snapshot) : undefined,
  };
}

// Whether a placed machine's footprint fits: in bounds, off other machines,
// and off pumps. `ignoreId` excludes a machine (itself) from the collision
// check, for use while moving it.
export function machinePlacementOk(world: World, placed: PlacedMachine, ignoreId?: number): boolean {
  const occupied = machineCellMap(placeAll(world).filter((pm) => pm.machine.id !== ignoreId));
  return placed.cells.every(
    ([x, y]) =>
      x >= 0 && y >= 0 && x < world.w && y < world.h &&
      !occupied.has(cellKey(x, y)) && !world.pumps.has(cellKey(x, y)),
  );
}

export function captureRegion(world: World, region: Region): Clipboard {
  const [tlx, tly] = region.tl;
  const inside = ([x, y]: Cell) => region.cells.has(cellKey(x, y));
  const machines = placeAll(world)
    .filter((pm) => pm.cells.some(inside))
    .map((pm) => ({
      typeId: pm.machine.typeId,
      rotation: pm.machine.rotation,
      rel: [pm.machine.origin[0] - tlx, pm.machine.origin[1] - tly] as Cell,
      params: pm.machine.params ? { ...pm.machine.params } : undefined,
    }));
  const pumps: Clipboard['pumps'] = [];
  for (const [k, list] of world.pumps) {
    const [x, y] = parseKey(k);
    if (inside([x, y])) {
      for (const pump of list) pumps.push({ rel: [x - tlx, y - tly], pump: { ...pump } });
    }
  }
  return {
    w: region.w,
    h: region.h,
    cells: new Set(
      [...region.cells].map((k) => {
        const [x, y] = parseKey(k);
        return cellKey(x - tlx, y - tly);
      }),
    ),
    outline: region.outline,
    machines,
    pumps,
  };
}

// Stamp the clipboard down: machines that would collide are skipped;
// pumps overwrite pumps but never machines.
export function pasteClipboard(world: World, tl: Cell, clip: Clipboard): void {
  for (const m of clip.machines) {
    const machine: Machine = {
      id: world.nextMachineId,
      typeId: m.typeId,
      origin: [tl[0] + m.rel[0], tl[1] + m.rel[1]],
      rotation: m.rotation,
      params: m.params ? { ...m.params } : undefined,
    };
    if (machinePlacementOk(world, placeMachine(machine, TYPE_BY_ID[m.typeId]))) {
      world.machines.push(machine);
      world.nextMachineId++;
    }
  }
  const occupied = machineCellMap(placeAll(world));
  for (const p of clip.pumps) {
    const x = tl[0] + p.rel[0];
    const y = tl[1] + p.rel[1];
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
    const k = cellKey(x, y);
    if (!occupied.has(k)) world.pumps.set(k, mergePumps(world.pumps.get(k), { ...p.pump }));
  }
}
