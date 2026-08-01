# blind-factorio

A prototype sandbox for a game about **manipulating a factory you can't touch very precisely**.
Colored fluids flow through pumps between machines on a square grid. A designer ("god mode")
builds a factory with full information; a player sees an obscured version — blurred, anonymous
machines on a gridless canvas — and has to probe and manipulate it with fuzzy tools.

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
- Each fine cell is blank, part of a machine, or holds pumps. A cell can hold **two**
  crossing straight pumps (one per axis); a bent pump claims the whole cell (`mergePumps`).
- Machines have ports (contiguous runs of perimeter edges) and a `compute` function from
  per-port inputs to per-port outputs. Fluids are identified by **light wavelength**
  (400–800 nm), and every stream — in a pump or at a port — is a whole **mixture**
  (`FluidMap`: wavelength → L/s). A pipe draws with width ∝ √(total rate) and the color
  of its combined light: the fluid is a cloud of tiny equal-power monochromatic
  emitters, folded through the CIE observer (`light.ts`), so pure 556 nm and
  650 nm + 540 nm flowing together are visually indistinguishable but mechanically
  different — and near-infrared fluid is almost invisible. A port's output is split
  evenly among the pumps drawing from it. Machine types: spring (emits a one- or
  two-wavelength mixture from its whole perimeter), reactor (conditional rule with
  wavelength tolerances, emits its output wavelength), funnel (merges streams, passes
  the mixture through untouched), blender (irreversibly homogenizes a mixture to its
  rate-weighted *average wavelength* — which usually looks nothing like the mixture
  did), filter (band-pass: in-band components out one port, the rest out the other;
  cannot split a homogenized fluid), buffer (stateful: fills to capacity, then drains
  its stored mixture proportionally), sink (slurps everything, glows while the incoming
  wavelength composition matches its target mixture).
- The sim ticks synchronously every 110 ms (`TICK_MS`); pump-to-pump flow advances one
  cell per tick, machine outputs are recomputed each tick from the previous tick's pump
  contents. `step()` is a pure function `(world, prevSim, dt) -> nextSim`.

## Module map

| File | Job |
|---|---|
| `src/types.ts` | Core data types: World, Machine, MachineType, ports, params, pumps. |
| `src/geom.ts` | Grid constants (`GRID_W`/`GRID_H`/`CELL`) and geometry: sides, rotation, machine placement, pump path orientation, pump merging. |
| `src/light.ts` | Wavelength → sRGB color science: CIE observer fit, spectral-mixture rendering, gamut mapping, wavelength band names. |
| `src/machines.ts` | The machine-type catalog + wavelength math. **To add a machine type, append one object here** — shape (coarse cells via `scaleCells`), ports, editable params, `compute`, optional `describeState`. Everything else (placement, rendering, editing, serialization) picks it up automatically. |
| `src/sim.ts` | The tick function. Owns per-machine persistent state (`ComputeCtx.state`) for stateful machines. |
| `src/starter.ts` | The pre-built demo factory the app boots into. |
| `src/presets.ts` | The "Load preset…" worlds, e.g. "Green, two ways" (lookalike sources/sinks that only the right wavelengths satisfy). |
| `src/serialize.ts` | World ↔ URL-safe base64 deflated JSON, for Export/Import/`#world=` links. |
| `src/App.tsx` | The UI shell: tools, mouse handling, undo/redo, world sharing. |
| `src/warp.ts` | How we lie to the player: warp noise, the tool-square edge warp, the lake compositor, and the `Obscura` settings bundle. |
| `src/render.ts` | Canvas rendering of the world + tool overlays. |
| `src/clipboard.ts` | Regions (squares or lassoed blobs: bbox + cell set + outline polygon) and copy/paste/rotate of them. |
| `src/Panel.tsx` | The inspector/help side panel. |
| `src/LakeEditor.tsx` | The god-mode table for editing lake ripple layers. |

## UI architecture (read before touching App.tsx)

The world is **deliberately not React state**. `worldRef.current` is mutated in place by
tool gestures; a 110 ms interval (divided by the toolbar Speed multiplier — ticks come
faster but each tick is unchanged) advances the sim and redraws imperatively — the world
renders to an *offscreen* canvas, and a requestAnimationFrame loop composites that onto
the visible canvas (through the time-varying "lake" warp outside god mode), then draws
the copy/erase/paste selection overlay on top so its boundary can ripple at frame rate;
a `setTick` counter forces React re-renders only so the side panel shows live values.
Every piece of state the draw loop needs is shadowed in a ref (`toolRef`, `godModeRef`, …)
so the interval and mouse handlers never close over stale values. React state proper only
drives the toolbar and panel. Undo/redo snapshots the whole world with `structuredClone`
per *gesture* (rapid edits of the same machine param coalesce).

Two views of the same world:

- **God mode** (checkbox or **G**, default off): fine-grid lines, machine
  identities/labels/ports, placement buttons, dragging machines (Edit tool), param
  sliders, blur/warp sliders.
- **Player view**: no grid lines at all, anonymous grey machines, Gaussian-blurred canvas,
  inspector refuses to identify machines. Copy and erase **free-select**: drag a lasso
  around whatever you want (a click still selects the slider-sized square centered on the
  cursor). The selection is honest — the lassoed cells are exactly what's copied/erased —
  but its drawn boundary is displaced through a world-locked smooth noise field ("Warp"
  amplitude + "Warp scale" sliders, in cells), rippled in time by a differently-seeded
  copy of the lake's layered field (so the boundary never visually agrees with a fixed
  patch of map), and Gaussian-blurred ("Tool blur" slider) — its exact position and edges
  can't be pinned down. On top of that, the whole map view is composited through a
  time-evolving warp field, like watching the factory through the surface of a lake —
  a sum of noise layers, each with its own wave direction/speed (drift), magnitude,
  wavelength, and time scale, edited in the collapsible "Lake ripple layers" table.
  All of this is cosmetic; the selected cells are exact, the world never moves, and
  mouse input maps to the true grid. Imprecision-by-fog is a core game-feel experiment.

## Sharing

Export/Share serialize the world *structure* (machines + params + pumps). Sim fluid and
machine internal state (e.g. a buffer's contents) are intentionally not serialized —
import re-runs 400 warm-up ticks (`prewarm`) instead. View config (god mode, the
`Obscura` blur/warp/lake settings) is also deliberately not part of world codes. World codes decode from either
base64 alphabet; links look like `https://blind-factorio.exe.xyz/#world=<code>`.

## Verifying changes

There are no unit tests yet. The workflow that has caught every regression so far:
`npm run build`, then drive the dev server with Playwright (installed in the session
scratchpad, headless Chromium) — place machines, drag pipes, hover things, and read the
inspector panel text and screenshots. See git history for the kinds of end-to-end checks
each feature shipped with.
