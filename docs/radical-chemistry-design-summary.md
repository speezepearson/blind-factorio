> **Note:** this file is the authoritative, editable copy (the `~/` original it was
> snapshotted from on 2026-08-17 has been retired). The reference prototypes
> `radical-kinetics-sandbox.jsx` and `radical-veins-game.jsx` still live in `~/` on
> the dev VM.
>
> **Branch `inert-pipes` deltas (2026-08-21):** this doc records the design as
> conceived; the shipped branch has since diverged on four points, deliberately
> (see the README banner for the full story). (1) "There is no separate fuel
> system" is no longer true: RGB is a fuel/morphogen with a weak wellhead —
> organs form at junctions in response to it, run on it, and atrophy without it.
> (2) ΔE is no longer ≥ 0 by construction: stickiness may be negative (shipped
> a_B = −4.0), making B's bonds energy-*storing*, with kinetic protection
> (barrier ∝ stored energy moved) keeping fuels metastable. (3) Heat no longer
> conducts along or between veins — pipes are inert; ALL chemistry and heat
> flow lives in organ chambers, so the counterflow heat exchanger is an organ,
> not a drawing technique. (4) Budding is chemistry-triggered at junctions, the
> first real step toward §"mixture-determined budding" below.

# Radical Chemistry — Physics Design Summary

*Working notes for an untitled veins-and-organs game about doing science. Status: core physics designed and prototyped in the "radical kinetics bench" (React artifact); everything in the appendix is brainstormed but not yet committed.*

---

## 1. The game in one paragraph

The player routes fluids through veins between organs that transform them, and grows ("buds") new organs whose type is determined by the fluid mixture at the budding site. The player's real activity is science: the underlying chemistry is hidden, observation is lossy (color is an ambiguous projection of composition), and progress comes from designing experiments, inducing the generative laws, and then exploiting them. Knowledge is the progression currency. Terminology: the fluid conduits are called **veins** — they dilate with flow (width ∝ √throughput), which is the amount channel of the display, orthogonal to color's composition channel. (Internal vocabulary only; nothing here is player-facing wording.)

## 2. Radical-set chemistry

There is a small set of primitive **radicals** — currently five committed: **R** (red), **G** (green), **B** (blue), **K** (black), **X** (invisible) — plus two bench-implemented extras: **C** (cloak — hides whole molecules and drives fluid opacity; liked, likely to graduate; see appendix D) and **Q** (color inverter — design verdict lukewarm; see appendix D). A **chemical species** is a non-empty subset of the radicals, giving 31 species over the committed set (RG, RBX, RGBKX, …).

There is exactly **one reaction law**. When two species meet:

> **A + B ⇌ A∪B + A∩B**

Everything else is a consequence of this law:

- **Disjoint species fuse.** R + G → RG (the intersection is empty).
- **Subset pairs are inert.** G + RG returns G + RG. Inertness is *informative*: it reveals a containment relationship.
- **Partial overlaps exchange.** RG + GB → RGB + G — a genuine rearrangement.
- **Radical counts are conserved** by every reaction (|A|+|B| = |A∪B|+|A∩B| radical-wise), so mass-balance experiments are always valid inference tools.

Because the law is generative rather than tabular, a player who induces it can predict reactions they have never seen — the design goal throughout.

## 3. Color as a lossy projection

Color is *computed* from hidden structure, never assigned. A vein's perceived color is the additive blend of its total radical loads. Since every reaction conserves radical loads, **all chemistry is chromatically invisible**: a vein of R + G looks exactly as yellow as a vein of RG, before, during, and after fusion. The core ambiguity mechanic ("is it yellow, or red-plus-green?") therefore falls out of the physics rather than being decreed, and resolving it requires an experiment (filtering, calorimetry, thermal contact…).

Two radicals extend the ambiguity into new dimensions:

- **K (black)** darkens the perceived color in proportion to its pigment share. Since color is a pure *ratio* projection (amount is invisible in hue and lives in vessel width instead — there is no solvent, the dye *is* the fluid), darkness is an unambiguous K signature: brick red pins down the K:R ratio. K's real ambiguities are the usual binding-state one (R+K free vs. RK fused are identical brick) and perceptual compression at high K fraction, where all hues squeeze toward near-black and effectively mask what's underneath.
- **X (invisible)** contributes nothing to color at all. A pure-X vein looks empty; G + X looks like pure G. X is detectable only through behavior: heat of fusion, mass balance, flow effects. It is the game's neutrino — players will build a confident model of the visible radicals, hit anomalies, and be forced to posit an unseen element. (Instruments and debug views may render X with a stand-in color; the vein never does.)

## 4. Thermodynamics

*Terminology note: reaction dynamics here is deliberately described without orienting reactions. A reaction **channel** is an unordered pair of states — {RG, GB} ⇌ {RGB, G} — with no intrinsic "forward." The only orientation-free labels a channel has are structural: its **tighter side** (more internal bonds) and its **looser side** (fewer). Even "downhill" is not intrinsic: once entropy is counted, which side is lower in free energy depends on temperature and concentration.*

**Heat is the energy currency; there is no separate fuel system.** Each radical pair has a bond energy E_ij; a composite's binding is the sum of its internal pairwise bonds. The two sides of any channel A + B ⇌ A∪B + A∩B differ in total binding by ΔE = the bonds spanning the A\B × B\A boundary (≥ 0 by the structure of the law), which makes the union–intersection side the tighter one. Crossings into the tighter side release ΔE into the heat ledger; crossings out of it absorb ΔE from it.

**Dynamics: valleys and passes.** Each side of a channel sits at a depth given by its binding; the two sides are joined over one shared transition state — a pass at height Ea above the looser side. Each side sends traffic over the pass at a rate set by its climb and its collision frequency:

> crossings/time from side S ∝ A · e^(−s₀·|S|) · e^(−climb_S / T) · Π (concentrations of S)

applied *identically* to both sides. "Concentration" here is a **mole fraction per radical**: n_A / N_radicals in the local volume. There is no solvent — the dye *is* the fluid — so a trickle and a torrent of the same mixture have identical composition and identical per-particle kinetics; amount appears in vein width, never in rates or color. Dilution therefore means *adding other radicals* (an inert diluent shifts every other fraction down), not adding solvent. **Open question:** should the denominator be total radicals (current choice — conserved by every reaction, so it's a constant of the parcel) or total molecules (ideal-gas-flavored — fusion would then shrink the denominator, concentrating the mixture as it proceeds)? The only asymmetry between the two currents is that the tighter side's climb is deeper by ΔE — an asymmetry of the landscape, not the notation (set ΔE = 0 and the channel is perfectly symmetric). **Equilibrium is equal currents, not stopped traffic**: the composition at which every channel's two crossing rates balance, at the tighter:looser occupancy ratio K = e^(−s₀)·e^(ΔE/T). The whole chemistry is a landscape of valleys (compositions) and passes (channels), over which the system performs a thermally agitated random walk, pooling toward Boltzmann occupancy. Consequences, all discoverable:

- **Three temperature regimes.** Cold: crossings freeze out — metastable mixtures persist, enabling cold storage and quenching. Warm: occupancy pools in tightly bound states. Hot: occupancy spreads toward loosely bound states — heating boosts both currents on every channel, but proportionally more for the deeper side, whose climb is bigger.
- **Equilibrium is a ratio, not a destination.** Partial conversion is the norm; composition is a lever (flooding with excess G drags trace R into RG; cutting the mix with an inert diluent shifts occupancy toward the many-particle sides — that's the s₀ term at work).
- **Self-limiting binding.** A fresh R+G mixture slides into the RG valley, and the released heat shifts the balance back toward the loose side, stalling the slide — unless the vein sheds heat, in which case conversion creeps to completion. Vein length, insulation, and ambient temperature are all reaction controls.
- **Partner-swapping only runs hot.** Cold chemistry is purely additive; at high T, traffic out of bound states frees radicals to recombine with new partners. A deep regime difference from nothing but two-way traffic.
- **Cracking spectra.** Distinct bond energies give each composite a characteristic set of pass heights; slowly ramping a mystery fluid's temperature and watching which pass leaks occupancy at each threshold is thermal fractionation — an assay the player can invent. A composite sheds across its shallowest pass first.
- **Equilibrium shifts are chromatically invisible** (conservation again), so the thermodynamic churn hides exactly where hidden state should live. Two identical-looking yellow veins — one hot (poised R+G), one cold (settled RG) — can be distinguished by touching them together and watching what thermal contact does.

Temperature itself should be mostly invisible in-game (a thermometer gland is an instrument to earn). Heat advects with fluid and conducts between adjacent veins, so counterflow heat exchangers, regenerators, and "pre-heat the feed with the product stream" are *inventions*, not items.

**Tuning caution:** the regime structure lives or dies on the steepness of the temperature dependence. Too gentle → everything always slightly reacting, illegible mush. Too steep → temperature becomes a three-position switch. Aim for sharp-ish freeze/crack thresholds with genuinely continuous equilibrium between them.

## 5. Bond energies from per-radical traits (the additive rule)

Rather than ten free bond energies, the current design generates them from one **stickiness** per radical:

> **E_ij = a_i + a_j**

Current personalities: K sticks hard (a universal binder and radical sink), X barely sticks (slippery; X-composites fray at moderate temperatures, so X tends to run free).

This imposes discoverable identities on the world. Swapping any partner from G to B shifts ΔE by the same constant everywhere (a parallel-lines regularity), and — the big one — **every composite sheds its lowest-a radical first, in one global order**: a universal volatility ladder, learnable like a reactivity series. That is both the rule's virtue (players can induce a five-number theory that explains a ten-number table — a genuine act of scientific compression) and its degeneracy (cracking order can never be context-dependent within the additive world).

The intended arc: ship the additive manifold as the "law," then place **sparse hand-tuned exceptions** — one anomalously strong bond — as content. Players who have induced the rule will notice the violation immediately; the balancing patch becomes a plot point. The bench supports this workflow directly (additive mode → seed free mode with derived values → perturb one bond off the manifold).

**Thermodynamic consistency note (Wegscheider condition):** channels form cycles — bind-then-unbind vs. direct exchange connect the same pair of states — so crossing rates cannot be assigned per-channel independently, or the system settles into a permanent circulating flux whose steady state depends on which channels *exist*, breaking the law "catalysts change rates, never destinations." The fix is structural, not a patch: each species carries a free energy G_s = −(its bond sum) − T·s₀ (binding, plus one unit of per-particle entropy), each channel carries one pass height, and every crossing rate comes from the single formula rate ∝ A·e^(−(G‡ − G_side)/T). Balance around every cycle is then automatic for any channel ever added, because it reduces to sums of state functions. The entropy term is also what makes composition a real thermodynamic lever (an inert diluent favors the many-particle side of a channel), and it predicts that channels with equal particle counts on both sides balance at composition-independent ratios — another discoverable regularity.

## 6. Quantization

Everything conserved is an exact integer; there is no float drift by construction.

- **State** = integer particle counts per species + an integer **heat ledger** U (quanta of ε = 0.01 energy units).
- **Crossings are discrete events**: one crossing moves whole particles between counters and whole quanta into or out of U. Floats appear only in *crossing rates* — they decide when events fire, never what they do to the ledger. Conservation of radicals and of (U − bond quanta) is typographical.
- **Temperature is a readout, not a state variable**: T ≡ U·ε / (c_r · N_radicals), with heat capacity riding on the conserved radical count.
- **The climb floor**: a crossing out of a tighter state costs ΔE quanta and simply cannot fire unless U can pay. A cold vein doesn't have exponentially-rare unbinding; it has *zero* unbinding. Freeze-out is exact and crisply reasonable-about.
- **Simulation** by tau-leaping: choose a step so no counter is expected to move more than ~15%, draw Poisson crossing counts for each side of each channel, apply as truncated integer batches. Degrades gracefully to event-driven behavior at small counts.
- **Noise is a feature.** Small particle counts visibly fluctuate; equilibrium visibly breathes. Distinguishing signal from fluctuation, and averaging it down with bigger samples or longer runs, is authentic experimental skill — and it softens exhaustive search, since single trials mislead. The deterministic ODE world re-emerges at large counts.
- **Thermal diffusion** (designed, not yet in bench): heat quanta random-walk between adjacent vein cells at rates set by wall conductivity; Fourier's law and Newton cooling *emerge* from hop counting. Advection is quanta riding fluid parcels. Heat is exactly conserved network-wide.
- Quantization at the physics level matches the game level: valve thresholds, trace contamination, and "did even one K get through the filter" become crisp integer questions.

**Engineering note:** exact ledgers do not automatically give bit-identical *trajectories* across platforms (propensities and RNG draws are floats). For replays/multiplayer sync, use fixed-point rate math with lookup tables and a seeded integer PRNG.

---

# Appendix: brainstormed, not (yet) committed

## A. Organs

- **Reporter gland** — pass-through; glows in proportion to one specific chemical. One gland per target, so assaying an unknown means routing it past a battery — real assay design.
- **Chromatograph** — pass-through; species traverse at different speeds. Separation in time: feed a pulse, read the exit bands. Pairs with any pulse-generating mechanic.
- **Precipitator / clog-as-titration** — certain chemical pairs form solids that clog veins. A clog is information; deliberately mixing an unknown with a known reagent and watching for a clog is a titration. (Sacrificial cheap vein as an instrument.)
- **Bladder / accumulator** — fills, then dumps: converts continuous flow into pulses.
- **Heart / pump** — raises flow rate (requires a pressure quantity). Organs could behave differently by flow rate — e.g. a filter that is only selective when flow is slow.
- **Valve + bladder loops → player-built oscillators** and chemical logic circuits; emergent clocks as a late-game skill ceiling.
- **Concentrator / kidney** — removes solvent; outputs concentrated + dilute streams. Matters wherever concentration thresholds exist.
- **Catalyst bed** — a reaction runs only in the presence of an enzyme chemical that passes through unconsumed; gates chemistry without spending the control substance (contrast: valve).
- **One-way sphincter** — trivial, but wanted once loops exist.
- **Waste economy** — organs excrete waste that slowly poisons their local network, forcing a lymphatic subsystem; long-term plumbing purpose beyond the immediate puzzle.

### A2. Diagnostic organs (instruments)

Already noted above but properly instruments: reporter gland, chromatograph, precipitator-as-titration, membrane vein (a free-vs-bound detector, since only free radicals cross its wall), thermometer gland, and the flow-width rendering (an accidental radical flowmeter — throughput ∝ width²).

*Counting instruments — exploit quantization directly:*

- **Osmometer** — counts *particles* per tick, blind to identity (colligative). Ratio against the flow gauge (which counts *radicals*) yields mean molecule size: a fusion-state readout no color trick can fool. Cheap-sensor triangulation of a hidden variable.
- **Clicker / Geiger gland** — one discrete blip per molecule of a target species. Useless on bulk flows, essential for traces ("did even one K get past my filter?"). Makes the integer physics *felt*.
- **Counter gland** — running integer total of particles passed; integrates what the clicker samples.

*Destructive assays — consume a sample, answer a deep question:*

- **Bomb calorimeter** — diverts a sampled parcel, force-cracks it completely, reports total bond energy liberated: a scalar fingerprint of binding structure (distinguishes RG+B from RB+G from R+G+B, which nothing colorimetric can).
- **Flame gland** — fully cracks a small sample and flashes the color of the freed *radicals*. Bypasses every chromatic ambiguity at once (K-masking, fusion-blindness, Q-inversion) by reading radicals rather than molecules; balance by making it slow or sample-hungry. The flame test.
- **Fractionating column** — the thermal-fractionation assay promoted to an organ: internal temperature gradient, multiple outputs sorted by cracking threshold. Late-game automation of what early players did manually with a heater and a probe.

*Differential instruments — comparison is cheaper than decoding:*

- **Null comparator** — two inputs, glows by compositional *difference*. Reveals nothing about either fluid, only whether they match — enough for binary search over hypotheses, verifying syntheses against reference samples, leak-hunting. Wheatstone-bridge energy.
- **Reaction tester** — samples a drop, mixes it with a player-chosen reference chemical in an internal chamber, reports the temperature deflection. "Does my mystery fluid react with G?" answered without contaminating the main line: titration, containerized.

*Recorders — measurement across time:*

- **Litmus lining / max-hold stain** — vein coating that permanently discolors at its historical maximum temperature, or on first contact with a target species. Passive forensics for "what happened while I wasn't looking" (oscillators, rare transients); thematically, scar tissue as data.

*Sample prep — not sensors, but what makes sensing possible:*

- **Pulse gate** — passes one parcel every N ticks. Exists mostly to make the chromatograph usable: instruments that need other instruments is a good dependency structure.
- **Getter bed** — consumable cartridge that scavenges a trace species over many ticks, then releases it as one concentrated slug. A preconcentrator: the answer to "signal real but below my reporter's noise floor," which stochastic parcels guarantee players will hit.
- **Tracer tap** — injects a trickle of X; invisible and slippery, it rides the flow, and an X-reporter downstream yields transit times and routing answers. Radiolabeling, built by *reusing* X's designed properties rather than adding new ones.

Two design principles for the whole category. Every instrument should be a **different lossy projection with different blind spots** (reporters see species but not temperature; calorimeters see energy but not identity; osmometers see count but not kind), so no single organ suffices and cross-instrument triangulation is the skill being taught. And instruments should **cost or perturb** — destructive assays eat flow, taps add thermal mass, getter beds are consumable — so measurement stays a decision rather than a default. Observer effects are honest physics anyway.

A starter trio for the prototype: thermometer gland, reporter gland, osmometer — each a pass-through with one readout, and together they cannot be fooled by any mixture in the three-radical world.

## B. Differentiation (budding)

- **Grammar, not recipe book**: a few morphogen chemicals set organ *class*; the dominant non-morphogen dopant sets *parameters* (filter target, valve trigger); ratios tune continuous parameters. Combinatorially hopeless to brute-force, crackable by controlled experiments, and it *generalizes* ("I bet A + copper-doping makes a copper filter").
- **Graded failure**: near-miss mixtures produce diagnostically malformed organs (right morphogens, no dopant → filter with a sealed port; viable base, no morphogens → inert cyst). Every failed bud is a data point.
- **Wild anatomy as cluing**: set the game inside an existing organism; wild organs sit on veins still carrying (or bearing residue of) the mixtures that budded them. Early game is dissection and reverse-engineering — nature already published the reference examples. Tutorializes without text.
- **Budding as chemistry**: budding consumes its morphogens and dopants from the flow, so learning the chemistry and learning differentiation are the same skill, and instruments work on budding questions too.
- **Temperature as a morphogen axis**: same mixture, different organ budded hot vs. cold; incubation-temperature windows. Doubles recipe space with no new chemicals.

## C. Veins

- **Thermal triad**: normal / insulated / thin-walled (radiator). Makes the counterflow heat exchanger an explicit design act.
- **Membrane vein**: wall passes single free radicals down their concentration gradient; composites stay inside. Passive dialysis; two membrane veins side by side = the exchanger organ invented from raw materials. Also a third experimental channel distinguishing free-R from fused-RG — and it couples to thermo (hot membrane vein bleeds, cold one holds). Probably grown/budded rather than coated.
- **Caustic radical + resistant vein**: the caustic radical eats normal vein gradually; pinhole leaks localize its concentration (corrosion-as-assay). Fused caustic is sequestered and harmless — so "keep it fused and keep this line cold" ties corrosion risk to thermal management. Natural region gating.
- **Acquisition by deposition**: all vein starts as bare stock; running the right fluid coats it (insulating scale, catalytic lining, vitrified caustic resistance). Vein variety is discovered, not purchased; coating a long run is itself a plumbing problem. Dark twin for free: **fouling** — unwanted deposition narrowing bores and insulating exchangers, demanding descaling flushes or better upstream chemistry.
- **Bore width as a slider**, not a type: sets flow rate and surface-to-volume ratio, so narrow vein exchanges heat faster and corrodes faster for free.
- **Veins as differentiated tissue**: possibly unify with organ budding — extruded vein type determined by mixture, the "vein menu" is a recipe book the player fills in.
- **Legibility rule**: vein walls should be the one part of the system with *no* hidden state — wall types unmistakable at a glance, coatings visibly accreted.
- Cut: one-way vein (sphincter covers it), elastic vein (bladder covers pulse-smoothing; revisit if pulses become central).

## D. Alternative chemistries (roads not taken, or reserved)

- **Integer/prime chemistry**: chemicals as integers, color from prime factorization, organs multiply/factor; players independently invent primality. Risks: unbounded space, and the mystery collapses all at once when recognized as arithmetic. Maybe one exotic region.
- **Polymer chemistry (layer two)**: chemicals as short strings; color reflects letter composition but not order ({ABBA} vs {BABA}); cutters cleave motifs, sticky ends concatenate. Deepest hidden structure; brutal inference load. Reserve for late game: radicals *chain* into polymers whose order matters.
- **Charge/valence bonds** E_ij = q_i·q_j with signs: repulsion → forbidden composites → discoverable selection rules (valence); cracking cost q_x(Q_S − q_x) is non-monotone, so binding order can invert between composites. Richer than additive at the same parameter count; keep signs or it flattens.
- **Geometric bonds**: radicals as points on a shape, E from distance/adjacency; the radical "map" as a discoverable in-game artifact. Pretty lore, awkward tuning.
- **Electronegativity hybrid** (the likely successor to plain additive): E_ij = a_i + a_j + β·(χ_i − χ_j)² — stickiness plus polarity, near-verbatim Pauling. The additive ladder survives as a first approximation; polarity anomalies break it exactly where placed. Built-in "your theory was only approximately right" beat, invisible until the player's additive model starts mispredicting.
- **Anomalies as lore** regardless of rule: sparse exceptions to the generating law presented as engineered radicals or a broken law in one region.
- **C, the cloak radical** *(implemented in the bench; liked — likely to graduate to committed; not yet in the game prototype)*: middling stickiness (a(C) = 1.0 — a cloak that instantly falls off is no cloak). Any molecule containing C contributes zero pigment (C trumps Q), and the fluid's opacity is 1 − (fraction of all radicals residing in C-containing molecules). Contrast with X: RX still reads red; RC is gone. Because binding C drags its partners into the cloak, opacity is a *live binding-state readout*: 1R+1C starts half-opaque red and fades toward glass as RC forms (α 0.5 → ~0.1 at a fused-heavy equilibrium → 0 at completion), and heating re-condenses it into visibility. This composes with thermodynamics for free — where C is in the mix, cloaked composites fade in cold regions and reappear in hot ones, making temperature structure visible through chemistry with no thermometer. Two boundary behaviors, both intended but dramatic: C is *greedy* (one C in a large composite cloaks all its radicals, so trace C punches far above its weight — a saboteur's radical), and a fully-fused C fluid renders at α = 0, leaving only vein width as the tell: the invisible torrent. Open cosmetic question: whether to floor α at ~0.05 as a faint shimmer. C still counts toward radical flow, so vein width shows cloaked flows automatically.
- **R′, the doppelgänger radical** *(brainstorm)*: a second red — pigment identical to R, chemistry and bio-signals its own (different stickiness, so different fusion partners, equilibria, and cracking thresholds; and the differentiation grammar, reporter glands, and other bio-machinery treat it as a distinct species entirely). Until now chromatic ambiguity lived in *molecules* — fusion-blindness, K-masking — while the radicals themselves were chromatically honest; R′ forges the primary itself, so even a pure-looking red source is a hypothesis, not an observation. The tell is behavioral: a stickiness ladder fitted to "red" stops converging, and the residuals correlate by *provenance* rather than by reaction partner — the isotope experience (same look, different physics), resolvable by thermal fractionation, calorimetry, or feeding a bud and seeing what grows. Once identified it flips into a gift: a tracer that is visually *present but forged* (complementing X, which is visually absent) — dose one branch with R′ and let a downstream reporter or bud read the routing while every chromatic instrument swears nothing changed. And bio-signals diverging from chemistry opens a door the projection can't: organs that "smell" identity rather than color, the first wedge between physics' lossy eye and biology's.
- **Q, the inverter radical** *(implemented in the bench; design verdict lukewarm — kept for reference)*: low stickiness; a molecule with Q bound in contributes the *complement* of its own hue (QR cyan, QRG blue, QK white), while free Q is colorless. This makes Q-binding the one chemistry color can see — the color drift of an R+Q vein is a naked-eye reaction-rate readout, and heating a QR vein visibly reverts it as slippery Q pops off. Side effect: QRGB's complement hue is empty, so it renders *clear* — aliasing with pure X and empty vein, a new invisible-fluid ambiguity (not, as first claimed, a dark one against K). The general lesson worth keeping even if Q goes: a radical whose *binding state* alters the color projection turns the vein itself into a kinetics instrument.

## E. Thermo & world extras

- **Heat sources/sinks must have costs** or "make everything hot" degenerates: ambient leakage to a cold world for the sink; a designated fuel radical whose bonds are unusually deep (so binding it dumps a lot of heat), or geography (volcanic vents, cold rivers) making heat a positional resource that motivates long-haul thermal plumbing.
- **Thermal oscillators** (fusion heats → cracks → cools → fuses again): watch for them as simulation instability, but a player-built one is probably a feature to keep.
- **Quench-and-freeze as lab technique**: chill a sample to halt its chemistry mid-flight, then examine at leisure.
- **Calorimetry as the first X-detector**: the vein looks like pure G; the thermometer betrays the G+X fusion.
- **Cold yellow vein ambiguity** (frozen R+G vs. RG) resolved by warming and watching for exotherm — the flagship "two identical veins, one experiment" puzzle.

## F. Bench wishlist (prototype-side)

- Thermal diffusion between multiple vein cells (quanta hopping), to prototype heat exchangers.
- Fixed-point/deterministic mode for replay-identical trajectories.
- A pulse-input mode (for chromatograph experiments) and a temperature-ramp mode (for cracking-spectrum assays).
- Composition-variance overlay (currently only temperature traces overlay across seeds).
