# Veins

A prototype of a **veins-and-organs game about doing science**. Fluids made of hidden
*radicals* flow through veins between organs; the underlying chemistry is governed by a
single generative law the player never sees. Observation is lossy — color is an
ambiguous projection of composition — so progress means designing experiments, inducing
the laws, and exploiting them. The full physics design lives in
[`docs/radical-chemistry-design-summary.md`](docs/radical-chemistry-design-summary.md)
(a snapshot; the editable originals, plus the two reference prototypes
`radical-kinetics-sandbox.jsx` and `radical-veins-game.jsx` that this app is a
TypeScript port and continuation of, live in `~/` on the dev VM).

This repo previously hosted the wavelength-optics prototype "blind-factorio"; that whole
game is preserved at the git tag `wavelength-era`.

## Running it

`npm`/`node` are not on the default PATH in this VM:

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run dev     # serves on port 5173; blind-factorio.exe.xyz proxies to it
npm run build   # tsc + vite build — the de-facto typecheck, keep it green
npm run lint    # oxlint
npm run e2e     # Playwright suites in e2e/ (dev server must be up)
```

`vite.config.ts` pins port 5173 and allowlists `blind-factorio.exe.xyz`; keep both.

## The physics

- **Radicals and species.** There is a small set of primitive radicals (shipped content:
  R, G, B; the engine is generic — K (black) and X (invisible) are designed and arrive
  by appending to `DEFAULT_RADICALS` in `chem.ts`). A chemical species is any non-empty
  subset of the radicals. The one reaction law: **A + B ⇌ A∪B + A∩B** — disjoint
  species fuse, subset pairs are inert, partial overlaps exchange. Radical counts are
  conserved by every reaction.
- **Bond energies** come from one per-radical *stickiness*: E_ij = a_i + a_j. Each
  reaction channel's tighter side (union + intersection) is deeper by the boundary
  bonds ΔE; crossings into it release ΔE as heat, crossings out must pay it.
- **Everything conserved is an exact integer.** A parcel is integer particle counts per
  species plus a heat ledger U in quanta of 0.01 energy. Temperature is a readout
  (U·ε / heat capacity), not a state variable. Kinetics is tau-leaped Poisson crossings;
  a cold parcel doesn't have *rare* unbinding, it has *zero* unbinding (the climb
  floor). Noise at small counts is a feature — distinguishing signal from fluctuation
  is experimental skill.
- **Color is a lossy projection**: the additive blend of a parcel's total radical
  loads. Since reactions conserve loads, *all chemistry is chromatically invisible* —
  R+G looks exactly as yellow as RG, before, during, and after fusion. Vein **width**
  (∝ √throughput) is the amount channel, orthogonal to color's ratio channel.
- **Heat moves**: along veins, between co-located veins (crossing veins exchange heat
  but not matter — counterflow heat exchangers are an *invention*), and leaks to
  ambient. Heat capacity rides entirely on the fluid; vein walls are **thermally
  invisible** (zero capacity, no hidden thermal state — an empty vein has no
  temperature). Fusion is self-limiting: released heat shifts the balance back until
  the vein sheds it.

## The world

**There is no grid.** The world is a continuous 966×630 canvas; veins are freehand
curves. The rigid quantization survives because it never lived in geometry: each
drawn curve is resampled into NODES spaced ~SEG (16 px) apart along its arc, one
integer-ledger parcel per node, advecting node-to-node one hop per tick. Geometry
only decides which discrete containers sit next to which, and it is frozen at draw
time (all committed coordinates are quantized to quarter pixels, so worlds
serialize and replay exactly). `src/geom.ts` owns the constants and primitives.

- Veins are node chains; drawing is freehand (Chaikin-smoothed, arc-resampled).
  Vein endpoints attach: head to a **source**, a mid-vein **fork** (splits half of
  the host parcel), or an organ's **out/side port**; tail to a mid-vein **merge**
  (adds into the host parcel), an organ's **in** port, or nothing (vents).
  Fork/merge/probe anchors are *points*, resolved to the nearest node within R_SNAP
  and healing onto whatever covers the spot. A forking or merging stroke is snapped
  onto its junction: its end node lands exactly on the host node, and the mixed
  color downstream begins with a flat cut exactly there (the upstream half-span of
  the junction region keeps the incoming line's color). **Endpoints snap**: a stroke starting on
  a vein's open tail extends that vein (no fork, no split); one ending on an open
  head prepends to it (feeds it); one bridging an open tail to an open head fuses
  the three into a single vein.
- **Proximity heat**: any two incarnate nodes within R_CROSS (10 px) that aren't
  chain neighbors exchange heat — crossings, closely parallel runs, even a vein's
  own hairpins. Matter never crosses between veins except at junctions. Drawing two
  veins side by side *is* a heat exchanger.
- **Ghost veins & incarnation**: player-drawn veins start as ghosts — dashed
  threads with no walls. They grow real ("incarnate") at 1 node per 2 ticks,
  spreading from every contact with the live network: a head on a source or grown
  organ port, a fork/merge onto an incarnate node, or a live vein's end junctioning
  onto them mid-route. Unconnected ghosts stay ghosts. Ghost nodes carry no fluid,
  exchange no heat, and can't be budded on. Preset/imported "wild anatomy" is born
  incarnate.
- **Infinite throughput; every sink is visible.** Everything advances one node per
  tick, nothing ever queues. Fluid that runs out of vein *vents* into the cavity —
  at an open tail, at the frontier of a still-incarnating ghost, at a not-yet-built
  merge junction, into a growing organ's mouth (it's building itself with it), or
  as unconsumed organ output at a port with no vein on it. Every vent is *drawn*: a
  fuzzy haze of the escaping fluid's own light, area ∝ rate (invisible fluid vents
  invisibly). Mass-balance inference stays honest because every vent is a structural
  feature the player can point at; fluid never vanishes mid-vein (budding refuses
  stretches that would hide a junction — and thus a vent — under the organ body).
- **Organs** are discs (radius R_ORGAN = 52 px) grown by *budding*: double-click a
  vein and the disc centers on its nearest node, eating the contiguous in-disc
  stretch of that vein — curves and all. Requirements: the vein must flow in from
  outside the disc; downstream it must exit or terminate openly inside; no other
  vein may junction onto the eaten stretch; each cut end must leave a ≥2-node
  fragment or nothing-with-nothing-attached. **Ports sit where the curve pierced
  the membrane** (a vein ending inside gets its out port relocated to the rim point
  farthest from the in port; an exit right at the entry point shoves the out port
  along the rim and grows a connecting stub); the side port takes the rim point
  farthest from both, preferring spots no surviving vein runs through. Other
  stretches of the same vein crossing the disc are untouched. **Budding is local**:
  the host is snipped once, at the organ's center (a cut the newborn blob
  immediately covers); both halves stay intact — hidden under the opaque growing
  blob — while the organ swells over GROW_TICKS (10) ticks, swallowing its feed and
  emitting nothing (downstream drains). Only on completion are the halves trimmed
  back to the membrane and the ports attached. One organ exists so far —
  the **radical filter** (free radicals out the side port, composites out the main
  port); its name and side-port label are god-only on the canvas. Budding is
  hard-coded; the mixture-determined differentiation grammar is the next design
  milestone.
- Erasing is a brush: nodes within R_ERASE of the stroke vanish, splitting veins
  into fragments (fluid rides along); organs the brush touches die (an interrupted
  organ's snipped host halves survive, re-exposed). **Shift-click** severs the whole
  junction-to-junction stretch under the cursor — it glows red on shift-hover first.

## Two views, one world

- **Player view** (default): vein color, width, opacity, flow direction, and organ
  anatomy. That's it — no composition readouts, no temperature. The game is inducing
  the chemistry from experiments.
- **God mode** (checkbox or **G**): probes (right-click a vein) charting per-node
  composition and temperature over time, the temperature overlay, per-radical
  stickiness sliders, and species labels on sources.

## Module map

| File | Job |
|---|---|
| `src/chem.ts` | The chemistry engine: radical table, species/channel derivation, quantized tau-leaped kinetics, integer heat, seeded RNG, and the color projection. Pure logic, generic over the radical set. |
| `src/world.ts` | The world: veins, organs, sources, positional attachments, the tick (heat → reactions → advection → record), editing ops (commit/erase/bud), undo snapshots. |
| `src/render.ts` | Canvas rendering — the flesh-cavity theme lives here: mottled breathing backdrop (with drips), veins with peristalsis and sub-tick fluid slide (the pale membrane wall shows only where the vein reads empty — flowing fluid *is* the vein), smooth ghost-incarnation extrusion, wobbling organ growth, load-driven heartbeat. Owns the player/god visibility split. All ambience is deliberately dimmer and slower than the data channels (vein color/width). |
| `src/geom.ts` | Continuous-space primitives: smoothing, arc-length resampling, quarter-pixel quantization, the node spatial hash, and every geometric constant (SEG, R_SNAP, R_CROSS, R_ORGAN…). |
| `src/Probes.tsx` | God-mode probe cards: recharts stacked-area composition + temperature line, fed by per-node ring-buffer history. |
| `src/serialize.ts` | World structure ↔ URL-safe deflated code (`rv` format 2: quarter-pixel integer points, lossless round-trip; rv 1 grid codes migrate, loading fully incarnate); fluid/heat state intentionally not serialized — imports refill from sources. |
| `src/presets.ts` | Built-in worlds (fuse & filter demo, fresh slate). |
| `src/App.tsx` | The shell: tools, mouse gestures (draw with attachment resolution, erase, probe, bud), rAF sim loop, undo/redo, god mode, sharing. |

## UI architecture

The world is deliberately not React state: `worldRef.current` is mutated in place; a
requestAnimationFrame loop advances the sim by a tick accumulator (speed slider = ticks
per second, each tick identical) and redraws imperatively; a 250 ms pulse re-renders
React for the charts. State the loop needs is shadowed in refs. Undo/redo snapshots the
world per gesture via `snapshotWorld` (probe history excluded — it regrows; stickiness
is chemistry, not world, and is not undoable).

In dev builds `window.__veins` exposes `{world(), chem, tick(), tempOf(parcel), resolveAttach(att)}` — the
e2e suites use it to fast-forward the sim deterministically and to assert on hidden
state through the real physics formulas.

## Verifying changes

`npm run build`, `npm run lint`, then `npm run e2e` (dev server on 5173; `E2E_URL` to
override; first-time: `npx playwright install chromium`). Suites are standalone
(`node e2e/<name>.mjs`); `e2e/helpers.mjs` holds the shared driver and the
`worldInfo()` snapshot reader. One physics gotcha the tests encode: organ outputs are
pure only at the port mouth — downstream, chemistry re-equilibrates (free R+G re-fuses,
hot composites dissociate), so assertions about separation must read the first node,
not whole-vein totals.
