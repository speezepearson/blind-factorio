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

const parseHex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Distances between colors are expressed as a fraction of the largest
// possible RGB distance (black to white).
const MAX_COLOR_DIST = Math.sqrt(3) * 255;

// Total rate of fluid whose color lies within `tolerance` (0..1) of target.
function rateNear(fm: FluidMap, target: string, tolerance: number): number {
  const t = parseHex(target);
  let sum = 0;
  for (const [color, rate] of Object.entries(fm)) {
    const c = parseHex(color);
    const d = Math.hypot(c[0] - t[0], c[1] - t[1], c[2] - t[2]) / MAX_COLOR_DIST;
    if (d <= tolerance + 1e-9) sum += rate;
  }
  return sum;
}

function toHexColor(rgb: number[]): string {
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// Blend a FluidMap's colors into one, weighted by their rates.
function weightedMix(fm: FluidMap): string {
  const total = totalRate(fm);
  const rgb = [0, 0, 0];
  for (const [color, rate] of Object.entries(fm)) {
    const [r, g, b] = parseHex(color);
    rgb[0] += (r * rate) / total;
    rgb[1] += (g * rate) / total;
    rgb[2] += (b * rate) / total;
  }
  return toHexColor(rgb);
}

// Machine shapes are authored on a coarse grid and expanded onto the real
// (5x finer) grid, so each authored cell becomes a SCALE x SCALE block and
// each authored port edge becomes SCALE consecutive edges.
export const SCALE = 5;

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

// Pale version of a fluid color, used to tint a machine body by its color param.
export function paleTint(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return toHexColor([r + (255 - r) * 0.72, g + (255 - g) * 0.72, b + (255 - b) * 0.72]);
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
    params: [
      { key: 'tolA', label: 'Port A red tolerance', kind: 'number', default: 0.15, min: 0, max: 1, step: 0.01 },
      { key: 'tolB', label: 'Port B green tolerance', kind: 'number', default: 0.15, min: 0, max: 1, step: 0.01 },
    ],
    ruleText:
      'If port A receives at least 1 L/s of fluid within its tolerance of red, and port B ' +
      'receives any fluid within its tolerance of green, port C produces 1 − e^(−green rate) ' +
      'L/s of black fluid. Tolerances are fractions of the black-to-white color distance.',
    compute: (inputs, params): Record<string, FluidMap> => {
      const red = rateNear(inputs.a ?? {}, RED, Number(params.tolA));
      const green = rateNear(inputs.b ?? {}, GREEN, Number(params.tolB));
      if (red >= 1 && green > 1e-4) return { out: { [BLACK]: 1 - Math.exp(-green) } };
      return {};
    },
  },
  {
    id: 'funnel',
    name: 'Funnel',
    bodyColor: '#f4e3bc',
    cells: scaleCells([[0, 0], [1, 0], [2, 0], [0, 1]]),
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
  {
    id: 'filter',
    name: 'Filter',
    bodyColor: '#e3d3d3',
    // Lopsided sideways Y:  ---+--   input flows in the west end of the long
    //                          '--   arm; filtrate continues straight out the
    // east-top end, waste forks out the shorter east-bottom arm.
    cells: scaleCells([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [5, 1]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3]]) },
      { id: 'near', label: 'B', kind: 'out', edges: scaleEdges([[[5, 0], 1]]) },
      { id: 'far', label: 'C', kind: 'out', edges: scaleEdges([[[5, 1], 1]]) },
    ],
    params: [
      { key: 'strength', label: 'Strength', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'target', label: 'Target color', kind: 'color', default: RED },
    ],
    ruleText:
      'Mixes its input like a funnel, then splits it in half. Port B carries the mixture ' +
      'pulled strength-of-the-way toward the target color; port C carries the mirror image, ' +
      'pushed equally far away. Strength self-limits so C stays a real color — total ' +
      'pigment (rate × color) is conserved.',
    compute: (inputs, params): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      if (total <= 1e-4) return {};
      const m = parseHex(weightedMix(fm));
      const t = parseHex(String(params.target));
      let s = Math.max(0, Math.min(1, Number(params.strength)));
      // largest strength for which the mirror color stays inside RGB gamut
      for (let i = 0; i < 3; i++) {
        const d = t[i] - m[i];
        if (d > 0) s = Math.min(s, m[i] / d);
        else if (d < 0) s = Math.min(s, (255 - m[i]) / -d);
      }
      const near = m.map((v, i) => v + s * (t[i] - m[i]));
      const far = m.map((v, i) => v - s * (t[i] - m[i]));
      return {
        near: { [toHexColor(near)]: total / 2 },
        far: { [toHexColor(far)]: total / 2 },
      };
    },
  },
  {
    id: 'buffer',
    name: 'Buffer',
    bodyColor: '#cbd7e3',
    cells: scaleCells([[0, 0], [1, 0], [0, 2], [0, 1], [1, 1]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3], [[0, 1], 3]]) },
      { id: 'out', label: 'B', kind: 'out', edges: scaleEdges([[[1, 0], 1], [[1, 1], 1]]) },
    ],
    params: [
      { key: 'capacity', label: 'Capacity (L)', kind: 'number', default: 20, min: 1, max: 100, step: 1 },
      { key: 'drainRate', label: 'Drain rate (L/s)', kind: 'number', default: 10, min: 0.5, max: 50, step: 0.5 },
    ],
    ruleText:
      'Accepts fluid at port A, remembering everything it takes in, until it holds ' +
      'capacity liters. Then it stops accepting and dumps its contents — blended into ' +
      'one color — out port B at its drain rate until empty, whereupon it starts ' +
      'accepting again.',
    compute: (inputs, params, ctx): Record<string, FluidMap> => {
      const st = ctx.state as { stored?: FluidMap; draining?: boolean };
      const stored = (st.stored ??= {});
      const capacity = Math.max(0.1, Number(params.capacity));

      if (!st.draining) {
        for (const [color, rate] of Object.entries(inputs.in ?? {})) {
          stored[color] = (stored[color] ?? 0) + rate * ctx.dt;
        }
        if (totalRate(stored) >= capacity) st.draining = true;
        return {};
      }

      const held = totalRate(stored);
      if (held <= 1e-6) {
        st.stored = {};
        st.draining = false;
        return {};
      }
      const rate = Math.min(Math.max(0, Number(params.drainRate)), held / ctx.dt);
      const color = weightedMix(stored);
      const keep = 1 - (rate * ctx.dt) / held;
      for (const k of Object.keys(stored)) {
        stored[k] *= keep;
        if (stored[k] <= 1e-9) delete stored[k];
      }
      return { out: { [color]: rate } };
    },
    describeState: (state) => {
      const stored = (state.stored as FluidMap | undefined) ?? {};
      const held = totalRate(stored);
      return `Holding ${held.toFixed(1)} L, ${state.draining ? 'draining' : 'filling'}.`;
    },
  },
];

export const TYPE_BY_ID: Record<string, MachineType> = Object.fromEntries(
  MACHINE_TYPES.map((t) => [t.id, t]),
);
