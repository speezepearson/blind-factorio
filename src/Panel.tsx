import { SIDE_NAMES, parseKey, pipelinesAt, placeMachine } from './geom';
import { MACHINE_TYPES, TYPE_BY_ID } from './machines';
import { WL_MAX, WL_MIN, wavelengthColor, wavelengthName } from './light';
import type { SimState } from './sim';
import type { Clipboard } from './clipboard';
import type { Tool } from './render';
import type { FluidMap, Machine, MixtureComponent, ParamDef, ParamValue, World } from './types';

export type Hover =
  | { kind: 'machine'; machineId: number }
  | { kind: 'junction'; id: number }
  | { kind: 'pipe'; key: string }
  | null;

function FluidList({ fm }: { fm: FluidMap | undefined }) {
  const entries = Object.entries(fm ?? {}).filter(([, r]) => r > 1e-4).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="dim">—</span>;
  return (
    <>
      {entries.map(([wl, rate]) => (
        <span key={wl} className="fluid">
          <span className="swatch" style={{ background: wavelengthColor(Number(wl)) }} />
          {rate.toFixed(2)} L/s {wl} nm ({wavelengthName(Number(wl))})
        </span>
      ))}
    </>
  );
}

interface PanelProps {
  world: World;
  sim: SimState;
  tool: Tool;
  hover: Hover;
  selectedId: number | null;
  godMode: boolean;
  clipboard: Clipboard | null;
  copySize: number;
  onParamChange: (machine: Machine, pd: ParamDef, value: ParamValue) => void;
  onBudgetChange: (typeId: string | null, value: number) => void; // null = pipe stock
}

// The player's remaining stock of parts. Read-only tally in player mode; in
// god mode, editable — the designer decides what the player gets.
function BudgetBlock({ world, godMode, onBudgetChange }: Pick<PanelProps, 'world' | 'godMode' | 'onBudgetChange'>) {
  const b = world.budget;
  if (!godMode) {
    const parts = MACHINE_TYPES.filter((t) => (b.machines[t.id] ?? 0) > 0);
    return (
      <p className="budget">
        <b>Budget:</b> pipe ×{Math.max(0, Math.floor(b.pipe))}
        {parts.map((t) => (
          <span key={t.id}>
            {' · '}{t.name} ×{b.machines[t.id]}
          </span>
        ))}
      </p>
    );
  }
  const field = (label: string, typeId: string | null, value: number) => (
    <label key={typeId ?? 'pipe'}>
      {label}
      <input
        type="number"
        min={0}
        value={Math.max(0, Math.floor(value))}
        onChange={(e) => onBudgetChange(typeId, e.target.valueAsNumber)}
      />
    </label>
  );
  return (
    <div className="budget">
      <b>Player budget:</b>{' '}
      {field('pipe', null, b.pipe)}
      {MACHINE_TYPES.map((t) => field(t.name, t.id, b.machines[t.id] ?? 0))}
    </div>
  );
}

export function Panel(props: PanelProps) {
  return (
    <>
      <BudgetBlock world={props.world} godMode={props.godMode} onBudgetChange={props.onBudgetChange} />
      <PanelBody {...props} />
    </>
  );
}

function PanelBody({ world, sim, tool, hover, selectedId, godMode, clipboard, copySize, onParamChange }: PanelProps) {
  if (tool.kind === 'edit') {
    const machine = world.machines.find((m) => m.id === selectedId);
    if (!machine) {
      return (
        <>
          <h2>Edit</h2>
          <p className="rule">Click a machine to adjust its parameters.</p>
        </>
      );
    }
    const type = TYPE_BY_ID[machine.typeId];
    const defs = type.params ?? [];
    return (
      <>
        <h2>Edit: {type.name}</h2>
        {defs.length === 0 ? (
          <p className="rule dim">This machine has no adjustable parameters.</p>
        ) : (
          defs.map((pd) => {
            const value = machine.params?.[pd.key] ?? pd.default;
            const set = (v: ParamValue) => onParamChange(machine, pd, v);
            if (pd.kind === 'mixture') {
              const comps = Array.isArray(value) ? value : [];
              const patch = (i: number, c: Partial<MixtureComponent>) =>
                set(comps.map((row, j) => (j === i ? { ...row, ...c } : row)));
              return (
                <div key={pd.key} className="param mixture">
                  {pd.label}:
                  {comps.map((c, i) => (
                    <div key={i} className="mixture-row">
                      <span className="swatch" style={{ background: wavelengthColor(c.wl) }} />
                      <input
                        type="range"
                        min={WL_MIN}
                        max={WL_MAX}
                        step={1}
                        value={c.wl}
                        title="wavelength (nm)"
                        onChange={(e) => patch(i, { wl: Number(e.target.value) })}
                      />
                      <b>{c.wl} nm</b>
                      <input
                        type="number"
                        min={0}
                        max={50}
                        step={0.1}
                        value={c.rate}
                        title="rate (L/s)"
                        onChange={(e) => {
                          const v = e.target.valueAsNumber;
                          if (Number.isFinite(v)) patch(i, { rate: v });
                        }}
                      />
                      L/s
                      <button title="Remove this row" onClick={() => set(comps.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <button onClick={() => set([...comps, { wl: 550, rate: 1 }])}>+ Add wavelength</button>
                </div>
              );
            }
            if (pd.kind === 'choice') {
              return (
                <label key={pd.key} className="param">
                  {pd.label}:{' '}
                  <select value={String(value)} onChange={(e) => set(e.target.value)}>
                    {pd.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            return (
              <label key={pd.key} className="param">
                {pd.label}: <b>{String(value)}</b>
                {pd.kind === 'wavelength' && (
                  <span className="swatch" style={{ background: wavelengthColor(Number(value)) }} />
                )}
                <input
                  type="range"
                  min={pd.min}
                  max={pd.max}
                  step={pd.step}
                  value={Number(value)}
                  onChange={(e) => set(Number(e.target.value))}
                />
              </label>
            );
          })
        )}
      </>
    );
  }
  if (hover?.kind === 'machine') {
    const machine = world.machines.find((m) => m.id === hover.machineId);
    if (!machine) return null;
    if (machine.ghost) {
      return (
        <>
          <h2>{godMode ? `Ghost ${TYPE_BY_ID[machine.typeId].name}` : 'Ghost machine'}</h2>
          <p className="rule dim">
            An unbuilt placeholder — it does nothing until a fabricator making this kind of
            machine supplies the parts.
          </p>
        </>
      );
    }
    if (!godMode) {
      return (
        <>
          <h2>Machine</h2>
          <p className="rule dim">This machine keeps its secrets.</p>
        </>
      );
    }
    const pm = placeMachine(machine, TYPE_BY_ID[machine.typeId]);
    const io = sim.machineIO.get(machine.id);
    return (
      <>
        <h2>{pm.type.name}</h2>
        <p className="rule">{pm.type.ruleText}</p>
        {pm.type.describeState && (
          <p className="rule">
            <b>{pm.type.describeState(sim.machineStates.get(machine.id) ?? {})}</b>
          </p>
        )}
        <table>
          <tbody>
            {pm.ports.map((port) => (
              <tr key={port.def.id}>
                <td>
                  <b>{port.def.label}</b> <span className="dim">({port.def.kind}, {SIDE_NAMES[port.edges[0][1]]})</span>
                </td>
                <td>
                  <FluidList fm={port.def.kind === 'in' ? io?.inputs[port.def.id] : io?.outputs[port.def.id]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  if (hover?.kind === 'junction') {
    if (!godMode) {
      return (
        <>
          <h2>Junction</h2>
          <p className="rule dim">This junction keeps its secrets.</p>
        </>
      );
    }
    const junction = world.junctions.find((j) => j.id === hover.id);
    if (!junction) return null;
    const [jx, jy] = junction.cell;
    const inflows = world.pipelines.filter(
      (pl) =>
        !pl.ghost && pl.cells.length > 1 &&
        pl.cells[pl.cells.length - 1][0] === jx && pl.cells[pl.cells.length - 1][1] === jy,
    ).length;
    const outflows = world.pipelines.filter(
      (pl) => !pl.ghost && pl.cells[0][0] === jx && pl.cells[0][1] === jy,
    ).length;
    return (
      <>
        <h2>Junction</h2>
        <p className="rule">
          Sums {inflows} inflow{inflows === 1 ? '' : 's'}, splits evenly into {outflows} outflow{outflows === 1 ? '' : 's'}. Passing through:
        </p>
        <p><FluidList fm={sim.junctionFlows.get(hover.id)} /></p>
      </>
    );
  }
  if (hover?.kind === 'pipe') {
    const cell = parseKey(hover.key);
    const pls = pipelinesAt(world.pipelines, cell);
    if (pls.length === 0) return null;
    // the player sees that there's a pipe, but not what's in it or which way
    // it flows — they have to read the light. Ghosts are honestly ghosts.
    if (!godMode) {
      const allGhost = pls.every((pl) => pl.ghost);
      return (
        <>
          <h2>{allGhost ? 'Ghost pipe' : 'Pipe'}</h2>
          <p className="rule dim">
            {allGhost
              ? 'An unbuilt route — a fabricator making pipe will build it in, cell by cell.'
              : 'This pipe keeps its secrets.'}
          </p>
        </>
      );
    }
    return (
      <>
        <h2>{pls.length > 1 ? 'Crossing pipelines' : 'Pipeline'}</h2>
        {pls.map((pl) => {
          const idx = pl.cells.findIndex(([x, y]) => x === cell[0] && y === cell[1]);
          if (pl.ghost) {
            return (
              <div key={pl.id}>
                <p className="rule">
                  Pipeline #{pl.id} (ghost): {pl.cells.length} unbuilt cells.
                </p>
              </div>
            );
          }
          return (
            <div key={pl.id}>
              <p className="rule">
                Pipeline #{pl.id}: {pl.cells.length} cells, {idx} in from its intake. Carrying here:
              </p>
              <p><FluidList fm={sim.pipeFluids.get(pl.id)?.[idx]} /></p>
            </div>
          );
        })}
      </>
    );
  }
  if (tool.kind === 'copy') {
    return (
      <>
        <h2>Copy / paste</h2>
        {clipboard ? (
          <ul className="help">
            <li>
              Clipboard holds <b>{clipboard.machines.length}</b> machine{clipboard.machines.length === 1 ? '' : 's'} and{' '}
              <b>{clipboard.pipelines.length}</b> pipe{clipboard.pipelines.length === 1 ? '' : 's'}.
            </li>
            <li>Click to paste (as often as you like). Press <b>R</b> to rotate the clipboard.</li>
            <li>Machines and pipes that don't fit are skipped.</li>
            <li>Anything beyond your budget lands as a <b>ghost</b> — a fabricator can build it in later.</li>
            <li>Press <b>Esc</b> to empty the clipboard and copy something else.</li>
          </ul>
        ) : (
          <ul className="help">
            <li>Drag a lasso around whatever you want to copy, or click to copy the {copySize}×{copySize}-cell square centered on the cursor.</li>
            <li>Any machine overlapping the selection — even partially — is copied whole.</li>
            <li>Use the slider to change the click-square size.</li>
          </ul>
        )}
      </>
    );
  }
  return (
    <>
      <h2>Sandbox</h2>
      <ul className="help">
        <li><b>Pipes:</b> click-drag to lay a pipeline from one machine to another — you can start the drag on a machine. Drag backwards to undo. Pipes can cross freely without connecting. Start a drag on a pipe's loose end to keep extending it.</li>
        <li><b>Budget:</b> building spends your stock of pipe and machines; erasing refunds it. What you can't afford appears as a dashed ghost — feed a <b>fabricator</b> red light and it builds ghosts in for real.</li>
        <li><b>Merging:</b> release a pipe drag <i>on</i> an existing pipe to splice in a junction — the flows sum downstream. Start a drag on a junction to tap it. Erasing any segment removes that whole stretch of pipe, junction to junction.</li>
        <li><b>Copy/paste:</b> lasso (or click a square around) a patch of factory to stamp out elsewhere, machines included.</li>
        <li><b>Erase:</b> lasso (or click a square around) a region to wipe — pipes touching it and machines overlapping it even partially are removed whole.</li>
        <li>Hover anything to inspect its rule and live flows here.</li>
        <li>Blue edges are input ports, orange edges are output ports.</li>
        {godMode && (
          <li>
            <b>God mode:</b> click a machine button to place one (<b>R</b> rotates), or use{' '}
            <b>Edit</b> to tune a machine's parameters or drag it somewhere else.
          </li>
        )}
      </ul>
    </>
  );
}
