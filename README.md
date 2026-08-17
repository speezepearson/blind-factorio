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

- Veins are ordered cell paths; one parcel per cell, advecting head→tail one cell per
  tick. Any number of veins may share a cell (drawn in offset lanes).
- Vein endpoints attach: head to a **source**, a mid-vein **fork** (splits half of the
  host parcel), or an organ's **out/side port**; tail to a mid-vein **merge** (adds
  into the host parcel), an organ's **in** port, or nothing (vents).
- **Ghost veins & incarnation**: player-drawn veins start as ghosts — dashed routes
  with no walls. They grow real ("incarnate") at 1 cell per 2 ticks, spreading from
  every contact with the live network: a head on a source or grown organ port, a
  fork/merge onto an incarnate cell, or a live vein's end junctioning onto them
  mid-route. Unconnected ghosts stay ghosts. Ghost cells carry no fluid, exchange no
  heat, and can't be budded on. Preset/imported "wild anatomy" is born incarnate.
- **Infinite throughput; every sink is visible.** Everything advances one cell per
  tick, nothing ever queues. Fluid that runs out of vein *vents* into the cavity —
  at an open tail, at the frontier of a still-incarnating ghost, at a not-yet-built
  merge junction, into a growing organ's mouth (it's building itself with it), or
  as unconsumed organ output at a port with no vein on it. Mass-balance inference
  stays honest because every vent is a structural feature the player can point at;
  fluid never vanishes mid-vein (budding refuses stretches that would hide a
  junction — and thus a vent — under the organ body).
- **Organs** grow by *budding*: double-click a straight, incarnate 5-cell stretch
  (each cut end must leave a ≥2-cell fragment, or nothing with nothing attached,
  and no other vein may junction onto the stretch); the host vein is cut into a feeder and a
  continuation, and the organ swells over GROW_TICKS (10) ticks — swallowing its
  feed and emitting nothing while it grows (downstream drains). The stretch of host
  vein beneath it (the "understretch") stays until growth completes, then is
  garbage-collected. One organ exists so far — the **radical filter** (free radicals
  out the side port, composites out the main port); its name and side-port label
  are god-only on the canvas. Budding is hard-coded; the mixture-determined
  differentiation grammar is the next design milestone.
- Erasing cells removes them from every vein passing through, splitting survivors into
  fragments (fluid rides along); organs touched by an erase die (an interrupted
  organ's understretch survives, re-exposed).

## Two views, one world

- **Player view** (default): vein color, width, opacity, flow direction, and organ
  anatomy. That's it — no composition readouts, no temperature. The game is inducing
  the chemistry from experiments.
- **God mode** (checkbox or **G**): probes (right-click a vein cell) charting per-cell
  composition and temperature over time, the temperature overlay, per-radical
  stickiness sliders, and species labels on sources.

## Module map

| File | Job |
|---|---|
| `src/chem.ts` | The chemistry engine: radical table, species/channel derivation, quantized tau-leaped kinetics, integer heat, seeded RNG, and the color projection. Pure logic, generic over the radical set. |
| `src/world.ts` | The world: veins, organs, sources, positional attachments, the tick (heat → reactions → advection → record), editing ops (commit/erase/bud), undo snapshots. |
| `src/render.ts` | Canvas rendering — the flesh-cavity theme lives here: mottled breathing backdrop (with drips), membrane-walled veins with peristalsis and sub-tick fluid slide, smooth ghost-incarnation extrusion, wobbling organ growth, load-driven heartbeat. Owns the player/god visibility split. All ambience is deliberately dimmer and slower than the data channels (vein color/width). |
| `src/Probes.tsx` | God-mode probe cards: recharts stacked-area composition + temperature line, fed by per-cell ring-buffer history. |
| `src/serialize.ts` | World structure ↔ URL-safe deflated code (`rv` format v1); fluid/heat state intentionally not serialized — imports refill from sources. |
| `src/presets.ts` | Built-in worlds (fuse & filter demo, fresh slate). |
| `src/App.tsx` | The shell: tools, mouse gestures (draw with attachment resolution, erase, probe, bud), rAF sim loop, undo/redo, god mode, sharing. |

## UI architecture

The world is deliberately not React state: `worldRef.current` is mutated in place; a
requestAnimationFrame loop advances the sim by a tick accumulator (speed slider = ticks
per second, each tick identical) and redraws imperatively; a 250 ms pulse re-renders
React for the charts. State the loop needs is shadowed in refs. Undo/redo snapshots the
world per gesture via `snapshotWorld` (probe history excluded — it regrows; stickiness
is chemistry, not world, and is not undoable).

In dev builds `window.__veins` exposes `{world(), chem, tick()}` — the e2e suites use
it to fast-forward the sim deterministically and to assert on hidden state.

## Verifying changes

`npm run build`, `npm run lint`, then `npm run e2e` (dev server on 5173; `E2E_URL` to
override; first-time: `npx playwright install chromium`). Suites are standalone
(`node e2e/<name>.mjs`); `e2e/helpers.mjs` holds the shared driver and the
`worldInfo()` snapshot reader. One physics gotcha the tests encode: organ outputs are
pure only at the port mouth — downstream, chemistry re-equilibrates (free R+G re-fuses,
hot composites dissociate), so assertions about separation must read the first cell,
not whole-vein totals.
