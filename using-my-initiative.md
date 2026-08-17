# Using my initiative

Places where I deliberately deviated from (or tuned beyond) the letter of a request,
and why. Newest at the bottom.

## Theming pass (flesh cavity, 2026-08-17)

- **"Fluid stops flowing through that point" during organ budding → I made upstream
  *stall*, not vent.** Destroying in-flight fluid would quietly break mass-balance
  reasoning, which the design doc holds up as the one inference tool the player can
  always trust ("radical counts are conserved... mass-balance experiments are always
  valid"). So a growing organ, and likewise the not-yet-incarnate stretch of a ghost
  vein, block like a clamped artery: the column behind them backs up and waits.
  Downstream still empties exactly as you described. Same rule everywhere fluid could
  have been lost — nothing ever silently vanishes.
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
