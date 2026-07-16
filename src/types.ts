// Sides are 0=N, 1=E, 2=S, 3=W.
export type Side = 0 | 1 | 2 | 3;

export type Cell = [number, number];

// A fluid "color" is a CSS color string; a FluidMap is color -> rate in L/s.
export type FluidMap = Record<string, number>;

export interface Flow {
  color: string;
  rate: number;
}

// An edge of the shape: a cell (in shape-local coords) plus which side of it.
export type Edge = [Cell, Side];

export interface PortDef {
  id: string;
  label: string;
  kind: 'in' | 'out';
  edges: Edge[];
}

// A tunable per-machine-instance parameter, e.g. a spring's production rate.
export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface MachineType {
  id: string;
  name: string;
  bodyColor: string;
  cells: Cell[];
  ports: PortDef[];
  params?: ParamDef[];
  ruleText: string;
  compute: (inputs: Record<string, FluidMap>, params: Record<string, number>) => Record<string, FluidMap>;
}

export interface Machine {
  id: number;
  typeId: string;
  origin: Cell; // top-left of the rotated footprint's bounding box
  rotation: number; // quarter-turns clockwise, 0..3
  params?: Record<string, number>; // overrides of the type's param defaults
}

export interface Pump {
  inSide: Side;
  outSide: Side;
}

export interface World {
  w: number;
  h: number;
  // key "x,y" -> pumps in that cell: at most one horizontal and one vertical
  // straight pump may coexist; a bent pump occupies the whole cell.
  pumps: Map<string, Pump[]>;
  machines: Machine[];
  nextMachineId: number;
}
