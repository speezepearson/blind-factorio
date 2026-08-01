// Sides are 0=N, 1=E, 2=S, 3=W.
export type Side = 0 | 1 | 2 | 3;

export type Cell = [number, number];

// A fluid is identified by its light wavelength in nm (stored as the string
// key); a FluidMap is wavelength -> rate in L/s. Pipes, ports, and machine
// outputs all carry whole FluidMaps: a stream is a mixture of wavelengths,
// and only *draws* as their combined light (see light.ts).
export type FluidMap = Record<string, number>;

// An edge of the shape: a cell (in shape-local coords) plus which side of it.
export type Edge = [Cell, Side];

export interface PortDef {
  id: string;
  label: string;
  kind: 'in' | 'out';
  edges: Edge[];
}

// One row of a produced/target mixture: a wavelength and its rate.
export interface MixtureComponent {
  wl: number; // nm
  rate: number; // L/s
}

// A tunable per-machine-instance parameter: a plain number, a fluid
// wavelength (kind 'wavelength', 400-800 nm, shown as a slider with a live
// color swatch), or an arbitrary list of mixture components (kind 'mixture').
export type ParamValue = number | string | MixtureComponent[];

export interface ParamDef {
  key: string;
  label: string;
  kind: 'number' | 'wavelength' | 'mixture';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
}

// Passed to compute() each tick: elapsed sim time and a persistent, mutable
// per-machine-instance scratch object (empty for a fresh machine). Stateless
// machines simply ignore it.
export interface ComputeCtx {
  dt: number; // seconds of sim time this tick
  state: Record<string, unknown>;
}

export interface MachineType {
  id: string;
  name: string;
  bodyColor: string;
  cells: Cell[];
  ports: PortDef[];
  params?: ParamDef[];
  ruleText: string;
  compute: (
    inputs: Record<string, FluidMap>,
    params: Record<string, ParamValue>,
    ctx: ComputeCtx,
  ) => Record<string, FluidMap>;
  // optional exact body color derived from params (e.g. a spring painted
  // precisely like the fluid it produces); machines without it fall back to
  // a pale tint of their first wavelength param, or bodyColor
  fluidColor?: (params: Record<string, ParamValue>) => string;
  // optional one-line live summary of the machine's internal state
  describeState?: (state: Record<string, unknown>) => string;
  // optional halo color while the machine is in a special state (e.g. a
  // satisfied sink); null = no glow. Visible even in the player view.
  glow?: (state: Record<string, unknown>) => string | null;
}

export interface Machine {
  id: number;
  typeId: string;
  origin: Cell; // top-left of the rotated footprint's bounding box
  rotation: number; // quarter-turns clockwise, 0..3
  params?: Record<string, ParamValue>; // overrides of the type's param defaults
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
