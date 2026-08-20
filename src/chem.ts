// The radical-chemistry engine: a small set of primitive radicals; a
// chemical species is any non-empty subset of them; the single reaction law
// is A + B ⇌ A∪B + A∩B. Everything below — species tables, reaction
// channels, quantized tau-leaping kinetics, heat, and the color projection —
// derives from the radical table passed to buildChemistry(). The engine is
// generic over that table; the shipped content is currently the three
// visible primaries (K, X, and friends arrive as data, not code).
//
// Quantization: all conserved quantities are exact integers. State is
// particle counts per species plus a heat ledger U in quanta of EPS energy
// units. Floats appear only in crossing *rates* — they decide when events
// fire, never what they do to the ledgers.

export const EPS = 0.01; // energy units per thermal quantum
export const SCALE = 10000; // particles per "part" (source output per tick)
// Heat capacity rides entirely on the fluid (per radical). Vein walls are
// thermally invisible — zero capacity, no hidden thermal state — so an
// empty stretch of vein has no temperature at all (it reads as ambient).
export const CR = 0.8; // heat capacity per radical
export const T_AMB = 1.0; // default ambient temperature
export const K_ALONG = 0.25; // heat conduction along a vein, per tick
export const K_CROSS = 0.15; // heat conduction between co-located veins
export const K_AMB = 0.03; // leak to ambient, per tick

const CHEM_A = 25; // pass-attempt rate
export const CHEM_S0 = Math.log(5); // per-particle entropy
const CHEM_EA = 0.8; // pass height above the looser side
const DT_CHEM = 0.35; // chemistry time simulated per game tick

export interface RadicalDef {
  id: string; // one letter
  stick: number; // additive stickiness a_i (bond energy E_ij = a_i + a_j)
  // pigment in [0..1] per channel; 'black' darkens the blend by load share;
  // 'invisible' contributes nothing to color at all
  pigment: [number, number, number] | 'black' | 'invisible';
}

// The committed content, visible primaries first. K/X are designed (black,
// invisible) but not yet shipped — append them here when they graduate.
export const DEFAULT_RADICALS: RadicalDef[] = [
  { id: 'R', stick: 1.75, pigment: [1, 0, 0] },
  { id: 'G', stick: 1.25, pigment: [0, 1, 0] },
  { id: 'B', stick: 0.75, pigment: [0, 0, 1] },
];

export interface Channel {
  loose: [number, number]; // species indices of the {A, B} side
  tight: number[]; // [A∪B] if disjoint, else [A∪B, A∩B]
  dEq: number; // binding advantage of the tight side, in heat quanta (≥ 0)
}

export interface Chemistry {
  radicals: RadicalDef[];
  species: string[]; // names like "RG", index-aligned with everything below
  masks: number[];
  nsp: number;
  radcount: number[]; // radicals per species
  bondEq: number[]; // bond energy per molecule per species, in heat quanta
  channels: Channel[];
  stick: Record<string, number>; // live stickiness (god-tunable)
  setStickiness(next: Record<string, number>): void;
  // live ambient temperature (god-tunable): what fluid leaks toward, what
  // sources emit at, and what an empty parcel reads as
  ambient: number;
  setAmbient(T: number): void;
  speciesIndex(name: string): number;
}

const popcount = (m: number) => {
  let n = 0;
  while (m) {
    n += m & 1;
    m >>= 1;
  }
  return n;
};

export function buildChemistry(radicals: RadicalDef[]): Chemistry {
  const bit: Record<string, number> = {};
  radicals.forEach((r, i) => {
    bit[r.id] = 1 << i;
  });
  const masks = Array.from({ length: (1 << radicals.length) - 1 }, (_, i) => i + 1).sort(
    (a, b) => popcount(a) - popcount(b) || a - b,
  );
  const species = masks.map((m) => radicals.filter((r) => m & bit[r.id]).map((r) => r.id).join(''));
  const maskToIdx = new Map(masks.map((m, i) => [m, i]));
  const stick: Record<string, number> = Object.fromEntries(radicals.map((r) => [r.id, r.stick]));

  const bondE = (mask: number) => {
    let e = 0;
    const rs = radicals.filter((r) => mask & bit[r.id]);
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) e += stick[rs[i].id] + stick[rs[j].id];
    }
    return e;
  };

  // per-species bond energies rounded to quanta ONCE; channel dEq values
  // are exact differences of these, so the world's (U + bond) energy books
  // balance to the quantum across any reaction history
  const buildBondEq = (): number[] => masks.map((m) => Math.round(bondE(m) / EPS));

  // channels: {A,B} ⇌ {A∪B, A∩B}, subset pairs inert (skipped); the
  // union–intersection side is the tighter one by construction
  const buildChannels = (bondEq: number[]): Channel[] => {
    const out: Channel[] = [];
    for (let a = 0; a < masks.length; a++) {
      for (let b = a + 1; b < masks.length; b++) {
        const A = masks[a];
        const B = masks[b];
        const U = A | B;
        const I = A & B;
        if (U === A || U === B) continue;
        const dEq =
          bondEq[maskToIdx.get(U)!] +
          (I ? bondEq[maskToIdx.get(I)!] : 0) -
          bondEq[a] -
          bondEq[b];
        out.push({
          loose: [a, b],
          tight: I ? [maskToIdx.get(U)!, maskToIdx.get(I)!] : [maskToIdx.get(U)!],
          dEq: Math.max(0, dEq),
        });
      }
    }
    return out;
  };

  const bondEq0 = buildBondEq();
  const chem: Chemistry = {
    radicals,
    species,
    masks,
    nsp: species.length,
    radcount: masks.map(popcount),
    bondEq: bondEq0,
    channels: buildChannels(bondEq0),
    stick,
    setStickiness(next) {
      for (const r of radicals) stick[r.id] = next[r.id] ?? stick[r.id];
      chem.bondEq = buildBondEq();
      chem.channels = buildChannels(chem.bondEq);
    },
    ambient: T_AMB,
    setAmbient(T) {
      chem.ambient = T;
    },
    speciesIndex(name) {
      return species.indexOf(name);
    },
  };
  return chem;
}

// ---- seeded RNG (one stream; setSeed for reproducible presets/tests) ----

let _rs = 12345;
export function setSeed(s: number) {
  _rs = s | 0;
}
export function rnd(): number {
  _rs = (_rs + 0x6d2b79f5) | 0;
  let t = Math.imul(_rs ^ (_rs >>> 15), 1 | _rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function poisson(mean: number): number {
  if (mean <= 0) return 0;
  if (mean < 30) {
    const L = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rnd();
    } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss()));
}
export function stochRound(x: number): number {
  let k = Math.trunc(x);
  const f = x - k;
  if (rnd() < Math.abs(f)) k += Math.sign(f);
  return k;
}

// ---- parcels: one node's worth of fluid, with its heat ledger ----

export interface Parcel {
  c: Int32Array; // particle counts per species
  U: number; // heat quanta
}

export function radCount(chem: Chemistry, c: Int32Array): number {
  let n = 0;
  for (let i = 0; i < chem.nsp; i++) n += c[i] * chem.radcount[i];
  return n;
}
export function totalParticles(chem: Chemistry, c: Int32Array): number {
  let n = 0;
  for (let i = 0; i < chem.nsp; i++) n += c[i];
  return n;
}
export const capOf = (chem: Chemistry, c: Int32Array) => CR * radCount(chem, c);
// an empty parcel has zero heat capacity: it "reads" as ambient
export const tempOf = (chem: Chemistry, p: Parcel) => {
  const cap = capOf(chem, p.c);
  return cap > 0 ? (p.U * EPS) / cap : chem.ambient;
};

export function emptyParcel(chem: Chemistry): Parcel {
  return { c: new Int32Array(chem.nsp), U: 0 };
}
export function sourceParcel(chem: Chemistry, spIdx: number): Parcel {
  const c = new Int32Array(chem.nsp);
  c[spIdx] = SCALE;
  return { c, U: Math.round((CR * SCALE * chem.radcount[spIdx] * chem.ambient) / EPS) };
}
export function cloneParcel(p: Parcel): Parcel {
  return { c: new Int32Array(p.c), U: p.U };
}
// split a parcel 50/50 (odd counts flip a fair coin), mutating the original
export function splitHalf(chem: Chemistry, parcel: Parcel): Parcel {
  const c = new Int32Array(chem.nsp);
  for (let i = 0; i < chem.nsp; i++) {
    let h = parcel.c[i] >> 1;
    if (parcel.c[i] & 1 && rnd() < 0.5) h++;
    c[i] = h;
    parcel.c[i] -= h;
  }
  let hU = parcel.U >> 1;
  if (parcel.U & 1 && rnd() < 0.5) hU++;
  parcel.U -= hU;
  const out: Parcel = { c, U: hU };
  // heat can't ride on nothing (empty parcels hold U=0 by invariant): if
  // either half got all the particles, it takes all the heat too
  if (radCount(chem, c) === 0) {
    parcel.U += out.U;
    out.U = 0;
  } else if (radCount(chem, parcel.c) === 0) {
    out.U += parcel.U;
    parcel.U = 0;
  }
  return out;
}
export function addInto(chem: Chemistry, target: Parcel, src: Parcel): void {
  for (let i = 0; i < chem.nsp; i++) target.c[i] += src.c[i];
  target.U += src.U;
}

// ---- kinetics: tau-leaped crossings over every channel ----

// crossing rate out of one side: A·e^(−s₀·n)·e^(−climb/T)·Π(mole fractions).
// Concentration is mole fraction per *radical* — conserved by every
// reaction, so a parcel's denominator is a constant of its chemistry.
const PRE_S = [0, Math.exp(-CHEM_S0), Math.exp(-2 * CHEM_S0)];

export function reactParcel(chem: Chemistry, parcel: Parcel): void {
  const c = parcel.c;
  if (totalParticles(chem, c) < 2) return;
  const channels = chem.channels;
  const Nr = Math.max(1, radCount(chem, c));
  let remaining = DT_CHEM;
  let sub = 0;
  const rL = new Array<number>(channels.length);
  const rT = new Array<number>(channels.length);
  while (remaining > 1e-9 && sub < 6) {
    sub++;
    const T = tempOf(chem, parcel);
    const invT = 1 / Math.max(T, 0.02);
    const eEa = Math.exp(-CHEM_EA * invT);
    const drift = new Float64Array(chem.nsp);
    let dUdt = 0;
    let any = false;
    for (let j = 0; j < channels.length; j++) {
      const ch = channels[j];
      const a = (CHEM_A * PRE_S[2] * eEa * c[ch.loose[0]] * c[ch.loose[1]]) / Nr;
      let b = CHEM_A * PRE_S[ch.tight.length] * eEa * Math.exp(-ch.dEq * EPS * invT);
      for (const i of ch.tight) b *= c[i];
      if (ch.tight.length === 2) b /= Nr;
      rL[j] = a;
      rT[j] = b;
      const net = a - b;
      if (a > 0 || b > 0) any = true;
      if (net !== 0) {
        for (const i of ch.loose) drift[i] -= net;
        for (const i of ch.tight) drift[i] += net;
        dUdt += ch.dEq * net;
      }
    }
    if (!any) return;
    // tau-leap: no counter (nor the heat ledger) should move more than ~15%
    let tau = remaining;
    for (let i = 0; i < chem.nsp; i++) {
      if (drift[i] < 0 && c[i] > 0) {
        const lim = Math.max(1, 0.15 * c[i]) / -drift[i];
        if (lim < tau) tau = lim;
      }
    }
    const aU = Math.abs(dUdt);
    if (aU > 0) {
      const lim = Math.max(20, 0.08 * Math.max(parcel.U, 1)) / aU;
      if (lim < tau) tau = lim;
    }
    for (let j = 0; j < channels.length; j++) {
      const ch = channels[j];
      let kIn = poisson(rL[j] * tau);
      if (kIn > 0) {
        kIn = Math.min(kIn, c[ch.loose[0]], c[ch.loose[1]]);
        c[ch.loose[0]] -= kIn;
        c[ch.loose[1]] -= kIn;
        for (const i of ch.tight) c[i] += kIn;
        parcel.U += kIn * ch.dEq;
      }
      let kOut = poisson(rT[j] * tau);
      if (kOut > 0) {
        for (const i of ch.tight) kOut = Math.min(kOut, c[i]);
        // the climb floor: unbinding must pay ΔE from the ledger — a cold
        // parcel doesn't have rare unbinding, it has zero unbinding
        if (ch.dEq > 0) kOut = Math.min(kOut, Math.floor(parcel.U / ch.dEq));
        for (const i of ch.tight) c[i] -= kOut;
        c[ch.loose[0]] += kOut;
        c[ch.loose[1]] += kOut;
        parcel.U -= kOut * ch.dEq;
      }
    }
    remaining -= tau;
  }
}

// ---- heat exchange (symmetric, integer, conservative) ----

export function exchangeHeat(chem: Chemistry, pa: Parcel, pb: Parcel, kappa: number): void {
  const Ca = capOf(chem, pa.c);
  const Cb = capOf(chem, pb.c);
  if (Ca <= 0 || Cb <= 0) return; // nothing (or a bare wall) on one side
  const Ta = (pa.U * EPS) / Ca;
  const Tb = (pb.U * EPS) / Cb;
  const Cab = (Ca * Cb) / (Ca + Cb);
  let q = stochRound((kappa * (Ta - Tb) * Cab) / EPS);
  if (q > 0) q = Math.min(q, pa.U);
  else q = -Math.min(-q, pb.U);
  pa.U -= q;
  pb.U += q;
}
// returns the quanta leaked TO ambient (negative = absorbed from it), so
// the world's energy audit can book the boundary flow
export function ambientLeak(chem: Chemistry, p: Parcel): number {
  const C = capOf(chem, p.c);
  if (C <= 0) {
    const q = p.U; // any stray quanta on an empty parcel dissipate
    p.U = 0;
    return q;
  }
  const T = (p.U * EPS) / C;
  let q = stochRound((K_AMB * (T - chem.ambient) * C) / EPS);
  if (q > 0) q = Math.min(q, p.U);
  p.U -= q;
  if (p.U < 0) {
    q += p.U;
    p.U = 0;
  }
  return q;
}

// ---- color: a lossy projection of composition ----
// A parcel's perceived color is the additive blend of its total radical
// loads. Reactions conserve radical loads, so all chemistry is
// chromatically invisible — R+G looks exactly as yellow as RG.

// perceived color as raw [r,g,b] channels (0-255), or null if nothing
// visible — the view layer blends these for sub-tick animation
export function fluidRGB(chem: Chemistry, c: Int32Array): [number, number, number] | null {
  let px = 0;
  let py = 0;
  let pz = 0;
  let dark = 0;
  let visible = 0;
  for (let i = 0; i < chem.nsp; i++) {
    const n = c[i];
    if (n === 0) continue;
    const m = chem.masks[i];
    for (let r = 0; r < chem.radicals.length; r++) {
      if (!(m & (1 << r))) continue;
      const pig = chem.radicals[r].pigment;
      if (pig === 'invisible') continue;
      if (pig === 'black') {
        dark += n;
        continue;
      }
      px += pig[0] * n;
      py += pig[1] * n;
      pz += pig[2] * n;
      visible += n;
    }
  }
  const mx = Math.max(px, py, pz);
  if (mx < 1) return null; // nothing visible: renders as an empty vein
  // hue from pigment ratios; K's share darkens the whole blend (untuned
  // until K ships — revisit the curve then)
  const shade = visible / Math.max(1, visible + dark);
  const ch = (x: number) => Math.round((45 + 200 * (x / mx)) * shade);
  return [ch(px), ch(py), ch(pz)];
}

export function fluidColor(chem: Chemistry, c: Int32Array): string | null {
  const rgb = fluidRGB(chem, c);
  return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : null;
}

// solid chip color for one species (sources, swatches)
export function speciesColor(chem: Chemistry, spIdx: number): string {
  const c = new Int32Array(chem.nsp);
  c[spIdx] = 100;
  return fluidColor(chem, c) ?? '#9aa7ae';
}
