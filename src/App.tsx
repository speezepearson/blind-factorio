import { useEffect, useRef, useState } from 'react';
import {
  DX, DY, SIDE_NAMES, cellKey, mergePumps, orientPath, parseKey, placeMachine, rotateSide,
} from './geom';
import type { PlacedMachine } from './geom';
import { FLUID_NAMES, TYPE_BY_ID, paleTint, totalRate } from './machines';
import { emptySim, placeAll, pumpKey, step } from './sim';
import type { SimState } from './sim';
import { buildStarterWorld } from './starter';
import type { Cell, FluidMap, Machine, ParamValue, Pump, Side, World } from './types';
import './App.css';

const GRID_W = 170;
const GRID_H = 110;
const CELL = 6;
const TICK_MS = 110;

type Tool = { kind: 'pipe' } | { kind: 'copy' } | { kind: 'erase' } | { kind: 'edit' };

type Hover = { kind: 'machine'; machineId: number } | { kind: 'pump'; key: string } | null;

interface Clipboard {
  size: number;
  machines: Array<{ typeId: string; rotation: number; rel: Cell; params?: Record<string, ParamValue> }>;
  pumps: Array<{ rel: Cell; pump: Pump }>;
  // visual snapshot of the supercell square highlighted at copy time (which is
  // not exactly the copied fine-grid region) — shown as the paste ghost
  snapshot?: HTMLCanvasElement;
}

function rotateCanvas90(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.height;
  out.height = src.width;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return out;
}

// Rotate the whole clipboard square a quarter-turn clockwise: cell (x,y) maps
// to (n-1-y, x), pump sides advance one step, machine rotations advance one
// step (with their bounding-box origin remapped accordingly).
function rotateClipboard(clip: Clipboard): Clipboard {
  const n = clip.size;
  return {
    size: n,
    machines: clip.machines.map((m) => {
      const pm = placeMachine(
        { id: -1, typeId: m.typeId, origin: [0, 0], rotation: m.rotation },
        TYPE_BY_ID[m.typeId],
      );
      const h = Math.max(...pm.cells.map((c) => c[1])) + 1;
      return { ...m, rotation: (m.rotation + 1) % 4, rel: [n - h - m.rel[1], m.rel[0]] as Cell };
    }),
    pumps: clip.pumps.map((p) => ({
      rel: [n - 1 - p.rel[1], p.rel[0]] as Cell,
      pump: { inSide: rotateSide(p.pump.inSide, 1), outSide: rotateSide(p.pump.outSide, 1) },
    })),
    snapshot: clip.snapshot ? rotateCanvas90(clip.snapshot) : undefined,
  };
}

function freshWorld(): { world: World; sim: SimState } {
  const world = buildStarterWorld(GRID_W, GRID_H);
  let sim = emptySim();
  for (let i = 0; i < 400; i++) sim = step(world, sim); // pre-warm so it starts flowing
  return { world, sim };
}

function machineCellMap(placed: PlacedMachine[]): Map<string, PlacedMachine> {
  const map = new Map<string, PlacedMachine>();
  for (const pm of placed) for (const [x, y] of pm.cells) map.set(cellKey(x, y), pm);
  return map;
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
  const [initial] = useState(freshWorld);
  const worldRef = useRef<World>(initial.world);
  const simRef = useRef<SimState>(initial.sim);

  const [tool, setTool] = useState<Tool>({ kind: 'pipe' });
  const [superSize, setSuperSize] = useState(6); // visual supercell size, in fine cells
  const [copySuper, setCopySuper] = useState(3); // copy square side, in supercells (odd)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [hideLabels, setHideLabels] = useState(false);
  const [blurPx, setBlurPx] = useState(2); // Gaussian blur strength while labels are hidden
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [, setTick] = useState(0); // re-render so the info panel shows live flows

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const superSizeRef = useRef(superSize);
  superSizeRef.current = superSize;
  const copySuperRef = useRef(copySuper);
  copySuperRef.current = copySuper;
  // the real copy region side in fine cells
  const copyCells = () => copySuperRef.current * superSizeRef.current;
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  const hideLabelsRef = useRef(hideLabels);
  hideLabelsRef.current = hideLabels;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const hoverCellRef = useRef<Cell | null>(null);
  const dragRef = useRef<{ mode: 'pipe'; path: Cell[] } | { mode: 'erase'; last: Cell } | null>(null);

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

  // Wipe the copy-sized square anchored on the cursor's fine cell: pumps
  // inside it go, and machines overlapping it even partially go whole.
  const eraseRegion = (anchor: Cell) => {
    const n = copyCells();
    const tl = squareTL(anchor, n);
    const world = worldRef.current;
    const inSquare = ([x, y]: Cell) =>
      x >= tl[0] && x < tl[0] + n && y >= tl[1] && y < tl[1] + n;
    for (const k of [...world.pumps.keys()]) {
      if (inSquare(parseKey(k))) world.pumps.delete(k);
    }
    const doomed = new Set(
      placeAll(world).filter((pm) => pm.cells.some(inSquare)).map((pm) => pm.machine.id),
    );
    if (doomed.size > 0) world.machines = world.machines.filter((m) => !doomed.has(m.id));
  };

  const commitPipePath = (path: Cell[]) => {
    const world = worldRef.current;
    const occupied = machineCellMap(placeAll(world));
    for (const { cell, inSide, outSide } of orientPath(path)) {
      const k = cellKey(cell[0], cell[1]);
      if (!occupied.has(k)) world.pumps.set(k, mergePumps(world.pumps.get(k), { inSide, outSide }));
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

  // ---- copy/paste --------------------------------------------------------

  // top-left of the size-n square centered (roughly) on the cursor
  const squareTL = (cell: Cell, n: number): Cell => [cell[0] - Math.floor(n / 2), cell[1] - Math.floor(n / 2)];

  const captureRegion = (tl: Cell): Clipboard => {
    const n = copyCells();
    const world = worldRef.current;
    const inSquare = ([x, y]: Cell) =>
      x >= tl[0] && x < tl[0] + n && y >= tl[1] && y < tl[1] + n;
    const machines = placeAll(world)
      .filter((pm) => pm.cells.some(inSquare))
      .map((pm) => ({
        typeId: pm.machine.typeId,
        rotation: pm.machine.rotation,
        rel: [pm.machine.origin[0] - tl[0], pm.machine.origin[1] - tl[1]] as Cell,
        params: pm.machine.params ? { ...pm.machine.params } : undefined,
      }));
    const pumps: Clipboard['pumps'] = [];
    for (const [k, list] of world.pumps) {
      const [x, y] = parseKey(k);
      if (inSquare([x, y])) {
        for (const pump of list) pumps.push({ rel: [x - tl[0], y - tl[1]], pump: { ...pump } });
      }
    }
    return { size: n, machines, pumps };
  };

  // Photograph the supercell square highlighted around the given cell, with
  // the hover overlay suppressed, for use as the paste ghost.
  const snapshotSupercells = (cell: Cell): HTMLCanvasElement | undefined => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const S = superSizeRef.current;
    const nSuper = Math.max(1, Math.round(copyCells() / S));
    const tlx = Math.floor(cell[0] / S) - Math.floor(nSuper / 2);
    const tly = Math.floor(cell[1] / S) - Math.floor(nSuper / 2);
    const px = nSuper * S * CELL;
    const prevHover = hoverCellRef.current;
    hoverCellRef.current = null;
    draw();
    const snap = document.createElement('canvas');
    snap.width = px;
    snap.height = px;
    snap.getContext('2d')!.drawImage(cv, tlx * S * CELL, tly * S * CELL, px, px, 0, 0, px, px);
    hoverCellRef.current = prevHover;
    draw();
    return snap;
  };

  // Stamp the clipboard down: machines that would collide are skipped;
  // pumps overwrite pumps but never machines.
  const pasteClipboard = (tl: Cell, clip: Clipboard) => {
    const world = worldRef.current;
    for (const m of clip.machines) {
      const machine: Machine = {
        id: world.nextMachineId,
        typeId: m.typeId,
        origin: [tl[0] + m.rel[0], tl[1] + m.rel[1]],
        rotation: m.rotation,
        params: m.params ? { ...m.params } : undefined,
      };
      if (machinePlacementOk(placeMachine(machine, TYPE_BY_ID[m.typeId]))) {
        world.machines.push(machine);
        world.nextMachineId++;
      }
    }
    const occupied = machineCellMap(placeAll(world));
    for (const p of clip.pumps) {
      const x = tl[0] + p.rel[0];
      const y = tl[1] + p.rel[1];
      if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
      const k = cellKey(x, y);
      if (!occupied.has(k)) world.pumps.set(k, mergePumps(world.pumps.get(k), { ...p.pump }));
    }
  };

  // ---- drawing -----------------------------------------------------------

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
    // only supercell boundaries are drawn; the fine grid stays invisible
    const S = superSizeRef.current;
    ctx.strokeStyle = '#e0dcd2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= GRID_W; x += S) {
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, GRID_H * CELL);
    }
    for (let y = 0; y <= GRID_H; y += S) {
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(GRID_W * CELL, y * CELL + 0.5);
    }
    ctx.stroke();

    const edgeMid = (x: number, y: number, s: Side): [number, number] => [
      x * CELL + CELL / 2 + (DX[s] * CELL) / 2,
      y * CELL + CELL / 2 + (DY[s] * CELL) / 2,
    ];

    const drawPumpBase = (x: number, y: number, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e7e9ec';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.globalAlpha = 1;
    };

    const drawPumpArrow = (x: number, y: number, inSide: Side, outSide: Side, fluidColor: string | null, rate: number, alpha = 1) => {
      ctx.globalAlpha = alpha;
      const color = fluidColor ?? '#b3b8c0';
      const [ix, iy] = edgeMid(x, y, inSide);
      const [ox, oy] = edgeMid(x, y, outSide);
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = fluidColor ? Math.min(4, 1.5 + 0.7 * Math.log2(1 + rate)) : 1.5;
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
      ctx.lineTo(ox - adx * 3 - ady * 2, oy - ady * 3 + adx * 2);
      ctx.lineTo(ox - adx * 3 + ady * 2, oy - ady * 3 - adx * 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    for (const [k, list] of world.pumps) {
      const [x, y] = parseKey(k);
      drawPumpBase(x, y);
      for (const pump of list) {
        const f = sim.pumpFluids.get(pumpKey(x, y, pump)) ?? null;
        drawPumpArrow(x, y, pump.inSide, pump.outSide, f?.color ?? null, f?.rate ?? 0);
      }
    }

    const drawMachine = (pm: PlacedMachine, alpha = 1, invalid = false) => {
      const hidden = hideLabelsRef.current;
      ctx.globalAlpha = alpha;
      const cellSet = new Set(pm.cells.map(([x, y]) => cellKey(x, y)));
      // a machine with a color param wears a pale tint of its configured color
      const colorDef = pm.type.params?.find((pd) => pd.kind === 'color');
      const paramColor = colorDef ? pm.machine.params?.[colorDef.key] ?? colorDef.default : null;
      const body = typeof paramColor === 'string' ? paleTint(paramColor) : pm.type.bodyColor;
      ctx.fillStyle = invalid ? '#e8a0a0' : hidden ? '#dcd8cf' : body;
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

      // ports: thick strokes along the boundary. When labels are hidden they
      // become an anonymous thicker border; otherwise colored by kind.
      const io = sim.machineIO.get(pm.machine.id);
      for (const port of pm.ports) {
        ctx.strokeStyle = hidden ? '#4a4640' : port.def.kind === 'in' ? '#2f7fd1' : '#e08a1e';
        ctx.lineWidth = 4;
        ctx.lineCap = 'butt';
        const inset = 2;
        ctx.beginPath();
        for (const [[x, y], s] of port.edges) {
          if (s === 0) { ctx.moveTo(x * CELL, y * CELL + inset); ctx.lineTo(x * CELL + CELL, y * CELL + inset); }
          if (s === 2) { ctx.moveTo(x * CELL, y * CELL + CELL - inset); ctx.lineTo(x * CELL + CELL, y * CELL + CELL - inset); }
          if (s === 3) { ctx.moveTo(x * CELL + inset, y * CELL); ctx.lineTo(x * CELL + inset, y * CELL + CELL); }
          if (s === 1) { ctx.moveTo(x * CELL + CELL - inset, y * CELL); ctx.lineTo(x * CELL + CELL - inset, y * CELL + CELL); }
        }
        ctx.stroke();
        if (hidden) continue;

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

      if (!hidden) {
        // machine name at footprint center
        const cxs = pm.cells.map(([x]) => x * CELL + CELL / 2);
        const cys = pm.cells.map(([, y]) => y * CELL + CELL / 2);
        ctx.fillStyle = '#2b2823';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          pm.type.name,
          cxs.reduce((a, b) => a + b, 0) / cxs.length,
          cys.reduce((a, b) => a + b, 0) / cys.length,
        );
      }
      ctx.globalAlpha = 1;
    };

    for (const pm of placed) drawMachine(pm);

    // drag preview: pipe line
    const drag = dragRef.current;
    if (drag?.mode === 'pipe') {
      for (const { cell, inSide, outSide } of orientPath(drag.path)) {
        if (!occupied.has(cellKey(cell[0], cell[1]))) {
          drawPumpBase(cell[0], cell[1], 0.55);
          drawPumpArrow(cell[0], cell[1], inSide, outSide, null, 0, 0.55);
        }
      }
    }

    // copy/paste and erase previews — deliberately coarse: only supercells
    // are highlighted, even though the real region is fine-grid-precise
    const t = toolRef.current;
    const hc = hoverCellRef.current;
    if ((t.kind === 'copy' || t.kind === 'erase') && hc) {
      const clip = t.kind === 'copy' ? clipboardRef.current : null;
      const n = clip ? clip.size : copyCells();
      const nSuper = Math.max(1, Math.round(n / S)); // square side, in supercells
      const sx = Math.floor(hc[0] / S);
      const sy = Math.floor(hc[1] / S);
      const tlx = sx - Math.floor(nSuper / 2);
      const tly = sy - Math.floor(nSuper / 2);
      const [weak, strong, line] =
        t.kind === 'erase'
          ? ['rgba(214, 60, 60, 0.10)', 'rgba(214, 60, 60, 0.20)', '#d63c3c']
          : clip
            ? ['rgba(47, 127, 209, 0.14)', 'rgba(47, 127, 209, 0.22)', '#2f7fd1']
            : ['rgba(74, 70, 64, 0.10)', 'rgba(74, 70, 64, 0.18)', '#4a4640'];
      ctx.fillStyle = weak;
      ctx.fillRect(tlx * S * CELL, tly * S * CELL, nSuper * S * CELL, nSuper * S * CELL);
      // the supercell under the cursor, a shade stronger
      ctx.fillStyle = strong;
      ctx.fillRect(sx * S * CELL, sy * S * CELL, S * CELL, S * CELL);
      if (clip?.snapshot) {
        // ghost of what the copy-time supercell square looked like
        ctx.globalAlpha = 0.55;
        ctx.drawImage(clip.snapshot, tlx * S * CELL, tly * S * CELL, nSuper * S * CELL, nSuper * S * CELL);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(tlx * S * CELL + 0.5, tly * S * CELL + 0.5, nSuper * S * CELL, nSuper * S * CELL);
      ctx.setLineDash([]);
    }

    // selection outline in edit mode
    if (t.kind === 'edit' && selectedIdRef.current !== null) {
      const sel = placed.find((pm) => pm.machine.id === selectedIdRef.current);
      if (sel) {
        const cellSet = new Set(sel.cells.map(([x, y]) => cellKey(x, y)));
        ctx.strokeStyle = '#2f7fd1';
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (const [x, y] of sel.cells) {
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
      }
    }

    // hover highlight
    if (hc && t.kind === 'pipe') {
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
      if (e.key === 'Escape') setClipboard(null);
      if (e.key === 'r' || e.key === 'R') setClipboard((c) => (c ? rotateClipboard(c) : c));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideLabels, clipboard, tool, copySuper, superSize, selectedId]);

  // ---- mouse handlers ----------------------------------------------------

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const cell = eventCell(e);
    if (!cell) return;
    const t = toolRef.current;
    if (t.kind === 'pipe') {
      // starting on a machine is fine: pumps appear once the drag leaves it
      dragRef.current = { mode: 'pipe', path: [cell] };
    } else if (t.kind === 'erase') {
      dragRef.current = { mode: 'erase', last: cell };
      eraseRegion(cell);
    } else if (t.kind === 'edit') {
      const pm = machineCellMap(placeAll(worldRef.current)).get(cellKey(cell[0], cell[1]));
      setSelectedId(pm ? pm.machine.id : null);
    } else {
      const clip = clipboardRef.current;
      if (clip) {
        pasteClipboard(squareTL(cell, clip.size), clip);
      } else {
        const captured = captureRegion(squareTL(cell, copyCells()));
        captured.snapshot = snapshotSupercells(cell);
        setClipboard(captured);
      }
    }
    draw();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const cell = eventCell(e);
    updateHover(cell);
    const drag = dragRef.current;
    if (cell && drag?.mode === 'pipe') {
      const occupied = machineCellMap(placeAll(worldRef.current));
      const isMachine = (c: Cell) => occupied.has(cellKey(c[0], c[1]));
      if (drag.path.length === 1 && isMachine(drag.path[0]) && isMachine(cell)) {
        drag.path[0] = cell; // slide the anchor while still inside a machine
      } else {
        // machine cells are allowed in the path (no pumps appear on them, so
        // the pipe tunnels through and resumes on the far side)
        extendPath(drag.path, cell, ([x, y]) => x < 0 || y < 0 || x >= GRID_W || y >= GRID_H);
      }
    } else if (cell && drag?.mode === 'erase') {
      // interpolate so fast drags don't skip fine-grid cells
      let [lx, ly] = drag.last;
      while (lx !== cell[0] || ly !== cell[1]) {
        if (lx !== cell[0]) lx += Math.sign(cell[0] - lx);
        else ly += Math.sign(cell[1] - ly);
        eraseRegion([lx, ly]);
      }
      drag.last = cell;
    }
    draw();
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (drag?.mode === 'pipe') commitPipePath(drag.path);
    dragRef.current = null;
    draw();
  };

  // ---- info panel --------------------------------------------------------

  const renderPanel = () => {
    const world = worldRef.current;
    const sim = simRef.current;
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
          <h2>Edit: {hideLabels ? 'Machine' : type.name}</h2>
          {defs.length === 0 ? (
            <p className="rule dim">This machine has no adjustable parameters.</p>
          ) : (
            defs.map((pd) => {
              const value = machine.params?.[pd.key] ?? pd.default;
              const set = (v: ParamValue) => {
                machine.params = { ...machine.params, [pd.key]: v };
                setTick((t) => t + 1);
              };
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
      if (hideLabels) {
        return (
          <>
            <h2>Machine</h2>
            <p className="rule dim">Labels are hidden, so this machine keeps its secrets.</p>
          </>
        );
      }
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
              <li>Click to copy the outlined {copySuper}×{copySuper}-supercell square.</li>
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
        </ul>
      </>
    );
  };

  return (
    <div className="app">
      <div className="toolbar">
        <button className={tool.kind === 'pipe' ? 'active' : ''} onClick={() => setTool({ kind: 'pipe' })}>
          Pipes
        </button>
        <button className={tool.kind === 'copy' ? 'active' : ''} onClick={() => setTool({ kind: 'copy' })}>
          Copy/paste
        </button>
        <label className="slider">
          {copySuper}×{copySuper}
          <input
            type="range"
            min={1}
            max={7}
            step={2}
            value={copySuper}
            onChange={(e) => setCopySuper(Number(e.target.value))}
          />
        </label>
        <button className={tool.kind === 'erase' ? 'active' : ''} onClick={() => setTool({ kind: 'erase' })}>
          Erase
        </button>
        <button className={tool.kind === 'edit' ? 'active' : ''} onClick={() => setTool({ kind: 'edit' })}>
          Edit
        </button>
        <span className="spacer" />
        <label className="slider">
          Grid: {superSize}
          <input
            type="range"
            min={2}
            max={20}
            value={superSize}
            onChange={(e) => setSuperSize(Number(e.target.value))}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={hideLabels} onChange={(e) => setHideLabels(e.target.checked)} />
          Hide labels
        </label>
        <label className="slider" title="Gaussian blur applied while labels are hidden">
          Blur: {blurPx.toFixed(1)}
          <input
            type="range"
            min={0}
            max={8}
            step={0.5}
            value={blurPx}
            disabled={!hideLabels}
            onChange={(e) => setBlurPx(Number(e.target.value))}
          />
        </label>
        <button
          onClick={() => {
            const fresh = freshWorld();
            worldRef.current = fresh.world;
            simRef.current = fresh.sim;
            setClipboard(null);
            draw();
          }}
        >
          Reset world
        </button>
      </div>
      <div className="main">
        <canvas
          ref={canvasRef}
          width={GRID_W * CELL}
          height={GRID_H * CELL}
          style={{ filter: hideLabels && blurPx > 0 ? `blur(${blurPx}px)` : 'none' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onContextMenu={(e) => {
            e.preventDefault();
            setClipboard(null);
          }}
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
