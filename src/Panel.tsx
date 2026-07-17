import { SIDE_NAMES, parseKey, placeMachine } from './geom';
import { FLUID_NAMES, TYPE_BY_ID } from './machines';
import { pumpKey } from './sim';
import type { SimState } from './sim';
import type { Clipboard } from './clipboard';
import type { Tool } from './render';
import type { FluidMap, Machine, ParamDef, ParamValue, World } from './types';

export type Hover = { kind: 'machine'; machineId: number } | { kind: 'pump'; key: string } | null;

const fluidName = (color: string) => FLUID_NAMES[color] ?? color;

function FluidList({ fm }: { fm: FluidMap | undefined }) {
  const entries = Object.entries(fm ?? {}).filter(([, r]) => r > 1e-4).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="dim">—</span>;
  return (
    <>
      {entries.map(([color, rate]) => (
        <span key={color} className="fluid">
          <span className="swatch" style={{ background: color }} />
          {rate.toFixed(2)} L/s {fluidName(color)}
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
}

export function Panel({ world, sim, tool, hover, selectedId, godMode, clipboard, copySize, onParamChange }: PanelProps) {
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
            return (
              <label key={pd.key} className="param">
                {pd.label}: <b>{String(value)}</b>
                {pd.kind === 'color' ? (
                  <input
                    type="color"
                    value={String(value)}
                    onChange={(e) => set(e.target.value)}
                  />
                ) : (
                  <input
                    type="range"
                    min={pd.min}
                    max={pd.max}
                    step={pd.step}
                    value={Number(value)}
                    onChange={(e) => set(Number(e.target.value))}
                  />
                )}
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
  if (hover?.kind === 'pump') {
    const list = world.pumps.get(hover.key);
    if (!list || list.length === 0) return null;
    const [x, y] = parseKey(hover.key);
    return (
      <>
        <h2>{list.length > 1 ? 'Crossing pumps' : 'Pump'}</h2>
        {list.map((pump) => {
          const f = sim.pumpFluids.get(pumpKey(x, y, pump));
          return (
            <div key={`${pump.inSide}${pump.outSide}`}>
              <p className="rule">
                Pulls from its {SIDE_NAMES[pump.inSide]} side, pushes out its {SIDE_NAMES[pump.outSide]} side.
              </p>
              <p>{f ? <FluidList fm={{ [f.color]: f.rate }} /> : <span className="dim">empty</span>}</p>
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
              <b>{clipboard.pumps.length}</b> pump{clipboard.pumps.length === 1 ? '' : 's'}.
            </li>
            <li>Click to paste (as often as you like). Press <b>R</b> to rotate the clipboard.</li>
            <li>Machines that don't fit are skipped; pumps overwrite pumps but never machines.</li>
            <li>Press <b>Esc</b> to empty the clipboard and copy something else.</li>
          </ul>
        ) : (
          <ul className="help">
            <li>Click to copy the {copySize}×{copySize}-cell square centered on the cursor.</li>
            <li>Any machine overlapping the square — even partially — is copied whole.</li>
            <li>Use the slider to change the square size.</li>
          </ul>
        )}
      </>
    );
  }
  return (
    <>
      <h2>Sandbox</h2>
      <ul className="help">
        <li><b>Pipes:</b> click-drag to draw a line of pumps — you can start the drag on a machine. Drag backwards to undo.</li>
        <li><b>Copy/paste:</b> stamp out squares of factory, machines included.</li>
        <li><b>Erase:</b> click/drag to wipe the highlighted region — pumps inside it are removed, and machines overlapping it even partially are removed whole.</li>
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
