import {
  cellKey, machineCellMap, mergePumps, parseKey, placeMachine, rotateSide,
} from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID } from './machines';
import { placeAll } from './sim';
import type { Cell, Machine, ParamValue, Pump, World } from './types';

export interface Clipboard {
  size: number;
  machines: Array<{ typeId: string; rotation: number; rel: Cell; params?: Record<string, ParamValue> }>;
  pumps: Array<{ rel: Cell; pump: Pump }>;
  // visual snapshot of the copied region at copy time — shown as the paste
  // ghost (blurred, outside god mode)
  snapshot?: HTMLCanvasElement;
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

// Rotate the whole clipboard square a quarter-turn clockwise: cell (x,y) maps
// to (n-1-y, x), pump sides advance one step, machine rotations advance one
// step (with their bounding-box origin remapped accordingly).
export function rotateClipboard(clip: Clipboard): Clipboard {
  const n = clip.size;
  return {
    size: n,
    machines: clip.machines.map((m) => {
      const pm = placeMachine(
        { id: -1, typeId: m.typeId, origin: [0, 0], rotation: m.rotation },
        TYPE_BY_ID[m.typeId],
      );
      const h = Math.max(...pm.cells.map((c) => c[1])) + 1;
      return { ...m, rotation: (m.rotation + 1) % 4, rel: [n - h - m.rel[1], m.rel[0]] as Cell };
    }),
    pumps: clip.pumps.map((p) => ({
      rel: [n - 1 - p.rel[1], p.rel[0]] as Cell,
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

// top-left of the size-n square centered (roughly) on the cursor
export const squareTL = (cell: Cell, n: number): Cell => [cell[0] - Math.floor(n / 2), cell[1] - Math.floor(n / 2)];

export function captureRegion(world: World, tl: Cell, n: number): Clipboard {
  const inSquare = ([x, y]: Cell) =>
    x >= tl[0] && x < tl[0] + n && y >= tl[1] && y < tl[1] + n;
  const machines = placeAll(world)
    .filter((pm) => pm.cells.some(inSquare))
    .map((pm) => ({
      typeId: pm.machine.typeId,
      rotation: pm.machine.rotation,
      rel: [pm.machine.origin[0] - tl[0], pm.machine.origin[1] - tl[1]] as Cell,
      params: pm.machine.params ? { ...pm.machine.params } : undefined,
    }));
  const pumps: Clipboard['pumps'] = [];
  for (const [k, list] of world.pumps) {
    const [x, y] = parseKey(k);
    if (inSquare([x, y])) {
      for (const pump of list) pumps.push({ rel: [x - tl[0], y - tl[1]], pump: { ...pump } });
    }
  }
  return { size: n, machines, pumps };
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
