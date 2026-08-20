# Thermodynamically Honest Organs

*How to make energy conservation and the second law structural properties of the engine — including the fix for the advection ratchet. Companion to the main design summary; supersedes the imperative filter in the game prototype.*

---

## 1. State

The world is a set of **sites** (vein lumen-cells and organ chambers). Each site `i` holds exactly two ledgers, both exact integers:

- `n[i][s]` — count of each species `s` (a species is a radical subset; `r_s` = its radical count),
- `U[i]` — thermal quanta (each worth `ε` energy units).

One new **constant** per site (not a ledger): a capacity `V[i]`, in radical-slots. Derived quantities, all pure functions of the ledgers:

```
N[i]   = Σ_s n[i][s]·r_s            total radicals at the site
φ[i]   = N[i] / V[i]                fill  (0 ≤ φ ≤ 1)
C[i]   = c_r·N[i] + C_wall          heat capacity
T[i]   = U[i]·ε / C[i]              temperature (a readout, never integrated)
E_bond = Σ_s n[i][s]·ε_s            bond energy (ε_s from the bond table)
```

The capacity `V` is the one addition to the ontology this document argues for. It is what restores the entropy channel that the mole-fraction model deleted, and it is the entire cost of closing the second-law hole.

## 2. One scalar function: world entropy

Everything below hangs on a single function `S(world)` — total entropy as an exact function of the ledgers. Per site:

```
S_i = S_config(n[i]) + S_thermal(n[i], U[i])
```

**Thermal part.** We need `∂S/∂E = 1/T` with `E = U·ε` and `T = U·ε/C`:

```
S_thermal = C[i] · ln U[i]            (up to an additive constant; clamp U ≥ 1)
```

Check: `dS/dE = (C/U)/ε = 1/T`. ✓ (Note `C` depends on `n` via `N`, so moving particles moves heat capacity with them; since `S` is evaluated on whole states, this is handled automatically.)

**Configurational part.** Model each site as `V` radical-slots; a molecule of species `s` occupies `r_s` of them. Mean-field lattice-mixture entropy, with the per-particle term `s₀` we already carry:

```
S_config = s₀·M  −  Σ_s n_s · ln( n_s·r_s / V )  −  (V − N) · ln( (V − N) / V )
```

where `M = Σ_s n_s` is the molecule count. The three terms are: translational entropy per particle; mixing entropy of the species; and the entropy of the *empty space*. That last term is the one our previous ontology lacked — it is what makes expansion into an empty vein a real entropy gain, which is what pays for effusive separation (§6). Any `S_config` with these qualitative ingredients works; the executor only ever needs `S` as a black-box function and its differences.

The world total is `S = Σ_i S_i`. Sources, vents, and the ambient bath are declared open boundaries and sit outside the sum.

## 3. Events and the master rate law

All change — reaction, transport between sites, heat conduction, and every organ function — is a **channel**: an unordered pair of world-states differing by one bounded integer move (a stoichiometry vector over `(site, species)` plus a quanta transfer). Chemistry channels are the existing `A + B ⇌ A∪B + A∩B` set, per site. Transport channels move one molecule between adjacent sites. Conduction channels move one quantum between adjacent sites. Organ channels (§9) are the same object with fancier stoichiometry.

**Master law.** Each channel's two crossing rates satisfy

```
r(1→2) / r(2→1)  =  exp( S(state 2) − S(state 1) )                    (★)
```

— the rate ratio is the exponential of the *total entropy change of the event*, computed from the one function of §2. A convenient symmetric realization, with an activation factor that cancels from the ratio:

```
ΔS   = S(after) − S(before)                    // finite difference, exact
r₊   = ν_c · exp(−Ea/T̄) · exp(+ΔS/2)
r₋   = ν_c · exp(−Ea/T̄) · exp(−ΔS/2)
```

`ν_c` is the channel's attempt rate (the only number an organ author may set), `Ea` its barrier, `T̄` a symmetric local temperature (e.g. geometric mean of the sites touched).

This one law *subsumes* everything we previously hand-built:

- The Boltzmann factor `e^{ΔE/T}` for reactions emerges from the thermal term: paying `ΔE` of quanta into `U` changes `S_thermal` by `≈ ΔE/T`.
- The `e^{−s₀·Δn}` prefactor structure emerges from the `s₀·M` term.
- Mass action emerges from the `n ln n` terms: consuming a species with `n = 0` gives `ΔS = −∞`, rate exactly zero — no availability checks needed.
- Fill effects emerge from the empty-space term: inserting into a crowded site is entropically penalized, into an empty one rewarded.
- Fourier conduction emerges from applying (★) to quantum-hop channels: net heat flows hot→cold because that's the `ΔS > 0` direction.

**Where the old model sat inside this one.** Radical-conserving reactions within one site leave `V`, `N`, and the slot occupancy unchanged, so the fill term cancels from all pure chemistry — reactions behave exactly as currently tuned. Fill matters only for *transport*, which is precisely where the hole was.

## 4. The second law, termwise

Let channel `c` have affinity `A_c = ΔS_c` (entropy gained crossing in the + direction) and net current `J_c = r₊ − r₋`. By (★),

```
J_c = r₋ · (e^{A_c} − 1)   ⇒   σ_c = J_c · A_c = r₋ · (e^{A_c} − 1) · A_c ≥ 0
```

since `x(eˣ−1) ≥ 0` for all real `x`. So the expected entropy production of **every channel individually** is non-negative — not just the sum. There is no configuration of channels, however baroque an organ's internal plumbing, that pumps entropy backward in expectation. (Individual stochastic events can and will go downhill; that's real physics. Detailed balance is exactly the guarantee that nothing can systematically harvest those fluctuations — the executor gives every fluctuation its reverse at the (★)-mandated rate.)

Mean-field ODE limit, for reference: `dn/dt = Σ_c ν_c J_c` and

```
dS/dt = Σ_c σ_c + (boundary terms)   with every σ_c ≥ 0.
```

## 5. Energy conservation as typography

Unchanged from the current engine, now extended to organs: an event may only *move* whole particles between count-ledgers and whole quanta between `U`-ledgers and the bond ledger (via the validated `ΔE`). Channel templates are **data, validated at load time**:

1. radical counts balance across the stoichiometry vector;
2. the quanta transfer equals the bond-table difference of the two sides, `ΔE = Σ ε(products) − Σ ε(reactants)`, rounded to quanta.

A template that fails validation does not exist. The executor has no instruction that mints particles or quanta, so conservation is not checked at runtime — it is unexpressible to violate. (The invariant, as before: `U_total − E_bond,total` is exactly constant in a closed world, and changes only by declared boundary flows.)

## 6. Why the effusive filter is now honest

The filter of the earlier worry — high-permeability-for-singles membrane into a side chamber that advection drains every tick — stops being a demon and becomes ordinary physics:

- Transport of a single `R` from the inlet (fill `φ_in`, mole share `x_R`) into an empty side chamber has `ΔS > 0`: the mixing-entropy *cost* of enriching R is paid by the empty-space term — expansion into vacuum. This is real effusion, and real effusion genuinely separates gases.
- As the chamber fills, the empty-space payment shrinks; at the (★)-determined balance the currents equalize and transport stalls. The per-tick yield is whatever crossed before stall — modest, honest.
- The drain (advection) now has an explicit price (§7), and the free energy ultimately consumed is the *source stream's* exergy: pure, high-fill fluid entering a network that terminates in vents. The books close.

And the behavior you asked about earlier holds with no filter-specific code: fed a single ambient-equilibrated stream with nowhere emptier to expand into, every one of the filter's channels sits at balanced currents, and it does nothing.

## 7. Advection: the ratchet, and the metered heart

**The crime, precisely.** Advection as currently implemented is a channel with `r₋ ≡ 0`: it moves fluid one cell per tick unconditionally, with no reverse process and no cost. That violates (★) by construction. Alone it's harmless (moving a uniform stream one cell is `ΔS ≈ 0`), but composed with selective membranes it is a Feynman ratchet: the membranes' forward fluctuations get swept away and locked in before the mandatory reverse fluctuations can occur. The missing free energy was being paid by the un-audited conveyor.

**Two lawful designs:**

**(a) Emergent flow.** Delete forced advection; make lumen-to-lumen transport just another (★) channel with high `ν`. Sources hold their inlet sites at high fill; vents are zero-fill reservoirs; flow is then the spontaneous current down the fill gradient. Fully honest, zero special cases — but flow becomes gradient-driven rather than plug, the crisp 1-cell-per-tick feel changes, and stall/backflow become possible. A real design fork, not obviously worse (pressure-driven flow is how actual plumbing works), but it changes the game's feel.

**(b) The metered heart (recommended).** Keep plug flow — but reclassify it as *powered peristalsis*, an external agent like the ambient bath, and **meter it**. Every forced hop computes its exact `ΔS` from the same entropy function and books any negative entropy it imposes:

```js
function forcedHop(world, src, dst) {          // dst has just been vacated
  const before = S_site(src) + S_site(dst);
  swapContents(src, dst);                       // integer ledgers move intact:
                                                // energy conservation is automatic
  const dS = S_site(src) + S_site(dst) - before;
  if (dS < 0) world.heartMeter += -dS;          // negative entropy injected by the heart
  // dS > 0 hops are spontaneous-anyway; the heart takes no credit for them
}
```

Then the second law holds *as an audited statement*:

```
ΔS_world  ≥  −heartMeter + (declared source/vent/ambient boundary flows)
```

Organs — being nothing but channels — contribute only non-negative production (§4). Any demon a player builds is now visibly powered, quantitatively, by the heart meter: separation schemes that exploit flow will run the meter up in exact proportion to the free energy they harvest. That converts the exploit from a physics bug into a legible economy — and gives the heart a gameplay identity (a capacity you can exhaust, upgrade, or starve) instead of being free infrastructure. Note the meter reads near zero for boring plumbing: forced hops of uniform streams through uniform veins have `ΔS ≈ 0`; the heart pays only where the network maintains structure.

## 8. Per-tick executor

One generic loop; organs contribute rows to `channels`, not code:

```js
// ---- entropy: the one function everything shares ----
function S_site(site) {
  const N = radCount(site.n), M = molCount(site.n);
  const C = CR * N + CWALL;
  let S = C * Math.log(Math.max(1, site.U));                    // thermal
  S += S0 * M;                                                  // per-particle
  for (let s = 0; s < NSP; s++) {                               // mixing
    const ns = site.n[s];
    if (ns > 0) S -= ns * Math.log((ns * RADCOUNT[s]) / site.V);
  }
  const free = site.V - N;                                      // empty space
  if (free > 0) S -= free * Math.log(free / site.V);
  return S;
}

// ΔS of a candidate event, by exact finite difference on scratch copies
function deltaS(world, ev) {
  const touched = sitesOf(ev);
  const before = sum(touched, S_site);
  applyEvent(touched, ev, +1);          // integer moves only (validated template)
  const after = sum(touched, S_site);
  applyEvent(touched, ev, -1);          // undo
  return after - before;
}

// ---- the tick ----
function doTick(world) {
  // 1) spontaneous physics: chemistry + transport + conduction + organ channels,
  //    all through one detailed-balanced tau-leaper
  let remaining = DT, guard = 0;
  while (remaining > 1e-9 && guard++ < MAX_SUBSTEPS) {
    const rates = [];
    for (const ch of world.channels) {              // organ channels included
      const dS = deltaS(world, ch.event);
      const act = Math.exp(-ch.Ea / Tbar(ch));
      rates.push({
        ch,
        fwd: ch.nu * act * Math.exp(Math.min( dS / 2,  CAP)),
        rev: ch.nu * act * Math.exp(Math.min(-dS / 2,  CAP)),
      });
    }
    const tau = chooseTau(rates, remaining);        // caps: ≤15% of any count,
                                                    // ≤ free slots, ≤ U budget
    for (const r of rates) {
      let k = poisson(r.fwd * tau) - poisson(r.rev * tau);
      k = truncateToLedgers(world, r.ch.event, k);  // never negative counts/U/slots
      applyEvent(world, r.ch.event, k);             // moves integers; conserves by type
    }
    remaining -= tau;
  }

  // 2) the heart: forced plug flow, metered (§7)
  for (const vein of world.veins) {
    for (let i = vein.cells.length - 1; i >= 1; i--)
      forcedHop(world, vein.cells[i - 1], vein.cells[i]);
    fillHead(vein);                                  // sources/ports: boundary flows,
  }                                                  // booked to their own meters

  // 3) record histories, resolve budding triggers, etc.
}
```

Things to notice: there is no organ update function anywhere; `deltaS` is the only place thermodynamics lives; conservation lives entirely in `applyEvent` + load-time template validation; and rate capping (`CAP`) plus the tau-leap truncation are numerical hygiene, not physics — they can make the sim *slower* to equilibrate than (★) demands, never able to cross it.

Performance note: `deltaS` per channel per substep is ~10 logs; with reachability filtering and skip-if-both-sides-negligible this is comparable to the current engine. If it bites, `S_site` differences factor analytically into the familiar activity products — the closed forms of the old code are the optimization, now derived rather than axiomatic.

## 9. Authoring organs

An organ is **data**: compartments (sites with capacities) + channel templates + attempt rates.

```js
const RADICAL_FILTER = {
  chambers: { inlet: {V: 10000}, main: {V: 10000}, side: {V: 6000} },
  ports:    { in: "inlet", out: "main", rad: "side" },
  channels: [
    { move: [ONE_MOLECULE, "inlet", "main"],  filter: s => true,        nu: 40, Ea: 0 },
    { move: [ONE_MOLECULE, "inlet", "side"],  filter: s => RADCOUNT[s] === 1, nu: 40, Ea: 0 },
    // powered variant: one fuel molecule cracked per molecule pumped —
    // a single validated stoichiometry, so its ΔS is computed whole:
    // { couple: [CRACK("FF"), MOVE("inlet","side")], filter: singles, nu: 8, Ea: 0.5 },
  ],
};
```

Rules for authors, now enforceable rather than aspirational:

1. You may set topology, stoichiometry, filters, `ν`, `Ea`. You may **not** write rate expressions or output-construction code — those don't exist.
2. Selective permeability (the `filter`) is legal and demon-free: it biases *which* channels exist, and every channel is individually second-law-compliant.
3. Catalysis = raising `ν`. Always safe.
4. Uphill work = a **coupled** template: one event whose combined `ΔS` is what (★) sees. Never two separate events with a side-payment.
5. Anything an organ "consumes" (fuel) or "excretes" (waste) is ordinary species in the stoichiometry — no meters, no mana.

## 10. Costs and open choices

- **The trilemma resolves against contracting veins, in the physics.** Fixed `V` means a trickle in a big lumen is genuinely dilute: it reacts slower (per-particle) and feels suction from fuller neighbors. This partially walks back the trickle≡torrent ruling — the amended ontology is "the vein is a vessel; fluid can underfill it." The *display* can keep contraction (width ∝ flow) as pure rendering; physically, a thin taut vein is a squeezed one. If trickle≡torrent must survive exactly, the alternative is stance (b) alone — keep mole-fraction kinetics and rely purely on the heart meter — accepting that flow-ratchets are merely *priced*, not prevented.
- **φ → 1 singularities**: the empty-space term diverges as sites brim. Cap effective fill (e.g. 0.98) or size capacities above typical loads; sources should emit below capacity.
- **Choice of `S_config`** (Flory-style volume fractions vs. per-molecule slots) shifts constants, not structure; pick whichever tunes best and keep it *the* function.
- **Ea placement** is free per channel (it cancels from (★)); temperature-dependent barriers stay legal if symmetric.
- **Boundaries are the trust surface.** Sources, vents, ambient bath, heart meter: four declared accounts. Every conservation and entropy statement is "exact, modulo these," so keep the list short and visible — ideally as an on-screen ledger, because "the books balance" is itself a discoverable law of this world, and the best proof to the player that the physics isn't cheating is letting them audit it.

---

# Addendum: reconciliation decisions (2026-08-20)

Recorded when this doc (written without codebase knowledge) met the code, on the
`entropy-engine` branch. The three open questions and their resolutions:

## 1. Peristalsis = a finite bias on transport channels — chosen over the metered heart

§7(b)'s `forcedHop` meter keeps plug flow but leaves the heart infinitely strong (it
pays *any* cost and merely logs it). Instead, along-vein transport channels carry a
fixed affinity `b` per radical-slot in the flow direction: `r₊/r₋ = exp(ΔS + b·r_s)`.
This is the tilted-ratchet formalization of driving; the audit becomes a theorem —
any demon's harvest is bounded by `b ×` (net forward current), and flow *stalls*
where the opposing gradient exceeds the bias. The price, accepted deliberately for
this exploration: plug flow, station-crisp composition fronts, and the exact
1-node-per-tick advection are gone. Flow is now drift over a gradient; rendering and
old tick-count assumptions are approximate at best. Prettiness is explicitly not a
goal on this branch.

## 2. Sources and vents = declared reservoir channels — legal, not cheating

The grand-canonical boundary construction. A **source** is a detailed-balanced
transport channel against a *frozen* reservoir site (fixed composition, fill, and
T_amb) — so backpressure is real: pressurize a source's inlet and injection stalls
or reverses. A **vent** is a channel to the declared empty infinite reservoir;
`r₋ = 0` arises naturally (nothing to come back), so absorption is honest for free.
Exergy *should* enter through sources — that is the game's economy. The discipline
is that boundaries stay few, declared, and on an auditable ledger (§10's last
bullet): heart, sources, vents, ambient, growth.

## 3. Fresh vein volume = minted negentropy — closed by born-collapsed veins

Creating empty capacity `V` is a vacuum vessel: free exergy, exploitable as a
construction-powered separation engine (grow, let fluid expand in, sever, vent,
regrow). Fix: **veins are born collapsed** — a newly incarnated site starts at
`V ≈ 0` and inflates only as fluid pushes in (`V` tracks contents up to `V_max`),
so no vacuum exists until something pays to open it. Biologically apt: a new vessel
is a collapsed sleeve, not an evacuated pipe. Inflation entropy is booked to the
growth meter. The elegant endpoint (deferred): `V` as a slow per-site ledger with
wall-elastic energy, making vein caliber — and the width display — honest physics.

## Implementation notes (what maps where)

- Sites = vein nodes (existing parcels + a new `cap` array) and organ chambers.
- **Chemistry is untouched** — §3's observation that fill cancels for
  radical-conserving reactions means the existing tuned kinetics *is* the (★) law
  restricted to one site. Likewise heat conduction and ambient leak keep their
  mean-field forms: hot→cold proportional flow is the ΔS>0 direction always, a safe
  optimization of the quantum-hop channels.
- Transport propensities use mass-action prefactors with the symmetric entropic
  residual: `a₊ = ν·n_i[s]·exp(+(ΔS_x + b·r_s)/2)`, `a₋ = ν·n_j[s]·exp(−…/2)`,
  where `ΔS_x` is the finite-difference ΔS *minus* the ideal-mixing log-ratio the
  prefactors already supply. Exact ratio up to O(1/n); `n=0` kills the right rates
  with no availability checks. Transported molecules carry their proportional share
  of thermal quanta (whole-quanta template), so convection moves heat as before.
- `C_wall = 0`, preserving thermally-invisible walls.
- Organs are data: chambers + channel templates (the radical filter: inlet→main all
  species, inlet→side singles only). A grown port with no vein = vent channel, so
  "every sink is visible" survives. Under honest effusion the side stream is *pure
  but modest* and the main stream is only depleted, not stripped — the filter is
  rate-limited now; that is a feature (instruments should cost).

## Findings from the first implementation (same day)

The engine went in essentially as designed — chemistry untouched, transport and
organs as channels, both conservation audits exact to the integer over the full
demo (e2e/conservation.mjs keeps them exact forever). Four corrections earned the
hard way:

1. **`S_thermal = C·ln U` is wrong; use `C·ln(U/C)`.** Both satisfy ∂S/∂E = 1/T,
   but `C·ln U` is not extensive: moving a molecule (with its proportional heat
   share) between two same-temperature sites of different size pays a spurious
   `±C·ln(U_a/U_b)` — in the demo ≈ −4.8 per hop, which fought the bias to a
   standstill. `C·ln(U/C)` is invariant under that move, as physics demands.
2. **The wellhead must be unbiased.** A biased source edge pumps against unbounded
   backpressure and jams the entire network to saturation. With the reservoir
   seeping at its own chemical potential (bias only in the vein hops), injection
   self-limits when the head node reaches reservoir fill, and network throughput
   settles at what the peristalsis actually carries (~the old engine's rate).
3. **Vein inflation must key on flux, not standing stock.** A node passing flow
   through efficiently keeps low contents; a contents-keyed ratchet leaves such
   nodes as permanent collapsed necks choking full-bore jams behind them. `flow[]`
   is now true arrival flux (which also makes the width display honest), and cap
   dilates geometrically toward max(3× stock, 8 ticks of flux).
4. **Tau-leaping needs the classic ≤35%-per-substep cap.** Without it, fat
   entropic exponents teleport whole node contents multiple hops per tick and
   flow degenerates into soliton pulses. The cap is numerical hygiene — it can
   only slow equilibration relative to (★), never cross it.

One realization detail worth keeping: propensities are mass-action prefactors ×
the symmetric exponential of the *residual* ΔS (finite difference minus the
ideal-mixing log the prefactors already supply) — exact ratio up to O(1/n), and
`n = 0` zeroes the right rates with no availability checks, as promised.

Emergent behaviors observed, all wanted: steady fill profiles that step exactly
at merge junctions; backpressure and honest stall; the effusive filter's side
stream nearly pure (≈1% composites, from in-chamber refusion) while the out
stream is only depleted; a portless side port venting its escaping singles as
haze. The old plug-flow look survives better than expected — width now shows
flux, and the demo reads the same at a glance.
