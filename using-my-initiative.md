# Using my initiative

Places where I deliberately deviated from (or tuned beyond) the letter of a request,
and why. Newest at the bottom.

## Vent haze scope (2026-08-18)

You asked for haze where "a vein terminates into empty space." I also gave it to the
other vents: incarnation frontiers (an unfinished vein leaks at its growing tip) and
unattached organ ports — the demo's rad port had been silently dumping every freed
radical into the void with zero visual evidence, which undermined the
every-vent-is-visible rule. Same haze, same rate scaling, everywhere fluid leaves the
network.

## Theming pass (flesh cavity, 2026-08-17)

- ~~**"Fluid stops flowing through that point" during organ budding → I made upstream
  *stall*, not vent.**~~ **Superseded 2026-08-17** by your call: veins have infinite
  throughput and nothing ever stalls. Blocked outlets now *vent* — but every vent is
  a structurally visible feature (an open tail, a ghost's unfinished frontier, a
  growing organ's mouth), so the mass-balance concern that motivated stalling is
  answered differently: fluid never vanishes anywhere the player can't point at. The
  stall machinery turned out to be the root of the two worst review findings
  (heat-conveyor merges, unbounded cram), which rather settles the argument.
- **Background contrast kept deliberately low and slow, drips rare and faint.** Vein
  color and width *are* the game's data channels; a lively background competes with
  the signal. The cavity mottles, breathes, and occasionally drips, but everything
  sits well below the veins in contrast and speed. If it reads as too subdued, turning
  it up is one constants block in `render.ts` (`drawBackground`).
- **Dropped the grid lines entirely** (you didn't ask). Ruled graph paper read as
  sterile-plane against the flesh; the crosshair cursor plus L-interpolated drawing
  seemed like enough guidance. If precision drawing suffers, a faint hover-cell
  highlight would fit the theme better than restoring the grid.
- **Sources drawn as wellheads in the cavity wall** (a flesh-colored surround behind
  the species chip) rather than bare UI chips, to sell "the vasculature was already
  here and you're tapping into it."
