import type { Cell, Edge, Flow, FluidMap, MachineType } from './types';

export const RED = '#d63c3c';
export const GREEN = '#3aa845';
export const BLACK = '#23272e';

export const FLUID_NAMES: Record<string, string> = {
  [RED]: 'red',
  [GREEN]: 'green',
  [BLACK]: 'black',
};

export function dominant(fm: FluidMap): Flow | null {
  let best: Flow | null = null;
  for (const [color, rate] of Object.entries(fm)) {
    if (rate > 1e-4 && (!best || rate > best.rate)) best = { color, rate };
  }
  return best;
}

export function totalRate(fm: FluidMap | undefined): number {
  if (!fm) return 0;
  return Object.values(fm).reduce((a, b) => a + b, 0);
}

// Blend a FluidMap's colors into one, weighted by their rates.
function weightedMix(fm: FluidMap): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const total = totalRate(fm);
  const rgb = [0, 0, 0];
  for (const [color, rate] of Object.entries(fm)) {
    const [r, g, b] = parse(color);
    rgb[0] += (r * rate) / total;
    rgb[1] += (g * rate) / total;
    rgb[2] += (b * rate) / total;
  }
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

// Machine shapes are authored on a coarse grid and expanded onto the real
// (5x finer) grid, so each authored cell becomes a SCALE x SCALE block and
// each authored port edge becomes SCALE consecutive edges.
const SCALE = 5;

function scaleCells(cells: Cell[]): Cell[] {
  return cells.flatMap(([x, y]) => {
    const out: Cell[] = [];
    for (let i = 0; i < SCALE; i++) {
      for (let j = 0; j < SCALE; j++) out.push([x * SCALE + i, y * SCALE + j]);
    }
    return out;
  });
}

function scaleEdges(edges: Edge[]): Edge[] {
  return edges.flatMap(([[x, y], s]) => {
    const out: Edge[] = [];
    for (let i = 0; i < SCALE; i++) {
      if (s === 0) out.push([[x * SCALE + i, y * SCALE], 0]);
      else if (s === 2) out.push([[x * SCALE + i, y * SCALE + SCALE - 1], 2]);
      else if (s === 3) out.push([[x * SCALE, y * SCALE + i], 3]);
      else out.push([[x * SCALE + SCALE - 1, y * SCALE + i], 1]);
    }
    return out;
  });
}

// Pale version of a fluid color, used to tint a spring's body by its output.
export function paleTint(hex: string): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  const [r, g, b] = parse(hex);
  return `#${toHex(r + (255 - r) * 0.72)}${toHex(g + (255 - g) * 0.72)}${toHex(b + (255 - b) * 0.72)}`;
}

export const MACHINE_TYPES: MachineType[] = [
  {
    id: 'spring',
    name: 'Spring',
    bodyColor: '#f0c9c9',
    cells: scaleCells([[0, 0], [1, 0], [0, 1], [1, 1]]),
    ports: [
      { id: 'out', label: 'A', kind: 'out', edges: scaleEdges([[[0, 0], 0], [[1, 0], 0]]) },
    ],
    params: [
      { key: 'rate', label: 'Production rate (L/s)', kind: 'number', default: 2, min: 0, max: 10, step: 0.1 },
      { key: 'color', label: 'Fluid color', kind: 'color', default: RED },
    ],
    ruleText:
      'Produces fluid of its configured color at its configured rate at port A ' +
      '(defaults: red, 2 L/s). Needs no inputs.',
    compute: (_inputs, params) => ({ out: { [String(params.color)]: Number(params.rate) } }),
  },
  {
    id: 'reactor',
    name: 'Reactor',
    bodyColor: '#d8cfe8',
    // L-shape:  X .
    //           X X
    // Ports are deliberately tiny: a single fine-grid cell each.
    cells: scaleCells([[0, 0], [0, 1], [1, 1]]),
    ports: [
      { id: 'a', label: 'A', kind: 'in', edges: [[[0, 4], 3]] },
      { id: 'b', label: 'B', kind: 'in', edges: [[[9, 7], 1]] },
      { id: 'out', label: 'C', kind: 'out', edges: [[[2, 0], 0]] },
    ],
    ruleText:
      'If port A receives at least 1 L/s of red fluid and port B receives any green fluid, ' +
      'port C produces 1 − e^(−green rate) L/s of black fluid.',
    compute: (inputs): Record<string, FluidMap> => {
      const red = inputs.a?.[RED] ?? 0;
      const green = inputs.b?.[GREEN] ?? 0;
      if (red >= 1 && green > 1e-4) return { out: { [BLACK]: 1 - Math.exp(-green) } };
      return {};
    },
  },
  {
    id: 'funnel',
    name: 'Funnel',
    bodyColor: '#f4e3bc',
    cells: scaleCells([[0, 0], [1, 0], [2, 0]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3]]) },
      { id: 'out', label: 'B', kind: 'out', edges: scaleEdges([[[2, 0], 1]]) },
    ],
    ruleText:
      'Port B outputs everything arriving at port A: same total rate, blended into ' +
      'a single color weighted by rate.',
    compute: (inputs): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      if (total <= 1e-4) return {};
      return { out: { [weightedMix(fm)]: total } };
    },
  },
];

export const TYPE_BY_ID: Record<string, MachineType> = Object.fromEntries(
  MACHINE_TYPES.map((t) => [t.id, t]),
);
