import { useEffect, useRef, useState } from 'react';
import {
  DX, DY, SIDE_NAMES, cellKey, dirFromTo, opposite, parseKey, placeMachine,
} from './geom';
import type { PlacedMachine } from './geom';
import { FLUID_NAMES, MACHINE_TYPES, TYPE_BY_ID, totalRate } from './machines';
import { emptySim, placeAll, step } from './sim';
import type { SimState } from './sim';
import type { Cell, FluidMap, Machine, Side, World } from './types';
import './App.css';

const GRID_W = 34;
const GRID_H = 22;
const CELL = 30;
const TICK_MS = 110;

type Tool = { kind: 'pump' } | { kind: 'erase' } | { kind: 'machine'; typeId: string };

type Hover = { kind: 'machine'; machineId: number } | { kind: 'pump'; key: string } | null;

function makeWorld(): World {
  return { w: GRID_W, h: GRID_H, pumps: new Map(), machines: [], nextMachineId: 1 };
}

function machineCellMap(placed: PlacedMachine[]): Map<string, PlacedMachine> {
  const map = new Map<string, PlacedMachine>();
  for (const pm of placed) for (const [x, y] of pm.cells) map.set(cellKey(x, y), pm);
  return map;
}

// Given the cells a drag passed through, orient a pump in each cell so fluid
// flows along the path.
function orientPath(path: Cell[]): Array<{ cell: Cell; inSide: Side; outSide: Side }> {
  return path.map((cell, i) => {
    const prev = path[i - 1];
    const next = path[i + 1];
    let inSide: Side = 3;
    let outSide: Side = 1;
    if (prev) inSide = dirFromTo(cell, prev);
    if (next) outSide = dirFromTo(cell, next);
    if (!prev && next) inSide = opposite(outSide);
    if (prev && !next) outSide = opposite(inSide);
    if (inSide === outSide) outSide = opposite(inSide);
    return { cell, inSide, outSide };
  });
}

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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(makeWorld());
  const simRef = useRef<SimState>(emptySim());

  const [tool, setTool] = useState<Tool>({ kind: 'pump' });
  const [rotation, setRotation] = useState(0);
  const [hover, setHover] = useState<Hover>(null);
  const [, setTick] = useState(0); // re-render so the info panel shows live flows

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const hoverCellRef = useRef<Cell | null>(null);
  const dragRef = useRef<{ mode: 'pump'; path: Cell[] } | { mode: 'erase' } | null>(null);

  const eventCell = (e: { clientX: number; clientY: number }): Cell | null => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const rect = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID_W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID_H);
    if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return null;
    return [x, y];
  };

  const updateHover = (cell: Cell | null) => {
    hoverCellRef.current = cell;
    let next: Hover = null;
    if (cell) {
      const k = cellKey(cell[0], cell[1]);
      const pm = machineCellMap(placeAll(worldRef.current)).get(k);
      if (pm) next = { kind: 'machine', machineId: pm.machine.id };
      else if (worldRef.current.pumps.has(k)) next = { kind: 'pump', key: k };
    }
    setHover((h) =>
      h?.kind === next?.kind &&
      (h?.kind === 'machine'
        ? (h as { machineId: number }).machineId === (next as { machineId: number }).machineId
        : h?.kind === 'pump'
          ? (h as { key: string }).key === (next as { key: string }).key
          : true)
        ? h
        : next,
    );
  };

  const machinePlacementOk = (placed: PlacedMachine): boolean => {
    const world = worldRef.current;
    const occupied = machineCellMap(placeAll(world));
    return placed.cells.every(
      ([x, y]) =>
        x >= 0 && y >= 0 && x < world.w && y < world.h &&
        !occupied.has(cellKey(x, y)) && !world.pumps.has(cellKey(x, y)),
    );
  };

  const eraseAt = (cell: Cell) => {
    const world = worldRef.current;
    const k = cellKey(cell[0], cell[1]);
    if (world.pumps.delete(k)) return;
    const pm = machineCellMap(placeAll(world)).get(k);
    if (pm) world.machines = world.machines.filter((m) => m.id !== pm.machine.id);
  };

  const commitPumpPath = (path: Cell[]) => {
    const world = worldRef.current;
    const occupied = machineCellMap(placeAll(world));
    for (const { cell, inSide, outSide } of orientPath(path)) {
      const k = cellKey(cell[0], cell[1]);
      if (!occupied.has(k)) world.pumps.set(k, { inSide, outSide });
    }
  };

  const extendPath = (path: Cell[], target: Cell, blocked: (c: Cell) => boolean) => {
    let [lx, ly] = path[path.length - 1];
    while (lx !== target[0] || ly !== target[1]) {
      if (lx !== target[0]) lx += Math.sign(target[0] - lx);
      else ly += Math.sign(target[1] - ly);
      if (blocked([lx, ly])) return;
      const back = path[path.length - 2];
      if (back && back[0] === lx && back[1] === ly) {
        path.pop(); // dragging backwards undoes the last cell
        continue;
      }
      if (path.some(([px, py]) => px === lx && py === ly)) return; // no self-crossing
      path.push([lx, ly]);
    }
  };

  // ---- drawing ----------------------------------------------------------

  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const world = worldRef.current;
    const sim = simRef.current;
    const placed = placeAll(world);
    const occupied = machineCellMap(placed);

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#e7e4dc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= GRID_W; x++) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, GRID_H * CELL);
    }
    for (let y = 0; y <= GRID_H; y++) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(GRID_W * CELL, y * CELL + 0.5);
    }
    ctx.stroke();

    const edgeMid = (x: number, y: number, s: Side): [number, number] => [
      x * CELL + CELL / 2 + (DX[s] * CELL) / 2,
      y * CELL + CELL / 2 + (DY[s] * CELL) / 2,
    ];

    const drawPump = (x: number, y: number, inSide: Side, outSide: Side, fluidColor: string | null, rate: number, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#edeef0';
      ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      const color = fluidColor ?? '#b3b8c0';
      const [ix, iy] = edgeMid(x, y, inSide);
      const [ox, oy] = edgeMid(x, y, outSide);
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = fluidColor ? Math.min(9, 3 + 2.2 * Math.log2(1 + rate)) : 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(ox, oy);
      ctx.stroke();
      // arrowhead at the output edge
      const adx = DX[outSide];
      const ady = DY[outSide];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox - adx * 8 - ady * 5, oy - ady * 8 + adx * 5);
      ctx.lineTo(ox - adx * 8 + ady * 5, oy - ady * 8 - adx * 5);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    for (const [k, pump] of world.pumps) {
      const [x, y] = parseKey(k);
      const f = sim.pumpFluids.get(k) ?? null;
      drawPump(x, y, pump.inSide, pump.outSide, f?.color ?? null, f?.rate ?? 0);
    }

    const drawMachine = (pm: PlacedMachine, alpha = 1, invalid = false) => {
      ctx.globalAlpha = alpha;
      const cellSet = new Set(pm.cells.map(([x, y]) => cellKey(x, y)));
      ctx.fillStyle = invalid ? '#e8a0a0' : pm.type.bodyColor;
      for (const [x, y] of pm.cells) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      // outline the perimeter
      ctx.strokeStyle = '#4a4640';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [x, y] of pm.cells) {
        for (let s = 0 as Side; s < 4; s = (s + 1) as Side) {
          if (cellSet.has(cellKey(x + DX[s], y + DY[s]))) continue;
          const x0 = x * CELL + (s === 1 ? CELL : 0);
          const y0 = y * CELL + (s === 2 ? CELL : 0);
          const x1 = x * CELL + (s === 3 ? 0 : CELL);
          const y1 = y * CELL + (s === 0 ? 0 : CELL);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
      }
      ctx.stroke();

      // ports: thick strokes just inside the edge, labeled
      const io = sim.machineIO.get(pm.machine.id);
      for (const port of pm.ports) {
        ctx.strokeStyle = port.def.kind === 'in' ? '#2f7fd1' : '#e08a1e';
        ctx.lineWidth = 5;
        for (const [[x, y], s] of port.edges) {
          const inset = 3;
          ctx.beginPath();
          if (s === 0) { ctx.moveTo(x * CELL + 3, y * CELL + inset); ctx.lineTo(x * CELL + CELL - 3, y * CELL + inset); }
          if (s === 2) { ctx.moveTo(x * CELL + 3, y * CELL + CELL - inset); ctx.lineTo(x * CELL + CELL - 3, y * CELL + CELL - inset); }
          if (s === 3) { ctx.moveTo(x * CELL + inset, y * CELL + 3); ctx.lineTo(x * CELL + inset, y * CELL + CELL - 3); }
          if (s === 1) { ctx.moveTo(x * CELL + CELL - inset, y * CELL + 3); ctx.lineTo(x * CELL + CELL - inset, y * CELL + CELL - 3); }
          ctx.stroke();
        }
        // label near the middle edge of the port
        const [[lx, ly], ls] = port.edges[Math.floor((port.edges.length - 1) / 2)];
        const [ex, ey] = edgeMid(lx, ly, ls);
        ctx.fillStyle = '#333';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(port.def.label, ex - DX[ls] * 10, ey - DY[ls] * 10);

        // live output rate floating just outside output ports
        if (port.def.kind === 'out' && io) {
          const rate = totalRate(io.outputs[port.def.id]);
          if (rate > 1e-4) {
            const colors = Object.keys(io.outputs[port.def.id] ?? {});
            ctx.fillStyle = colors[0] ?? '#333';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(rate.toFixed(2), ex + DX[ls] * 14, ey + DY[ls] * 14);
          }
        }
      }

      // machine name at footprint center
      const cxs = pm.cells.map(([x]) => x * CELL + CELL / 2);
      const cys = pm.cells.map(([, y]) => y * CELL + CELL / 2);
      ctx.fillStyle = '#2b2823';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        pm.type.name,
        cxs.reduce((a, b) => a + b, 0) / cxs.length,
        cys.reduce((a, b) => a + b, 0) / cys.length,
      );
      ctx.globalAlpha = 1;
    };

    for (const pm of placed) drawMachine(pm);

    // drag preview: pump line
    const drag = dragRef.current;
    if (drag?.mode === 'pump') {
      for (const { cell, inSide, outSide } of orientPath(drag.path)) {
        if (!occupied.has(cellKey(cell[0], cell[1]))) drawPump(cell[0], cell[1], inSide, outSide, null, 0, 0.55);
      }
    }

    // machine ghost preview
    const t = toolRef.current;
    const hc = hoverCellRef.current;
    if (t.kind === 'machine' && hc && !drag) {
      const ghost = placeMachine(
        { id: -1, typeId: t.typeId, origin: hc, rotation: rotationRef.current },
        TYPE_BY_ID[t.typeId],
      );
      drawMachine(ghost, 0.5, !machinePlacementOk(ghost));
    }

    // hover highlight
    if (hc) {
      ctx.strokeStyle = 'rgba(60,60,60,0.5)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hc[0] * CELL + 1, hc[1] * CELL + 1, CELL - 2, CELL - 2);
    }
  };

  // ---- lifecycle ---------------------------------------------------------

  useEffect(() => {
    const iv = setInterval(() => {
      simRef.current = step(worldRef.current, simRef.current);
      setTick((t) => t + 1);
      draw();
    }, TICK_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') setRotation((r) => (r + 1) % 4);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- mouse handlers ----------------------------------------------------

  const onMouseDown = (e: React.MouseEvent) => {
    const cell = eventCell(e);
    if (!cell) return;
    const t = toolRef.current;
    const world = worldRef.current;
    const occupied = machineCellMap(placeAll(world));
    if (t.kind === 'pump') {
      if (!occupied.has(cellKey(cell[0], cell[1]))) dragRef.current = { mode: 'pump', path: [cell] };
    } else if (t.kind === 'erase') {
      dragRef.current = { mode: 'erase' };
      eraseAt(cell);
    } else {
      const machine: Machine = { id: world.nextMachineId, typeId: t.typeId, origin: cell, rotation: rotationRef.current };
      const pm = placeMachine(machine, TYPE_BY_ID[t.typeId]);
      if (machinePlacementOk(pm)) {
        world.machines.push(machine);
        world.nextMachineId++;
      }
    }
    draw();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const cell = eventCell(e);
    updateHover(cell);
    const drag = dragRef.current;
    if (cell && drag?.mode === 'pump') {
      const occupied = machineCellMap(placeAll(worldRef.current));
      extendPath(drag.path, cell, ([x, y]) =>
        x < 0 || y < 0 || x >= GRID_W || y >= GRID_H || occupied.has(cellKey(x, y)),
      );
    } else if (cell && drag?.mode === 'erase') {
      eraseAt(cell);
    }
    draw();
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (drag?.mode === 'pump') commitPumpPath(drag.path);
    dragRef.current = null;
    draw();
  };

  // ---- info panel --------------------------------------------------------

  const renderPanel = () => {
    const world = worldRef.current;
    const sim = simRef.current;
    if (hover?.kind === 'machine') {
      const machine = world.machines.find((m) => m.id === hover.machineId);
      if (!machine) return null;
      const pm = placeMachine(machine, TYPE_BY_ID[machine.typeId]);
      const io = sim.machineIO.get(machine.id);
      return (
        <>
          <h2>{pm.type.name}</h2>
          <p className="rule">{pm.type.ruleText}</p>
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
      const pump = world.pumps.get(hover.key);
      if (!pump) return null;
      const f = sim.pumpFluids.get(hover.key);
      return (
        <>
          <h2>Pump</h2>
          <p className="rule">
            Pulls from its {SIDE_NAMES[pump.inSide]} side, pushes out its {SIDE_NAMES[pump.outSide]} side.
          </p>
          <p>{f ? <FluidList fm={{ [f.color]: f.rate }} /> : <span className="dim">empty</span>}</p>
        </>
      );
    }
    return (
      <>
        <h2>Sandbox</h2>
        <ul className="help">
          <li><b>Pump tool:</b> click-drag to draw a line of pumps. Fluid flows along the drag direction.</li>
          <li><b>Machine tools:</b> click to place. Press <b>R</b> to rotate before placing.</li>
          <li><b>Erase:</b> click/drag to remove pumps; click a machine to remove it.</li>
          <li>Hover anything to inspect its rule and live flows here.</li>
          <li>Blue edges are input ports, orange edges are output ports.</li>
        </ul>
      </>
    );
  };

  return (
    <div className="app">
      <div className="toolbar">
        <button className={tool.kind === 'pump' ? 'active' : ''} onClick={() => setTool({ kind: 'pump' })}>
          Pump
        </button>
        {MACHINE_TYPES.map((mt) => (
          <button
            key={mt.id}
            className={tool.kind === 'machine' && tool.typeId === mt.id ? 'active' : ''}
            style={{ borderBottomColor: mt.bodyColor }}
            onClick={() => setTool({ kind: 'machine', typeId: mt.id })}
          >
            {mt.name}
          </button>
        ))}
        <button className={tool.kind === 'erase' ? 'active' : ''} onClick={() => setTool({ kind: 'erase' })}>
          Erase
        </button>
        <span className="spacer" />
        <button onClick={() => setRotation((r) => (r + 1) % 4)}>Rotate (R): {rotation * 90}°</button>
        <button
          onClick={() => {
            worldRef.current = makeWorld();
            simRef.current = emptySim();
            draw();
          }}
        >
          Clear all
        </button>
      </div>
      <div className="main">
        <canvas
          ref={canvasRef}
          width={GRID_W * CELL}
          height={GRID_H * CELL}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={() => {
            endDrag();
            updateHover(null);
          }}
        />
        <div className="panel">{renderPanel()}</div>
      </div>
    </div>
  );
}
