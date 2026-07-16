import type { Cell, Edge, Machine, MachineType, PortDef, Pump, Side } from './types';

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

// Given the cells a pipe passes through, orient a pump in each cell so fluid
// flows along the path. Endpoints point straight through.
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

export type PumpAxis = 'h' | 'v' | 'bent';

export function pumpAxis(p: Pump): PumpAxis {
  const hIn = p.inSide % 2 === 1; // E/W are odd sides
  const hOut = p.outSide % 2 === 1;
  if (hIn && hOut) return 'h';
  if (!hIn && !hOut) return 'v';
  return 'bent';
}

// Merge a new pump into a cell's pump list. Straight pumps on perpendicular
// axes cross without interfering; everything else replaces what's in the way.
export function mergePumps(existing: Pump[] | undefined, p: Pump): Pump[] {
  const axis = pumpAxis(p);
  if (!existing || axis === 'bent') return [p];
  const keep = existing.filter((q) => pumpAxis(q) !== axis && pumpAxis(q) !== 'bent');
  return [...keep, p];
}

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
