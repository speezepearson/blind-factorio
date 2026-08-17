import { refundMachine, refundPipe, takeMachine, takePipe } from './budget';
import {
  CELL, cellKey, machineCellMap, parseKey, pipelineCellSet, placeMachine,
} from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID } from './machines';
import { placeAll } from './sim';
import type { Cell, Machine, ParamValue, Pipeline, World } from './types';

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
  pipelines: Array<{ cells: Cell[] }>; // cells relative to the bbox, in flow order
  junctions: Array<{ rel: Cell }>;
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
// box: cell (x,y) maps to (h-1-y, x), machine rotations advance one step
// (with their bounding-box origin remapped accordingly), and the outline
// polygon turns with it. Pipeline flow direction is implicit in cell order,
// so pipe rotation is pure geometry.
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
    // flow direction is implicit in cell order, so rotation is just geometry
    pipelines: clip.pipelines.map((pl) => ({
      cells: pl.cells.map(([x, y]) => [h - 1 - y, x] as Cell),
    })),
    junctions: clip.junctions.map((j) => ({ rel: [h - 1 - j.rel[1], j.rel[0]] as Cell })),
    snapshot: clip.snapshot ? rotateCanvas90(clip.snapshot) : undefined,
  };
}

// Whether a placed machine's footprint fits: in bounds, off other machines,
// and off pipes and junctions. `ignoreId` excludes a machine (itself) from
// the collision check, for use while moving it.
export function machinePlacementOk(world: World, placed: PlacedMachine, ignoreId?: number): boolean {
  const occupied = machineCellMap(placeAll(world).filter((pm) => pm.machine.id !== ignoreId));
  const pipeCells = pipelineCellSet(world.pipelines);
  for (const j of world.junctions) pipeCells.add(cellKey(j.cell[0], j.cell[1]));
  return placed.cells.every(
    ([x, y]) =>
      x >= 0 && y >= 0 && x < world.w && y < world.h &&
      !occupied.has(cellKey(x, y)) && !pipeCells.has(cellKey(x, y)),
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
  // like machines, a pipeline overlapping the selection at all is taken whole
  const pipelines: Clipboard['pipelines'] = world.pipelines
    .filter((pl) => pl.cells.some(inside))
    .map((pl) => ({ cells: pl.cells.map(([x, y]) => [x - tlx, y - tly] as Cell) }));
  const junctions: Clipboard['junctions'] = world.junctions
    .filter((j) => inside(j.cell))
    .map((j) => ({ rel: [j.cell[0] - tlx, j.cell[1] - tly] as Cell }));
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
    pipelines,
    junctions,
  };
}

// Stamp the clipboard down: machines that would collide are skipped, and a
// pipeline is skipped whole if any of its cells lands out of bounds or on a
// machine. With useBudget (player mode), each placement spends the world's
// budget; whatever can't be paid for still lands, but as a ghost. (Copying
// always captures things as real — a copied ghost pastes as real if the
// budget covers it by then.)
export function pasteClipboard(world: World, tl: Cell, clip: Clipboard, useBudget: boolean): void {
  for (const m of clip.machines) {
    const machine: Machine = {
      id: world.nextMachineId,
      typeId: m.typeId,
      origin: [tl[0] + m.rel[0], tl[1] + m.rel[1]],
      rotation: m.rotation,
      params: m.params ? { ...m.params } : undefined,
    };
    if (useBudget && !takeMachine(world.budget, m.typeId)) machine.ghost = true;
    if (machinePlacementOk(world, placeMachine(machine, TYPE_BY_ID[m.typeId]))) {
      world.machines.push(machine);
      world.nextMachineId++;
    } else if (useBudget && !machine.ghost) {
      refundMachine(world.budget, m.typeId); // didn't fit — put it back in stock
    }
  }
  const occupied = machineCellMap(placeAll(world));
  for (const j of clip.junctions) {
    const cell: Cell = [tl[0] + j.rel[0], tl[1] + j.rel[1]];
    const clear =
      cell[0] >= 0 && cell[1] >= 0 && cell[0] < world.w && cell[1] < world.h &&
      !occupied.has(cellKey(cell[0], cell[1])) &&
      !world.junctions.some((existing) => existing.cell[0] === cell[0] && existing.cell[1] === cell[1]);
    if (clear) world.junctions.push({ id: world.nextJunctionId++, cell });
  }
  for (const pl of clip.pipelines) {
    const cells = pl.cells.map(([x, y]) => [tl[0] + x, tl[1] + y] as Cell);
    const ok = cells.every(
      ([x, y]) => x >= 0 && y >= 0 && x < world.w && y < world.h && !occupied.has(cellKey(x, y)),
    );
    if (ok && cells.length > 0) {
      const pipeline: Pipeline = { id: world.nextPipelineId++, cells };
      // whole pipelines only — a pasted pipe is either all real or all ghost
      if (useBudget) {
        const got = takePipe(world.budget, cells.length);
        if (got < cells.length) {
          refundPipe(world.budget, got);
          pipeline.ghost = true;
        }
      }
      world.pipelines.push(pipeline);
    }
  }
}
