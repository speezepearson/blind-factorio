import type { Flow, FluidMap, MachineType } from './types';

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

function mixColors(a: string, b: string): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex((ar + br) / 2)}${hex((ag + bg) / 2)}${hex((ab + bb) / 2)}`;
}

export const MACHINE_TYPES: MachineType[] = [
  {
    id: 'red-spring',
    name: 'Red Spring',
    bodyColor: '#f0c9c9',
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
    ports: [{ id: 'out', label: 'A', kind: 'out', edges: [[[0, 0], 0], [[1, 0], 0]] }],
    ruleText: 'Always produces 2 L/s of red fluid at port A. Needs no inputs.',
    compute: () => ({ out: { [RED]: 2 } }),
  },
  {
    id: 'green-spring',
    name: 'Green Spring',
    bodyColor: '#c9e5cb',
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
    ports: [{ id: 'out', label: 'A', kind: 'out', edges: [[[0, 0], 0], [[1, 0], 0]] }],
    ruleText: 'Always produces 2 L/s of green fluid at port A. Needs no inputs.',
    compute: () => ({ out: { [GREEN]: 2 } }),
  },
  {
    id: 'reactor',
    name: 'Reactor',
    bodyColor: '#d8cfe8',
    // L-shape:  X .
    //           X X
    cells: [[0, 0], [0, 1], [1, 1]],
    ports: [
      { id: 'a', label: 'A', kind: 'in', edges: [[[0, 0], 3], [[0, 1], 3]] },
      { id: 'b', label: 'B', kind: 'in', edges: [[[1, 1], 1]] },
      { id: 'out', label: 'C', kind: 'out', edges: [[[0, 0], 0]] },
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
    id: 'amplifier',
    name: 'Amplifier',
    bodyColor: '#f4e3bc',
    cells: [[0, 0], [1, 0], [2, 0]],
    ports: [
      { id: 'in', label: 'A', kind: 'in', edges: [[[0, 0], 3]] },
      { id: 'out', label: 'B', kind: 'out', edges: [[[2, 0], 1]] },
    ],
    ruleText: 'Port B outputs the dominant fluid arriving at port A at 1.5× its rate, capped at 10 L/s.',
    compute: (inputs): Record<string, FluidMap> => {
      const f = dominant(inputs.in ?? {});
      if (!f) return {};
      return { out: { [f.color]: Math.min(10, f.rate * 1.5) } };
    },
  },
  {
    id: 'mixer',
    name: 'Mixer',
    bodyColor: '#c7dded',
    // T-shape:  X X X
    //           . X .
    cells: [[0, 0], [1, 0], [2, 0], [1, 1]],
    ports: [
      { id: 'l', label: 'L', kind: 'in', edges: [[[0, 0], 3]] },
      { id: 'r', label: 'R', kind: 'in', edges: [[[2, 0], 1]] },
      { id: 'out', label: 'O', kind: 'out', edges: [[[1, 1], 2]] },
    ],
    ruleText:
      'If both L and R receive fluid, port O produces min(L rate, R rate) L/s of the ' +
      'blend of the two dominant input colors.',
    compute: (inputs): Record<string, FluidMap> => {
      const l = dominant(inputs.l ?? {});
      const r = dominant(inputs.r ?? {});
      if (!l || !r) return {};
      return { out: { [mixColors(l.color, r.color)]: Math.min(l.rate, r.rate) } };
    },
  },
];

export const TYPE_BY_ID: Record<string, MachineType> = Object.fromEntries(
  MACHINE_TYPES.map((t) => [t.id, t]),
);
