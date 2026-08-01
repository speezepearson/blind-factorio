import { WL_MAX, WL_MIN, mixtureColor } from './light';
import type { Cell, Edge, FluidMap, MachineType, ParamValue } from './types';

export function totalRate(fm: FluidMap | undefined): number {
  if (!fm) return 0;
  return Object.values(fm).reduce((a, b) => a + b, 0);
}

// a param value as a sane wavelength (old worlds may hold junk)
export function asWavelength(v: unknown, fallback = 650): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(WL_MIN, Math.min(WL_MAX, Math.round(n))) : fallback;
}

// Total rate of fluid whose wavelength lies within `tolNm` of target.
function rateNear(fm: FluidMap, targetWl: number, tolNm: number): number {
  let sum = 0;
  for (const [wl, rate] of Object.entries(fm)) {
    if (Math.abs(Number(wl) - targetWl) <= tolNm + 1e-9) sum += rate;
  }
  return sum;
}

// rate-weighted average wavelength of a mixture
function meanWavelength(fm: FluidMap): number {
  let sum = 0;
  let total = 0;
  for (const [wl, rate] of Object.entries(fm)) {
    sum += Number(wl) * rate;
    total += rate;
  }
  return Math.round(sum / total);
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

const parseHex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Pale version of a color, used to tint a machine body by its wavelength param.
export function paleTint(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  const mix = (v: number) => v + (255 - v) * 0.72;
  return `#${c(mix(r))}${c(mix(g))}${c(mix(b))}`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// target mixture from a two-wavelength + share parametrization (shares sum to 1)
function targetMixture(wlA: number, wlB: number, mixB: number): FluidMap {
  const t: FluidMap = {};
  const add = (wl: number, share: number) => {
    if (share > 1e-6) t[wl] = (t[wl] ?? 0) + share;
  };
  add(wlA, 1 - mixB);
  add(wlB, mixB);
  return t;
}

// the exact color of the two-wavelength mixture a machine produces/wants
const twoWlColor = (params: Record<string, ParamValue>, fallbackWl: number): string =>
  mixtureColor(targetMixture(
    asWavelength(params.colorA ?? params.color, fallbackWl),
    asWavelength(params.colorB, fallbackWl),
    clamp01(Number(params.mixB)),
  ));

// the full perimeter of a scaled 2x2 shape, for machines open on every side
const RING_2X2: Edge[] = scaleEdges([
  [[0, 0], 0], [[1, 0], 0],
  [[1, 0], 1], [[1, 1], 1],
  [[0, 1], 2], [[1, 1], 2],
  [[0, 0], 3], [[0, 1], 3],
]);

export const MACHINE_TYPES: MachineType[] = [
  {
    id: 'spring',
    name: 'Spring',
    bodyColor: '#f0c9c9',
    cells: scaleCells([[0, 0], [1, 0], [0, 1], [1, 1]]),
    ports: [
      { id: 'out', label: 'A', kind: 'out', edges: RING_2X2 },
    ],
    params: [
      { key: 'rate', label: 'Production rate (L/s)', kind: 'number', default: 2, min: 0, max: 10, step: 0.1 },
      { key: 'color', label: 'Wavelength (nm)', kind: 'wavelength', default: 650, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'colorB', label: 'Wavelength B (nm)', kind: 'wavelength', default: 650, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'mixB', label: 'Share of B', kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
    ],
    ruleText:
      'Produces fluid at its configured rate, offered from every edge (port A spans the ' +
      'whole perimeter): a mixture of its two wavelengths in the configured shares ' +
      '(share 0 = pure wavelength A, the default). Its body is painted exactly like ' +
      'the fluid it produces. Needs no inputs.',
    fluidColor: (params) => twoWlColor(params, 650),
    compute: (_inputs, params): Record<string, FluidMap> => {
      const rate = Number(params.rate);
      const out: FluidMap = {};
      for (const [wl, share] of Object.entries(
        targetMixture(asWavelength(params.color), asWavelength(params.colorB), clamp01(Number(params.mixB))),
      )) {
        out[wl] = rate * share;
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
      { key: 'wlA', label: 'Port A wavelength (nm)', kind: 'wavelength', default: 650, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'tolA', label: 'Port A tolerance (nm)', kind: 'number', default: 30, min: 0, max: 200, step: 1 },
      { key: 'wlB', label: 'Port B wavelength (nm)', kind: 'wavelength', default: 540, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'tolB', label: 'Port B tolerance (nm)', kind: 'number', default: 30, min: 0, max: 200, step: 1 },
      { key: 'wlOut', label: 'Output wavelength (nm)', kind: 'wavelength', default: 460, min: WL_MIN, max: WL_MAX, step: 1 },
    ],
    ruleText:
      'If port A receives at least 1 L/s within its tolerance of its wavelength, and ' +
      'port B receives any fluid within its tolerance of its wavelength, port C produces ' +
      '1 − e^(−B rate) L/s at the output wavelength.',
    compute: (inputs, params): Record<string, FluidMap> => {
      const a = rateNear(inputs.a ?? {}, asWavelength(params.wlA), Number(params.tolA));
      const b = rateNear(inputs.b ?? {}, asWavelength(params.wlB, 540), Number(params.tolB));
      if (a >= 1 && b > 1e-4) return { out: { [asWavelength(params.wlOut, 460)]: 1 - Math.exp(-b) } };
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
      'port B, untouched: every wavelength keeps its identity and rate.',
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
      'Irreversibly homogenizes the mixture arriving at port A into a single fluid at ' +
      'the rate-weighted average wavelength, same total rate. Warning: average ' +
      'wavelength is not average color — red + violet light looks pink, but their ' +
      'average wavelength is green.',
    compute: (inputs): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      if (total <= 1e-4) return {};
      return { out: { [meanWavelength(fm)]: total } };
    },
  },
  {
    id: 'filter',
    name: 'Filter',
    bodyColor: '#e3d3d3',
    // Lopsided sideways Y:  ---+--   input flows in the west end of the long
    //                          '--   arm; the passband continues straight out
    // the east-top end, the rest forks out the shorter east-bottom arm.
    cells: scaleCells([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [5, 1]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3]]) },
      { id: 'near', label: 'B', kind: 'out', edges: scaleEdges([[[5, 0], 1]]) },
      { id: 'far', label: 'C', kind: 'out', edges: scaleEdges([[[5, 1], 1]]) },
    ],
    params: [
      { key: 'target', label: 'Center wavelength (nm)', kind: 'wavelength', default: 650, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'tol', label: 'Band half-width (nm)', kind: 'number', default: 40, min: 0, max: 200, step: 1 },
    ],
    ruleText:
      'A band-pass filter: components of the incoming mixture within the band ' +
      '(center ± half-width) flow out port B, everything else out port C. Rates are ' +
      'conserved; it cannot split a single homogenized fluid back apart.',
    compute: (inputs, params): Record<string, FluidMap> => {
      const near: FluidMap = {};
      const far: FluidMap = {};
      const target = asWavelength(params.target);
      const tol = Number(params.tol);
      for (const [wl, rate] of Object.entries(inputs.in ?? {})) {
        (Math.abs(Number(wl) - target) <= tol + 1e-9 ? near : far)[wl] = rate;
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
        for (const [wl, rate] of Object.entries(inputs.in ?? {})) {
          stored[wl] = (stored[wl] ?? 0) + rate * ctx.dt;
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
      for (const [wl, amt] of Object.entries(stored)) out[wl] = (rate * amt) / held;
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
      { id: 'in', label: 'A', kind: 'in', edges: RING_2X2 },
    ],
    params: [
      { key: 'colorA', label: 'Target wavelength A (nm)', kind: 'wavelength', default: 580, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'colorB', label: 'Target wavelength B (nm)', kind: 'wavelength', default: 580, min: WL_MIN, max: WL_MAX, step: 1 },
      { key: 'mixB', label: 'Share of B', kind: 'number', default: 0, min: 0, max: 1, step: 0.05 },
      { key: 'tol', label: 'Tolerance (nm)', kind: 'number', default: 15, min: 0, max: 200, step: 1 },
    ],
    ruleText:
      'Slurps up everything fed into any side. Lights up while the incoming mixture ' +
      'matches its target mixture (two wavelengths in configured shares): each target ' +
      "component must make up its share of what's arriving, judged by wavelength within " +
      'the tolerance — the right-looking light made of the wrong wavelengths stays ' +
      'dark. Needs at least 0.5 L/s in total. Its body is painted exactly like the ' +
      'mixture it wants.',
    fluidColor: (params) => twoWlColor(params, 580),
    compute: (inputs, params, ctx): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      const target = targetMixture(
        asWavelength(params.colorA, 580), asWavelength(params.colorB, 580), clamp01(Number(params.mixB)),
      );
      let score = 0;
      for (const [wl, share] of Object.entries(target)) {
        const got = total > 1e-4 ? rateNear(fm, Number(wl), Number(params.tol)) / total : 0;
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
