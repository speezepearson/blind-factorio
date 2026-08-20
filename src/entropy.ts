// The thermodynamic core of the entropy-engine branch
// (docs/thermodynamic-engine.md): one entropy function S(site) and the
// biased, detailed-balanced transport law derived from it.
//
// A site is a parcel plus a capacity V in radical-slots. Per site,
//
//   S = C·ln(U/C)  +  s₀·M  −  Σ_s n_s·ln(n_s·r_s / V)  −  F·ln(F/V)
//
// with C = CR·N (C_wall = 0: walls stay thermally invisible), M the
// molecule count, F = V − N the free slots. The four terms: thermal,
// translational, mixing, and the entropy of empty space — the last is what
// makes expansion into a fresh vein a real, payable entropy source.
//
// All matter movement goes through moveFluid(): per species, a forward and
// a reverse propensity whose RATIO is exp(ΔS + b·r_s) — the master law (★)
// with the peristaltic bias b as a declared external affinity. Mass-action
// prefactors (∝ occupancy) carry the ideal-mixing part of ΔS; the exponent
// carries the rest, computed by exact finite difference of S. Moved
// molecules carry their proportional share of thermal quanta, so
// convection transports heat. Everything moved is a whole integer;
// conservation is typography, not a runtime check.

import { CR, CHEM_S0, poisson, radCount, SCALE } from './chem';
import type { Chemistry, Parcel } from './chem';

export const V_NODE = 3 * SCALE; // fully inflated vein-node capacity, radical-slots
export const V_SEED = SCALE / 10; // born-collapsed floor once incarnate
export const V_CHAMBER = 10 * SCALE; // organ inlet/main chamber capacity
export const V_SIDE = 6 * SCALE; // organ side chamber capacity
export const HEART_B = 2.0; // peristaltic bias, per radical-slot per hop
export const NU_T = 1.2; // transport attempt rate along veins, per molecule per tick
export const NU_ORG = 2.4; // organ internal (effusion) channel attempt rate
export const NU_SRC = 3.6; // wellhead contact rate (sets standing stock at the head node)
export const NSUB = 4; // transport substeps per tick

const XCAP = 8; // clamp on entropic exponents (numerical hygiene, not physics)
const clampX = (x: number) => (x > XCAP ? XCAP : x < -XCAP ? -XCAP : x);

// Thermal entropy of a site: C·ln(U/C), NOT the design doc's C·ln(U).
// Both give ∂S/∂E = 1/T, but C·ln U is not extensive — moving a molecule
// (with its heat share) between two same-temperature sites of different
// size would pay a spurious ±C·ln(U_a/U_b), which in practice fought the
// peristaltic bias to a standstill. C·ln(U/C) = C·ln(T/ε·…) is invariant
// under that move, as physics demands. (Recorded in the doc's addendum.)
const sThermal = (N: number, U: number): number =>
  N > 0 ? CR * N * Math.log(Math.max(1, U) / (CR * N)) : 0;

// The per-site terms of S a one-molecule move of species s can change
// (other species' mixing terms have fixed n and V — they cancel from
// every difference and are omitted).
function sPartial(ns: number, rs: number, N: number, U: number, V: number): number {
  let S = sThermal(N, U); // C_wall = 0
  if (ns > 0 && V > 0) S += CHEM_S0 * ns - ns * Math.log((ns * rs) / V);
  const F = V - N;
  if (F > 0 && V > 0) S -= F * Math.log(F / V);
  return S;
}

// Full entropy of one site (for the world ledger and the god readout).
export function sSite(chem: Chemistry, p: Parcel, V: number): number {
  const N = radCount(chem, p.c);
  let S = sThermal(N, p.U);
  for (let s = 0; s < chem.nsp; s++) {
    const ns = p.c[s];
    if (ns > 0 && V > 0) S += CHEM_S0 * ns - ns * Math.log((ns * chem.radcount[s]) / V);
  }
  const F = V - N;
  if (F > 0 && V > 0) S -= F * Math.log(F / V);
  return S;
}

// the proportional heat share of moving `k` molecules of a species with
// `r` radicals out of a parcel (whole quanta, clamped to the ledger)
const heatShare = (p: Parcel, N: number, r: number, k: number): number =>
  N > 0 ? Math.min(p.U, Math.round((p.U * r * k) / N)) : 0;

export interface Moved {
  rad: number; // net radicals moved a→b (negative = backflow)
  E: number; // net energy content moved a→b, in quanta: heat − bond depth
  heartS: number; // entropy budget the bias injected: b·r·(net molecules)
}

// One transport channel a→b for every species (optionally singles only),
// integrated over tau of a tick. `biasSlots` is the affinity per
// radical-slot in the a→b direction (HEART_B on flow edges, 0 inside
// organs). `frozenA` makes a an immutable reservoir: its ledgers are read
// but never written (sources; backflow into them is absorbed).
export function moveFluid(
  chem: Chemistry,
  a: Parcel,
  Va: number,
  b: Parcel,
  Vb: number,
  biasSlots: number,
  nu: number,
  tau: number,
  singlesOnly = false,
  frozenA = false,
): Moved {
  let Na = radCount(chem, a.c);
  let Nb = radCount(chem, b.c);
  const out: Moved = { rad: 0, E: 0, heartS: 0 };
  for (let s = 0; s < chem.nsp; s++) {
    const r = chem.radcount[s];
    if (singlesOnly && r !== 1) continue;
    const na = a.c[s];
    const nb = b.c[s];
    if (na === 0 && nb === 0) continue;
    const bias = biasSlots * r;
    let ap = 0;
    if (na > 0 && Vb - Nb >= r) {
      const q = heatShare(a, Na, r, 1);
      const dS =
        sPartial(na - 1, r, Na - r, a.U - q, Va) - sPartial(na, r, Na, a.U, Va) +
        sPartial(nb + 1, r, Nb + r, b.U + q, Vb) - sPartial(nb, r, Nb, b.U, Vb);
      ap = nu * na * Math.exp(clampX((dS - Math.log(na / (nb + 1)) + bias) / 2));
    }
    let am = 0;
    if (nb > 0 && Va - Na >= r) {
      const q = heatShare(b, Nb, r, 1);
      const dS =
        sPartial(nb - 1, r, Nb - r, b.U - q, Vb) - sPartial(nb, r, Nb, b.U, Vb) +
        sPartial(na + 1, r, Na + r, a.U + q, Va) - sPartial(na, r, Na, a.U, Va);
      am = nu * nb * Math.exp(clampX((dS - Math.log(nb / (na + 1)) - bias) / 2));
    }
    if (ap === 0 && am === 0) continue;
    let k = poisson(ap * tau) - poisson(am * tau);
    // tau-leap sanity: no substep moves more than ~35% of a side's stock —
    // numerical hygiene (can equilibrate slower than (★) demands, never
    // cross it); without this, fat exponents teleport whole nodes multiple
    // hops per tick and flow degenerates into soliton pulses
    if (k > 0) k = Math.min(k, Math.ceil(0.35 * na), Math.floor((Vb - Nb) / r));
    else if (k < 0) k = -Math.min(-k, Math.ceil(0.35 * nb), Math.floor((Va - Na) / r));
    if (k === 0) continue;
    let q: number;
    if (k > 0) {
      q = heatShare(a, Na, r, k);
      if (!frozenA) {
        a.c[s] -= k;
        a.U -= q;
      }
      b.c[s] += k;
      b.U += q;
    } else {
      q = -heatShare(b, Nb, r, -k);
      b.c[s] += k;
      b.U += q;
      if (!frozenA) {
        a.c[s] -= k;
        a.U -= q;
      }
    }
    if (!frozenA) Na -= r * k;
    Nb += r * k;
    out.rad += r * k;
    out.E += q - k * chem.bondEq[s]; // energy content = heat − bond depth (U − E_bond is the invariant)
    out.heartS += bias * k;
  }
  return out;
}

// An absorbing channel into the declared empty infinite reservoir (open
// tails, incarnation frontiers, dead merges, growing-organ mouths,
// portless organ ports). Reverse rate is zero by nature — there is
// nothing on the other side to come back — so any forward rate is
// second-law-safe; the drive is the peristaltic bias alone. `into`, when
// given, accumulates the vented composition for the haze trackers.
export function ventFluid(
  chem: Chemistry,
  a: Parcel,
  nu: number,
  biasSlots: number,
  tau: number,
  into?: Int32Array,
): Moved {
  let Na = radCount(chem, a.c);
  const out: Moved = { rad: 0, E: 0, heartS: 0 };
  for (let s = 0; s < chem.nsp; s++) {
    const na = a.c[s];
    if (na === 0) continue;
    const r = chem.radcount[s];
    const bias = biasSlots * r;
    const k = Math.min(Math.ceil(0.35 * na), poisson(nu * na * Math.exp(clampX(bias / 2)) * tau));
    if (k === 0) continue;
    const q = heatShare(a, Na, r, k);
    a.c[s] -= k;
    a.U -= q;
    Na -= r * k;
    if (into) into[s] += k;
    out.rad += r * k;
    out.E += q - k * chem.bondEq[s]; // energy content = heat − bond depth (U − E_bond is the invariant)
    out.heartS += bias * k;
  }
  // heat can't ride on nothing: a drained site sheds its last quanta too
  if (Na === 0 && a.U > 0) {
    out.E += a.U;
    a.U = 0;
  }
  return out;
}
