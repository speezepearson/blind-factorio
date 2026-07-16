import type { Cell, Edge, Machine, MachineType, PortDef, Side } from './types';

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
