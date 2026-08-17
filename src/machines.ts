import { WL_MAX, WL_MIN, mixtureColor } from './light';
import type { Budget, Cell, Edge, FluidMap, MachineType, ParamValue } from './types';

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

// Legacy-only: target mixture from the old two-wavelength + share sink
// parametrization (colorA/colorB/mixB), kept so pre-mixture world codes
// still load. New code uses 'mixture' param lists throughout.
function targetMixture(wlA: number, wlB: number, mixB: number): FluidMap {
  const t: FluidMap = {};
  const add = (wl: number, share: number) => {
    if (share > 1e-6) t[wl] = (t[wl] ?? 0) + share;
  };
  add(wlA, 1 - mixB);
  add(wlB, mixB);
  return t;
}

// A spring's produced mixture: the 'mixture' param is an arbitrary list of
// {wl, rate} rows. Old world codes may instead hold the legacy
// rate/color/colorB/mixB params — convert those on the fly.
function springMixture(params: Record<string, ParamValue>): FluidMap {
  const out: FluidMap = {};
  const add = (wl: number, rate: number) => {
    if (rate > 1e-6) out[wl] = (out[wl] ?? 0) + rate;
  };
  if (Array.isArray(params.mixture)) {
    for (const c of params.mixture) add(asWavelength(c?.wl), Number(c?.rate));
  } else {
    const rate = Number(params.rate) || 2;
    const mix = clamp01(Number(params.mixB));
    add(asWavelength(params.color), rate * (1 - mix));
    add(asWavelength(params.colorB), rate * mix);
  }
  return out;
}

// A sink's target as normalized shares (summing to 1): the 'mixture' param
// is the same arbitrary {wl, rate} list a spring uses — only the *ratios*
// matter to a sink. Old worlds may instead hold the legacy
// colorA/colorB/mixB params — convert those on the fly.
function sinkTarget(params: Record<string, ParamValue>): FluidMap {
  if (Array.isArray(params.mixture)) {
    const t: FluidMap = {};
    let total = 0;
    for (const c of params.mixture) {
      const r = Number(c?.rate);
      if (r > 1e-6) {
        const wl = asWavelength(c?.wl, 580);
        t[wl] = (t[wl] ?? 0) + r;
        total += r;
      }
    }
    for (const k of Object.keys(t)) t[k] /= total;
    return t;
  }
  return targetMixture(
    asWavelength(params.colorA ?? params.color, 580),
    asWavelength(params.colorB, 580),
    clamp01(Number(params.mixB)),
  );
}

// ---- fabricator ------------------------------------------------------------

// Sim-seconds to build one unit of each product. Pipe is one *cell* per
// unit, hence very fast; machines take a few seconds each.
export const BUILD_TIME: Record<string, number> = {
  pipe: 0.4, spring: 4, reactor: 6, funnel: 3, blender: 3, filter: 5, buffer: 4, sink: 4, fabricator: 8,
};

// How much a wavelength counts toward the fabricator's 5 L/s red-power
// requirement: 1 at pure 650 nm, fading to 0 by ±80 nm, then *negative*
// (capped at −1) — far-from-red light actively fights the build.
const redness = (wl: number) => Math.max(-1, 1 - ((wl - 650) / 80) ** 2);

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
      { key: 'mixture', label: 'Produced mixture', kind: 'mixture', default: [{ wl: 650, rate: 2 }] },
    ],
    ruleText:
      'Produces every wavelength in its list at that row’s rate, offered from every ' +
      'edge (port A spans the whole perimeter). Its body is painted exactly like the ' +
      'fluid it produces. Needs no inputs.',
    fluidColor: (params) => mixtureColor(springMixture(params)),
    compute: (_inputs, params): Record<string, FluidMap> => ({ out: springMixture(params) }),
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
      { key: 'mixture', label: 'Target mixture (ratios matter, not rates)', kind: 'mixture', default: [{ wl: 580, rate: 1 }] },
      { key: 'tol', label: 'Tolerance (nm)', kind: 'number', default: 15, min: 0, max: 200, step: 1 },
    ],
    ruleText:
      'Slurps up everything fed into any side. Lights up while the incoming mixture ' +
      'matches its target mixture (an arbitrary list of wavelengths, in the listed ' +
      "proportions): each target component must make up its share of what's arriving, " +
      'judged by wavelength within the tolerance — the right-looking light made of the ' +
      'wrong wavelengths stays dark. Needs at least 0.5 L/s in total. Its body is ' +
      'painted exactly like the mixture it wants.',
    fluidColor: (params) => mixtureColor(sinkTarget(params)),
    compute: (inputs, params, ctx): Record<string, FluidMap> => {
      const fm = inputs.in ?? {};
      const total = totalRate(fm);
      const target = sinkTarget(params);
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
  {
    id: 'fabricator',
    name: 'Fabricator',
    bodyColor: '#e6c39c',
    cells: scaleCells([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]),
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: scaleEdges([[[0, 0], 3], [[0, 1], 3]]) },
    ],
    params: [
      {
        key: 'make', label: 'Makes', kind: 'choice', default: 'pipe',
        options: [
          { value: 'pipe', label: 'Pipe (1 cell)' },
          { value: 'spring', label: 'Spring' },
          { value: 'reactor', label: 'Reactor' },
          { value: 'funnel', label: 'Funnel' },
          { value: 'blender', label: 'Blender' },
          { value: 'filter', label: 'Filter' },
          { value: 'buffer', label: 'Buffer' },
          { value: 'sink', label: 'Sink' },
          { value: 'fabricator', label: 'Fabricator' },
        ],
      },
    ],
    ruleText:
      'Builds its configured product from red light: it needs 5 L/s of 650 nm red at ' +
      'port A to run at full speed. Off-red light counts at a discount, and light far ' +
      'from red counts *against* the requirement. Each finished item fills in a ghost ' +
      'of the matching kind (pipe ghosts one cell at a time); with no ghost to fill, ' +
      'it holds the finished item until one appears. The bar shows its progress.',
    compute: (inputs, params, ctx): Record<string, FluidMap> => {
      const st = ctx.state as { making?: string; progress?: number; ready?: boolean; speed?: number };
      const kind = typeof params.make === 'string' && BUILD_TIME[params.make] ? params.make : 'pipe';
      if (st.making !== kind) {
        // retooling scraps any partial (or queued) build
        st.making = kind;
        st.progress = 0;
        st.ready = false;
      }
      let power = 0;
      for (const [wl, rate] of Object.entries(inputs.in ?? {})) power += rate * redness(Number(wl));
      st.speed = clamp01(power / 5);
      if (!st.ready) {
        st.progress = Math.min(BUILD_TIME[kind], (st.progress ?? 0) + ctx.dt * st.speed);
        if (st.progress >= BUILD_TIME[kind]) st.ready = true;
      }
      return {};
    },
    describeState: (state) => {
      const kind = String(state.making ?? 'pipe');
      if (state.ready) return `Holding a finished ${kind} — waiting for a ghost to fill.`;
      const t = BUILD_TIME[kind] ?? 1;
      const pct = Math.round((100 * Math.min(Number(state.progress) || 0, t)) / t);
      return `Making ${kind}: ${pct}%, at ${Math.round(100 * (Number(state.speed) || 0))}% speed.`;
    },
    progress: (state) => {
      if (state.ready) return 1;
      const t = BUILD_TIME[String(state.making ?? 'pipe')] ?? 1;
      return Math.min(1, (Number(state.progress) || 0) / t);
    },
  },
];

export const TYPE_BY_ID: Record<string, MachineType> = Object.fromEntries(
  MACHINE_TYPES.map((t) => [t.id, t]),
);

// A roomy sandbox budget, used wherever a world doesn't specify its own
// (blank worlds, imported legacy codes).
export const defaultBudget = (): Budget => ({
  pipe: 2000,
  machines: Object.fromEntries(MACHINE_TYPES.map((t) => [t.id, 10])),
});
