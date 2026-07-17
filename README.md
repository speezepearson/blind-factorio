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
  per-port inputs to per-port outputs. Fluids are CSS hex colors; a port's output is split
  evenly among the pumps drawing from it. Machine types: spring (emits its color param),
  reactor (conditional rule with color tolerances), funnel (rate-weighted color blend),
  filter (mirror-split toward/away from a target color; conserves rate × color), buffer
  (stateful: fills to capacity, then drains at a fixed rate).
- The sim ticks synchronously every 110 ms (`TICK_MS`); pump-to-pump flow advances one
  cell per tick, machine outputs are recomputed each tick from the previous tick's pump
  contents. `step()` is a pure function `(world, prevSim, dt) -> nextSim`.

## Module map

| File | Job |
|---|---|
| `src/types.ts` | Core data types: World, Machine, MachineType, ports, params, pumps. |
| `src/geom.ts` | Grid geometry: sides, rotation, machine placement, pump path orientation, pump merging. |
| `src/machines.ts` | The machine-type catalog + color math. **To add a machine type, append one object here** — shape (coarse cells via `scaleCells`), ports, editable params, `compute`, optional `describeState`. Everything else (placement, rendering, editing, serialization) picks it up automatically. |
| `src/sim.ts` | The tick function. Owns per-machine persistent state (`ComputeCtx.state`) for stateful machines. |
| `src/starter.ts` | The pre-built demo factory the app boots into. |
| `src/serialize.ts` | World ↔ URL-safe base64 deflated JSON, for Export/Import/`#world=` links. |
| `src/App.tsx` | The UI shell: tools, mouse handling, undo/redo, world sharing. |
| `src/render.ts` | Canvas rendering of the world + tool overlays. |
| `src/clipboard.ts` | Copy/paste/rotate of world regions. |
| `src/Panel.tsx` | The inspector/help side panel. |

## UI architecture (read before touching App.tsx)

The world is **deliberately not React state**. `worldRef.current` is mutated in place by
tool gestures; a 110 ms interval advances the sim and redraws imperatively — the world and
tool overlays render to an *offscreen* canvas, and a requestAnimationFrame loop composites
that onto the visible canvas (through the time-varying "lake" warp outside god mode);
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
  inspector refuses to identify machines. The copy/erase square is honestly centered on
  the cursor, but its drawn outline is displaced through a world-locked smooth noise
  field ("Warp" amplitude + "Warp scale" sliders, in cells) and Gaussian-blurred ("Tool
  blur" slider) — so the blob wobbles as it moves and its exact position and edges can't
  be pinned down. On top of that, the whole map view is composited through a
  time-evolving warp field, like watching the factory through the surface of a lake —
  a sum of noise layers, each with its own wave direction/speed (drift), magnitude,
  wavelength, and time scale, edited in the collapsible "Lake ripple layers" table. All of this is cosmetic; the affected region
  stays a perfect square, the world never moves, and mouse input maps to the true grid.
  Imprecision-by-fog is a core game-feel experiment.

## Sharing

Export/Share serialize the world *structure* (machines + params + pumps). Sim fluid and
machine internal state (e.g. a buffer's contents) are intentionally not serialized —
import re-runs 400 warm-up ticks (`prewarm`) instead. World codes decode from either
base64 alphabet; links look like `https://blind-factorio.exe.xyz/#world=<code>`.

## Verifying changes

There are no unit tests yet. The workflow that has caught every regression so far:
`npm run build`, then drive the dev server with Playwright (installed in the session
scratchpad, headless Chromium) — place machines, drag pipes, hover things, and read the
inspector panel text and screenshots. See git history for the kinds of end-to-end checks
each feature shipped with.
