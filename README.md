# blind-factorio

A prototype sandbox for a game about **manipulating a factory you can't touch very precisely**.
Glowing fluids flow through pipelines between machines on a square grid. A designer ("god mode")
builds a factory with full information; a player sees an obscured version — anonymous
machines, unlabeled ports, secretive pipes, blind pipe-drawing — and has to probe and
manipulate it by watching what the light does.

## Running it

`npm`/`node` are not on the default PATH in this VM:

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run dev     # serves on port 5173; blind-factorio.exe.xyz proxies to it
npm run build   # tsc + vite build — the de-facto typecheck, keep it green
npm run lint    # oxlint
```

`vite.config.ts` pins port 5173 and allowlists `blind-factorio.exe.xyz`; keep both.

## The rules of the world

- The world is a fine grid (170×110 cells of 6px). Machines are authored on a coarser
  5× grid (`SCALE` in `machines.ts`), so a "2×2" machine really occupies 10×10 fine cells.
- Fluid travels in **pipelines**: directed stretches of pipe (an ordered path of cells)
  running through open space. Pipelines are edges in a graph whose nodes are machines
  and **junctions** — each attaches (positionally, by touch: a port edge on *any* side
  of the endpoint cell counts, straight-through side preferred) to an out-port or
  junction at its intake and an in-port or junction at its outflow. Any number of pipelines may pass
  through the same cell without interacting: crossing never connects. Releasing a pipe
  drag *on* an existing pipe splices in a junction (the trunk becomes two pipelines);
  a junction sums its inflows and splits the total evenly among its outflows, so
  merged pipes carry the sum (and visibly fatten — width ∝ √rate). Starting a drag on
  a junction taps out of it; starting one on a pipeline's *dangling tail* picks that
  pipeline back up and extends it (same id, in-flight fluid kept). Erasing any cell of
  a pipeline removes that whole stretch, endpoint to endpoint.
- Machines have ports (contiguous runs of perimeter edges) and a `compute` function from
  per-port inputs to per-port outputs. Fluids are identified by **light wavelength**
  (400–800 nm), and every stream — in a pipe or at a port — is a whole **mixture**
  (`FluidMap`: wavelength → L/s). A pipe draws with width ∝ √(total rate) and the color
  of its combined light: the fluid is a cloud of tiny equal-power monochromatic
  emitters, folded through the CIE observer (`light.ts`), so pure 556 nm and
  650 nm + 540 nm flowing together are visually indistinguishable but mechanically
  different — and near-infrared fluid emits no visible light, so it flows jet black.
  A port's output is split
  evenly among the pipelines drawing from it. Machine types: spring (emits an arbitrary
  list of wavelength/rate components from its whole perimeter), reactor (conditional rule with
  wavelength tolerances, emits its output wavelength), funnel (merges streams, passes
  the mixture through untouched), blender (irreversibly homogenizes a mixture to its
  rate-weighted *average wavelength* — which usually looks nothing like the mixture
  did), filter (band-pass: in-band components out one port, the rest out the other;
  cannot split a homogenized fluid), buffer (stateful: fills to capacity, then drains
  its stored mixture proportionally), sink (slurps everything, glows while the incoming
  wavelength composition matches its target mixture), fabricator (fed ≥5 L/s of red
  650 nm light — off-red counts at a discount, far-from-red counts *against* — it
  builds its configured product on a per-kind timer and fills in ghosts; its progress
  bar is visible even to the player).
- **Budget & ghosts**: the world carries a player budget (`World.budget`) — total pipe
  cells plus a count per machine type. Player-mode building spends it and player-mode
  erasing refunds it; god mode ignores it and edits it (panel inputs). Anything the
  player can't afford still lands, but as a dashed **ghost** (`ghost: true` on
  Machine/Pipeline): inert in the sim, invisible to attachment, yet still reserving its
  cells. A fabricator making the matching kind fills ghost machines whole
  (nearest-first) and ghost pipes cell-by-cell from the intake end — each built cell
  extends an adjacent dangling real pipeline when there is one, so a part-built route
  grows as a single pipeline. Copying captures ghosts as real blueprint entries; paste
  decides real-vs-ghost by the budget at paste time.
- The sim ticks synchronously every 110 ms (`TICK_MS`); each pipeline's contents shift
  one cell toward its far end per tick — the head refills from its source (a port's
  fresh output or a junction's summed inflow, split evenly among consumers), the tail
  delivers last tick's arrival to its destination port or junction. `step()` is
  `(world, prevSim, dt) -> nextSim` — pure *except* that ready fabricators fill ghosts
  at the end of the tick (`deployFabricators`), the one place the sim mutates the world.

## Module map

| File | Job |
|---|---|
| `src/types.ts` | Core data types: World (incl. Budget), Machine, MachineType, ports, params, Pipeline. |
| `src/geom.ts` | Grid constants (`GRID_W`/`GRID_H`/`CELL`) and geometry: sides, rotation, machine placement, pipeline path orientation and cell lookups. |
| `src/light.ts` | Wavelength → sRGB color science: CIE observer fit, spectral-mixture rendering, gamut mapping, wavelength band names. |
| `src/machines.ts` | The machine-type catalog + wavelength math. **To add a machine type, append one object here** — shape (coarse cells via `scaleCells`), ports, editable params, `compute`, optional `describeState`. Everything else (placement, rendering, editing, serialization) picks it up automatically. |
| `src/sim.ts` | The tick function. Owns per-machine persistent state (`ComputeCtx.state`) for stateful machines. |
| `src/starter.ts` | The pre-built demo factory the app boots into. |
| `src/presets.ts` | The "Load preset…" worlds, e.g. "Green, two ways" (lookalike sources/sinks that only the right wavelengths satisfy). |
| `src/serialize.ts` | World ↔ URL-safe base64 deflated JSON, for Export/Import/`#world=` links. |
| `src/App.tsx` | The UI shell: tools, mouse handling, undo/redo, world sharing. |
| `src/render.ts` | Canvas rendering of the world + tool overlays. |
| `src/clipboard.ts` | Regions (squares or lassoed blobs: bbox + cell set + outline polygon) and copy/paste/rotate of them. |
| `src/budget.ts` | Player-budget accounting (take/refund for pipe cells and machines) — the only place stock changes. |
| `src/Panel.tsx` | The inspector/help side panel, including the mixture-list editor springs and sinks share and the budget strip (read-only for players, editable in god mode). |

## UI architecture (read before touching App.tsx)

The world is **deliberately not React state**. `worldRef.current` is mutated in place by
tool gestures; a 110 ms interval (divided by the toolbar Speed multiplier — ticks come
faster but each tick is unchanged) advances the sim and redraws imperatively — the world
renders to an *offscreen* canvas, which is blitted to the visible canvas with the
copy/erase/paste selection overlay drawn on top (so region snapshots, used for the paste
ghost, can read the offscreen canvas without capturing overlays); a `setTick` counter
forces React re-renders only so the side panel shows live values.
Every piece of state the draw loop needs is shadowed in a ref (`toolRef`, `godModeRef`, …)
so the interval and mouse handlers never close over stale values. React state proper only
drives the toolbar and panel. Undo/redo snapshots the whole world with `structuredClone`
per *gesture* (rapid edits of the same machine param coalesce).

Two views of the same world:

- **God mode** (checkbox or **G**, default off): machine identities/labels/ports,
  placement buttons, dragging machines (Edit tool), param editing.
- **Player view**: anonymous grey machines, the inspector refuses to identify machines,
  and pipe drawing is blind (no drag preview — just the crosshair cursor). Copy and
  erase **free-select**: drag a lasso around whatever you want (a click still selects
  the slider-sized square centered on the cursor). Sinks glow for the player too — that
  feedback is the game.

## Sharing

Export/Share serialize the world *structure* (machines + params + pipelines + junctions +
budget + ghost flags; doc `v: 3` — older codes load with a roomy default budget). Sim fluid and
machine internal state (e.g. a buffer's contents) are intentionally not serialized —
import re-runs 400 warm-up ticks (`prewarm`) instead. View config (god mode) is also
deliberately not part of world codes. World codes decode from either
base64 alphabet; links look like `https://blind-factorio.exe.xyz/#world=<code>`.

## Verifying changes

`npm run build` (the de-facto typecheck), `npm run lint`, then `npm run e2e` — the
end-to-end suites in `e2e/` drive a dev server (expected on 5173, override with
`E2E_URL`) with headless Playwright Chromium: they place machines, drag pipes, hover
things, and read the inspector panel text. Each file is standalone
(`node e2e/<name>.mjs`); `e2e/helpers.mjs` holds the shared driver. One recurring
gotcha lives there already: toggling god mode reflows the toolbar and moves the
canvas, so cell→pixel math must re-fetch the canvas bounding box after every toggle
(use the `godToggle`/`loadPreset` helpers, which do). First-time setup:
`npx playwright install chromium`.
