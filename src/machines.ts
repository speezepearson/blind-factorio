import type { Cell, Edge, FluidMap, MachineType } from './types';

export function totalRate(fm: FluidMap | undefined): number {
  if (!fm) return 0;
  return Object.values(fm).reduce((a, b) => a + b, 0);
}

const parseHex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Distances between colors are expressed as a fraction of the largest
// possible RGB distance (black to white).
const MAX_COLOR_DIST = Math.sqrt(3) * 255;

const colorDist = (a: string, b: string): number => {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) / MAX_COLOR_DIST;
};

// Total rate of fluid whose color lies within `tolerance` (0..1) of target.
function rateNear(fm: FluidMap, target: string, tolerance: number): number {
  let sum = 0;
  for (const [color, rate] of Object.entries(fm)) {
    if (colorDist(color, target) <= tolerance + 1e-9) sum += rate;
  }
  return sum;
}

function toHexColor(rgb: number[]): string {
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// Blend a FluidMap's colors into one, weighted by their rates. This is what a
// mixture *looks* like flowing in a pipe.
export function weightedMix(fm: FluidMap): string {
  const total = totalRate(fm);
  if (total <= 0) return '#000000';
  const rgb = [0, 0, 0];
  for (const [color, rate] of Object.entries(fm)) {
    const [r, g, b] = parseHex(color);
    rgb[0] += (r * rate) / total;
    rgb[1] += (g * rate) / total;
    rgb[2] += (b * rate) / total;
  }
  return toHexColor(rgb);
}

export const RED = '#d63c3c';
export const GREEN = '#3aa845';
export const BLUE = '#3c50d6';
export const BLACK = '#23272e';
// The exact pigment a red+blue mixture *looks* like: a pipe carrying
// {MAGENTA: 2} and a pipe carrying {RED: 1, BLUE: 1} are indistinguishable
// by eye — but they are different fluids.
export const MAGENTA = weightedMix({ [RED]: 1, [BLUE]: 1 });

export const FLUID_NAMES: Record<string, string> = {
  [RED]: 'red',
  [GREEN]: 'green',
  [BLUE]: 'blue',
  [BLACK]: 'black',
  [MAGENTA]: 'magenta',
};

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

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// target mixture from a two-color + share parametrization (shares sum to 1)
function targetMixture(colorA: string, colorB: string, mixB: number): FluidMap {
  const t: FluidMap = {};
  const add = (color: string, share: number) => {
    if (share > 1e-6) t[color] = (t[color] ?? 0) + share;
  };
  add(colorA, 1 - mixB);
  add(colorB, mixB);
  return t;
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
      { key: 'colorB', label: 'Fluid color B', kind: 'color', default: RED },
      { key: 'mixB', label: 'Share of color B', kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    ],
    ruleText:
      'Produces fluid at its configured rate at port A: a mixture of its two configured ' +
      'colors in the configured shares (share 0 = pure color A, the default). Needs no inputs.',
    compute: (_inputs, params): Record<string, FluidMap> => {
      const rate = Number(params.rate);
      const mix = clamp01(Number(params.mixB));
      const out: FluidMap = {};
      for (const [color, share] of Object.entries(
        targetMixture(String(params.color), String(params.colorB), mix),
      )) {
        out[color] = rate * share;
      }
      return { out };
    },
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
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3], [[0, 1], 3]]) },
      { id: 'out', label: 'B', kind: 'out', edges: scaleEdges([[[2, 0], 1]]) },
    ],
    ruleText:
      'Merges every stream arriving at port A and passes the combined mixture out ' +
      'port B, untouched: every pigment keeps its identity and rate.',
    compute: (inputs): Record<string, FluidMap> => ({ out: { ...(inputs.in ?? {}) } }),
  },
  {
    id: 'blender',
    name: 'Blender',
    bodyColor: '#cfe3c9',
    cells: scaleCells([[0, 0], [1, 0], [2, 0], [1, 1]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3]]) },
      { id: 'out', label: 'B', kind: 'out', edges: scaleEdges([[[2, 0], 1]]) },
    ],
    ruleText:
      'Irreversibly blends the mixture arriving at port A into a single new pigment: ' +
      'same total rate, color = the rate-weighted average. The mixture already looked ' +
      'like that color in the pipe — after the blender, it really is one fluid.',
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
      { key: 'target', label: 'Target color', kind: 'color', default: RED },
      { key: 'tol', label: 'Color tolerance', kind: 'number', default: 0.2, min: 0, max: 1, step: 0.01 },
    ],
    ruleText:
      'Splits the incoming mixture by pigment: components within its color tolerance of ' +
      'the target color flow out port B, everything else out port C. Rates are conserved; ' +
      'it cannot split a single pigment (a blended magenta is not red + blue).',
    compute: (inputs, params): Record<string, FluidMap> => {
      const near: FluidMap = {};
      const far: FluidMap = {};
      const target = String(params.target);
      const tol = Number(params.tol);
      for (const [color, rate] of Object.entries(inputs.in ?? {})) {
        (colorDist(color, target) <= tol + 1e-9 ? near : far)[color] = rate;
      }
      return { near, far };
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
      'capacity liters. Then it stops accepting and dumps its contents — the stored ' +
      'mixture, in proportion — out port B at its drain rate until empty, whereupon ' +
      'it starts accepting again.',
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
      const out: FluidMap = {};
      for (const [color, amt] of Object.entries(stored)) out[color] = (rate * amt) / held;
      const keep = 1 - (rate * ctx.dt) / held;
      for (const k of Object.keys(stored)) {
        stored[k] *= keep;
        if (stored[k] <= 1e-9) delete stored[k];
      }
      return { out };
    },
    describeState: (state) => {
      const stored = (state.stored as FluidMap | undefined) ?? {};
      const held = totalRate(stored);
      return `Holding ${held.toFixed(1)} L, ${state.draining ? 'draining' : 'filling'}.`;
    },
  },
  {
    id: 'sink',
    name: 'Sink',
    bodyColor: '#b9b2a6',
    cells: scaleCells([[0, 0], [1, 0], [0, 1], [1, 1]]),
    ports: [
      {
        id: 'in',
        label: 'A',
        kind: 'in',
        edges: scaleEdges([
          [[0, 0], 0], [[1, 0], 0],
          [[1, 0], 1], [[1, 1], 1],
          [[0, 1], 2], [[1, 1], 2],
          [[0, 0], 3], [[0, 1], 3],
        ]),
      },
    ],
    params: [
      { key: 'colorA', label: 'Target color A', kind: 'color', default: MAGENTA },
      { key: 'colorB', label: 'Target color B', kind: 'color', default: MAGENTA },
      { key: 'mixB', label: 'Share of color B', kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
      { key: 'tol', label: 'Color tolerance', kind: 'number', default: 0.12, min: 0, max: 1, step: 0.01 },
    ],
    ruleText:
      'Slurps up everything fed into any side. Lights up while the incoming mixture ' +
      'matches its target mixture (two colors in configured shares): each target ' +
      "component must make up its share of what's arriving, judged by pigment within " +
      'the color tolerance — the right-looking color made of the wrong pigments stays ' +
      'dark. Needs at least 0.5 L/s in total.',
    compute: (inputs, params, ctx): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      const target = targetMixture(
        String(params.colorA), String(params.colorB), clamp01(Number(params.mixB)),
      );
      let score = 0;
      for (const [color, share] of Object.entries(target)) {
        const got = total > 1e-4 ? rateNear(fm, color, Number(params.tol)) / total : 0;
        score += Math.min(share, got);
      }
      const st = ctx.state as { rate?: number; score?: number; lit?: boolean };
      st.rate = total;
      st.score = score;
      st.lit = total >= 0.5 && score >= 0.85;
      return {};
    },
    describeState: (state) => {
      const rate = (state.rate as number | undefined) ?? 0;
      const score = (state.score as number | undefined) ?? 0;
      return `Drinking ${rate.toFixed(2)} L/s — ${Math.round(score * 100)}% match, ${state.lit ? 'LIT' : 'dark'}.`;
    },
    glow: (state) => (state.lit ? '#ffd84a' : null),
  },
];

export const TYPE_BY_ID: Record<string, MachineType> = Object.fromEntries(
  MACHINE_TYPES.map((t) => [t.id, t]),
);
