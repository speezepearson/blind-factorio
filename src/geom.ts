import type { Cell, Edge, Machine, MachineType, Pipeline, PortDef, Side } from './types';

// World dimensions, in fine cells, and the on-canvas pixel size of one cell.
export const GRID_W = 170;
export const GRID_H = 110;
export const CELL = 6;

export const DX = [0, 1, 0, -1]; // N E S W
export const DY = [-1, 0, 1, 0];
export const SIDE_NAMES = ['north', 'east', 'south', 'west'];

export const opposite = (s: Side): Side => (((s + 2) % 4) as Side);
export const rotateSide = (s: Side, times: number): Side => (((s + times) % 4) as Side);

export const cellKey = (x: number, y: number) => `${x},${y}`;
export const parseKey = (k: string): Cell => k.split(',').map(Number) as Cell;

export function dirFromTo(a: Cell, b: Cell): Side {
  if (b[1] < a[1]) return 0;
  if (b[0] > a[0]) return 1;
  if (b[1] > a[1]) return 2;
  return 3;
}

export interface OrientedPump {
  cell: Cell;
  inSide: Side;
  outSide: Side;
}

// Per-cell flow directions along a pipeline's path: each cell takes fluid in
// on the side facing the previous cell and passes it out toward the next.
// Endpoints point straight through — the first cell pulls from just before
// the path, the last pushes out just past it (that's where machine ports
// attach).
export function orientPath(path: Cell[]): OrientedPump[] {
  return path.map((cell, i) => {
    const prev = path[i - 1];
    const next = path[i + 1];
    let inSide: Side = 3;
    let outSide: Side = 1;
    if (prev) inSide = dirFromTo(cell, prev);
    if (next) outSide = dirFromTo(cell, next);
    if (!prev && next) inSide = opposite(outSide);
    if (prev && !next) outSide = opposite(inSide);
    if (inSide === outSide) outSide = opposite(inSide);
    return { cell, inSide, outSide };
  });
}

export const pipelinesAt = (pipelines: Pipeline[], [x, y]: Cell): Pipeline[] =>
  pipelines.filter((pl) => pl.cells.some(([cx, cy]) => cx === x && cy === y));

export const pipelineCellSet = (pipelines: Pipeline[]): Set<string> => {
  const set = new Set<string>();
  for (const pl of pipelines) for (const [x, y] of pl.cells) set.add(cellKey(x, y));
  return set;
};

export interface PlacedPort {
  def: PortDef;
  edges: Edge[]; // absolute grid coords
}

export interface PlacedMachine {
  machine: Machine;
  type: MachineType;
  cells: Cell[]; // absolute grid coords
  ports: PlacedPort[];
}

// Rotate the type's footprint `rotation` quarter-turns clockwise, normalize so
// the bounding box's top-left is (0,0), then translate to machine.origin.
export function placeMachine(machine: Machine, type: MachineType): PlacedMachine {
  const rot = ((machine.rotation % 4) + 4) % 4;
  const rotCell = ([x, y]: Cell): Cell => {
    for (let i = 0; i < rot; i++) [x, y] = [-y, x];
    return [x, y];
  };
  const rotated = type.cells.map(rotCell);
  const minX = Math.min(...rotated.map((c) => c[0]));
  const minY = Math.min(...rotated.map((c) => c[1]));
  const abs = ([x, y]: Cell): Cell => [x - minX + machine.origin[0], y - minY + machine.origin[1]];
  return {
    machine,
    type,
    cells: rotated.map(abs),
    ports: type.ports.map((p) => ({
      def: p,
      edges: p.edges.map(([c, s]): Edge => [abs(rotCell(c)), rotateSide(s, rot)]),
    })),
  };
}

export function machineCellMap(placed: PlacedMachine[]): Map<string, PlacedMachine> {
  const map = new Map<string, PlacedMachine>();
  for (const pm of placed) for (const [x, y] of pm.cells) map.set(cellKey(x, y), pm);
  return map;
}

// Pixel-space line segments tracing the outer boundary of a set of grid cells
// (used to outline a machine's footprint and, separately, a selection),
// given the pixel size of one cell.
export function perimeterSegments(cells: Cell[], cellPx: number): Array<[number, number, number, number]> {
  const cellSet = new Set(cells.map(([x, y]) => cellKey(x, y)));
  const segs: Array<[number, number, number, number]> = [];
  for (const [x, y] of cells) {
    for (let s = 0 as Side; s < 4; s = (s + 1) as Side) {
      if (cellSet.has(cellKey(x + DX[s], y + DY[s]))) continue;
      const x0 = x * cellPx + (s === 1 ? cellPx : 0);
      const y0 = y * cellPx + (s === 2 ? cellPx : 0);
      const x1 = x * cellPx + (s === 3 ? 0 : cellPx);
      const y1 = y * cellPx + (s === 0 ? 0 : cellPx);
      segs.push([x0, y0, x1, y1]);
    }
  }
  return segs;
}
