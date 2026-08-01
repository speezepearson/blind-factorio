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
// color swatch), an arbitrary list of mixture components (kind 'mixture'),
// or one of a fixed set of choices (kind 'choice', shown as a dropdown).
export type ParamValue = number | string | MixtureComponent[];

export interface ParamDef {
  key: string;
  label: string;
  kind: 'number' | 'wavelength' | 'mixture' | 'choice';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>; // for kind 'choice'
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
  // optional 0..1 progress bar drawn on the body (e.g. a fabricator's build
  // progress); null = no bar. Deliberately visible even in the player view.
  progress?: (state: Record<string, unknown>) => number | null;
}

export interface Machine {
  id: number;
  typeId: string;
  origin: Cell; // top-left of the rotated footprint's bounding box
  rotation: number; // quarter-turns clockwise, 0..3
  params?: Record<string, ParamValue>; // overrides of the type's param defaults
  // A ghost is a placeholder the player couldn't afford: it reserves its
  // footprint but does nothing in the sim (no ports, no compute).
  ghost?: boolean;
}

// A stretch of pipe: an ordered path of cells along which fluid flows, one
// cell per tick, from cells[0] to the far end. Endpoints attach
// positionally, by touch: an out-port edge on any side of the head cell is
// its source and an in-port edge on any side of the tail cell its
// destination (the straight-through side wins if several qualify);
// alternatively, a head or tail cell sitting ON a junction attaches to that
// junction. So pipelines are directed edges in a graph whose nodes are
// machines and junctions. Any number of pipelines may pass through the same
// cell; only endpoints ever connect.
export interface Pipeline {
  id: number;
  cells: Cell[];
  // Ghost pipe: laid out but unbuilt (the player ran out of pipe budget).
  // Carries nothing and never attaches; just reserves the route.
  ghost?: boolean;
}

// A merge/split node created by ending (or starting) a pipe drag on an
// existing pipe: sums whatever its inflow pipes deliver and splits the total
// evenly among its outflow pipes.
export interface Junction {
  id: number;
  cell: Cell;
}

// The player's stock of parts: total pipe length (in cells) and a count of
// each machine type. Building in player mode spends it, erasing refunds it;
// anything the player can't afford goes down as a ghost. God mode ignores
// the budget entirely (and can edit it).
export interface Budget {
  pipe: number;
  machines: Record<string, number>; // typeId -> count
}

export interface World {
  w: number;
  h: number;
  pipelines: Pipeline[];
  junctions: Junction[];
  machines: Machine[];
  budget: Budget;
  nextMachineId: number;
  nextPipelineId: number;
  nextJunctionId: number;
}
