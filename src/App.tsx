import { useEffect, useRef, useState } from 'react';
import {
  CELL, GRID_H, GRID_W, cellKey, machineCellMap, mergePumps, orientPath, placeMachine,
} from './geom';
import { MACHINE_TYPES, TYPE_BY_ID } from './machines';
import { emptySim, placeAll, step } from './sim';
import type { SimState } from './sim';
import { worldFromCode, worldToCode } from './serialize';
import { buildStarterWorld } from './starter';
import { PRESETS } from './presets';
import type { Cell, Machine, ParamDef, ParamValue, World } from './types';
import {
  bboxTL, captureRegion, lassoRegion, machinePlacementOk, pasteClipboard, rotateClipboard, squareRegion,
} from './clipboard';
import type { Clipboard, Region } from './clipboard';
import { drawToolOverlay, drawWorld } from './render';
import type { DragState, Tool, ViewState } from './render';
import { Panel } from './Panel';
import type { Hover } from './Panel';
import './App.css';

const TICK_MS = 110;

// Pre-run the sim so a fresh or imported world is already flowing.
function prewarm(world: World): SimState {
  let sim = emptySim();
  for (let i = 0; i < 400; i++) sim = step(world, sim, TICK_MS / 1000);
  return sim;
}

function freshWorld(): { world: World; sim: SimState } {
  const world = buildStarterWorld(GRID_W, GRID_H);
  return { world, sim: prewarm(world) };
}

const hoverKey = (h: Hover): string => (h === null ? '' : h.kind === 'machine' ? `m${h.machineId}` : `p${h.key}`);

function Slider({ label, title, min, max, step, value, onChange }: {
  label: string; title?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="slider" title={title}>
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [initial] = useState(freshWorld);
  const worldRef = useRef<World>(initial.world);
  const simRef = useRef<SimState>(initial.sim);

  const [tool, setTool] = useState<Tool>({ kind: 'pipe' });
  const [simSpeed, setSimSpeed] = useState(1); // sim time-scale: ticks/sec multiplier
  const [copySize, setCopySize] = useState(19); // copy square side, in fine cells (odd)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  // God mode = the designer's view: labels, fine grid, machine placement,
  // editing. Off (the default) = the player's obscured view: anonymous
  // machines + blur.
  const [godMode, setGodMode] = useState(false);
  const [placeRotation, setPlaceRotation] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [, setTick] = useState(0); // re-render so the info panel shows live flows

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const copySizeRef = useRef(copySize);
  copySizeRef.current = copySize;
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  const godModeRef = useRef(godMode);
  godModeRef.current = godMode;
  const placeRotationRef = useRef(placeRotation);
  placeRotationRef.current = placeRotation;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const hoverCellRef = useRef<Cell | null>(null);
  const dragRef = useRef<DragState>(null);

  // ---- undo/redo ---------------------------------------------------------
  // Snapshot the whole world before each mutating gesture. Rapid repeats of
  // the same coalesce key (e.g. dragging one param slider) share one entry.

  const undoRef = useRef<World[]>([]);
  const redoRef = useRef<World[]>([]);
  const lastCkptRef = useRef<{ key: string; time: number } | null>(null);

  const checkpoint = (coalesceKey?: string) => {
    if (coalesceKey) {
      const last = lastCkptRef.current;
      if (last && last.key === coalesceKey && Date.now() - last.time < 1200) {
        last.time = Date.now();
        return;
      }
      lastCkptRef.current = { key: coalesceKey, time: Date.now() };
    } else {
      lastCkptRef.current = null;
    }
    undoRef.current.push(structuredClone(worldRef.current));
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
  };

  const timeTravel = (from: React.RefObject<World[]>, to: React.RefObject<World[]>) => {
    const world = from.current.pop();
    if (!world) return;
    to.current.push(structuredClone(worldRef.current));
    worldRef.current = world;
    lastCkptRef.current = null;
    setSelectedId(null);
    draw();
  };
  const undo = () => timeTravel(undoRef, redoRef);
  const redo = () => timeTravel(redoRef, undoRef);

  const eventCell = (e: { clientX: number; clientY: number }): Cell | null => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const rect = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID_W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID_H);
    if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return null;
    return [x, y];
  };

  // cursor position in map px, clamped to the canvas (for lasso paths)
  const eventPx = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const rect = cv.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * GRID_W * CELL;
    const y = ((e.clientY - rect.top) / rect.height) * GRID_H * CELL;
    return [Math.max(0, Math.min(GRID_W * CELL, x)), Math.max(0, Math.min(GRID_H * CELL, y))];
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
    setHover((h) => (hoverKey(h) === hoverKey(next) ? h : next));
  };

  // Wipe a region: pumps inside it go, and machines overlapping it even
  // partially go whole.
  const eraseRegion = (region: Region) => {
    const world = worldRef.current;
    for (const k of [...world.pumps.keys()]) {
      if (region.cells.has(k)) world.pumps.delete(k);
    }
    const doomed = new Set(
      placeAll(world)
        .filter((pm) => pm.cells.some(([x, y]) => region.cells.has(cellKey(x, y))))
        .map((pm) => pm.machine.id),
    );
    if (doomed.size > 0) world.machines = world.machines.filter((m) => !doomed.has(m.id));
  };

  const commitPipePath = (path: Cell[]) => {
    const world = worldRef.current;
    const occupied = machineCellMap(placeAll(world));
    const placements = orientPath(path).filter(
      ({ cell }) => !occupied.has(cellKey(cell[0], cell[1])),
    );
    if (placements.length === 0) return;
    checkpoint();
    for (const { cell, inSide, outSide } of placements) {
      const k = cellKey(cell[0], cell[1]);
      world.pumps.set(k, mergePumps(world.pumps.get(k), { inSide, outSide }));
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

  // Photograph the copied region's bounding box for use as the paste ghost.
  // Reads the offscreen world canvas, so the snapshot is unaffected by the
  // lake warp (and tool overlays, which are drawn on the visible canvas).
  const snapshotRegion = (region: Region): HTMLCanvasElement | undefined => {
    const snap = document.createElement('canvas');
    snap.width = region.w * CELL;
    snap.height = region.h * CELL;
    snap.getContext('2d')!.drawImage(
      worldCanvas(),
      region.tl[0] * CELL, region.tl[1] * CELL, snap.width, snap.height,
      0, 0, snap.width, snap.height,
    );
    return snap;
  };

  // A copy/erase gesture ends: a click (no real movement) selects the
  // slider-sized square centered on the cursor; a drag selects whatever the
  // lassoed loop encloses.
  const commitLasso = (lasso: { tool: 'copy' | 'erase'; points: Array<[number, number]> }) => {
    const pts = lasso.points;
    const [sx, sy] = pts[0];
    const isClick = pts.every(([x, y]) => Math.hypot(x - sx, y - sy) < CELL * 1.5);
    const anchor: Cell = [
      Math.min(GRID_W - 1, Math.floor(sx / CELL)),
      Math.min(GRID_H - 1, Math.floor(sy / CELL)),
    ];
    const region = isClick ? squareRegion(anchor, copySizeRef.current) : lassoRegion(pts);
    if (!region) return;
    if (lasso.tool === 'erase') {
      checkpoint();
      eraseRegion(region);
    } else {
      const captured = captureRegion(worldRef.current, region);
      captured.snapshot = snapshotRegion(region);
      setClipboard(captured);
    }
  };

  // ---- drawing -----------------------------------------------------------
  // The world is rendered to an offscreen canvas, then blitted to the
  // visible canvas with the tool overlay on top — so region snapshots (the
  // paste ghost) can read the offscreen canvas without capturing overlays.

  const worldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldCanvas = (): HTMLCanvasElement => {
    if (!worldCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = GRID_W * CELL;
      c.height = GRID_H * CELL;
      worldCanvasRef.current = c;
    }
    return worldCanvasRef.current;
  };

  const currentView = (): ViewState => ({
    world: worldRef.current,
    sim: simRef.current,
    godMode: godModeRef.current,
    copyCells: copySizeRef.current,
    tool: toolRef.current,
    hoverCell: hoverCellRef.current,
    drag: dragRef.current,
    clipboard: clipboardRef.current,
    selectedId: selectedIdRef.current,
    placeRotation: placeRotationRef.current,
  });

  const composite = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.getContext('2d')!.drawImage(worldCanvas(), 0, 0);
    drawToolOverlay(cv, currentView());
  };

  const draw = () => {
    drawWorld(worldCanvas(), currentView());
    composite();
  };

  // Leaving god mode drops the god-only tools and selection.
  const setGodModeTo = (god: boolean) => {
    setGodMode(god);
    if (!god) {
      setSelectedId(null);
      setTool((t) => (t.kind === 'edit' || t.kind === 'place' ? { kind: 'pipe' } : t));
    }
  };

  // ---- lifecycle ---------------------------------------------------------

  // The sim tick. simSpeed only changes how often ticks fire in real time —
  // each tick still advances TICK_MS of sim time, so the dynamics are
  // identical at every speed, just faster or slower on the wall clock.
  useEffect(() => {
    const iv = setInterval(() => {
      simRef.current = step(worldRef.current, simRef.current, TICK_MS / 1000);
      setTick((t) => t + 1);
      draw();
    }, TICK_MS / simSpeed);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simSpeed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') setClipboard(null);
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
        setGodModeTo(!godModeRef.current);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (toolRef.current.kind === 'place') setPlaceRotation((r) => (r + 1) % 4);
        else setClipboard((c) => (c ? rotateClipboard(c) : c));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [godMode, clipboard, tool, copySize, selectedId, placeRotation]);

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
      const p = eventPx(e);
      if (p) dragRef.current = { mode: 'lasso', tool: 'erase', points: [p] };
    } else if (t.kind === 'edit') {
      const pm = machineCellMap(placeAll(worldRef.current)).get(cellKey(cell[0], cell[1]));
      setSelectedId(pm ? pm.machine.id : null);
      if (pm) {
        dragRef.current = {
          mode: 'move',
          machineId: pm.machine.id,
          grab: [cell[0] - pm.machine.origin[0], cell[1] - pm.machine.origin[1]],
        };
      }
    } else if (t.kind === 'place') {
      const world = worldRef.current;
      const machine: Machine = {
        id: world.nextMachineId,
        typeId: t.typeId,
        origin: cell,
        rotation: placeRotationRef.current,
      };
      if (machinePlacementOk(world, placeMachine(machine, TYPE_BY_ID[t.typeId]))) {
        checkpoint();
        world.machines.push(machine);
        world.nextMachineId++;
      }
    } else {
      const clip = clipboardRef.current;
      if (clip) {
        checkpoint();
        pasteClipboard(worldRef.current, bboxTL(cell, clip.w, clip.h), clip);
      } else {
        const p = eventPx(e);
        if (p) dragRef.current = { mode: 'lasso', tool: 'copy', points: [p] };
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
    } else if (cell && drag?.mode === 'move') {
      // live-move the machine, refusing spots where it wouldn't fit
      const machine = worldRef.current.machines.find((m) => m.id === drag.machineId);
      if (machine) {
        const target: Cell = [cell[0] - drag.grab[0], cell[1] - drag.grab[1]];
        if (target[0] !== machine.origin[0] || target[1] !== machine.origin[1]) {
          const candidate = { ...machine, origin: target };
          if (machinePlacementOk(worldRef.current, placeMachine(candidate, TYPE_BY_ID[machine.typeId]), machine.id)) {
            if (!drag.moved) {
              checkpoint();
              drag.moved = true;
            }
            machine.origin = target;
          }
        }
      }
    } else if (drag?.mode === 'lasso') {
      const p = eventPx(e);
      if (p) {
        const [lx, ly] = drag.points[drag.points.length - 1];
        if (Math.hypot(p[0] - lx, p[1] - ly) >= 2) drag.points.push(p);
      }
    }
    draw();
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.mode === 'pipe') commitPipePath(drag.path);
    else if (drag?.mode === 'lasso') commitLasso(drag);
    draw();
  };

  // ---- world sharing -----------------------------------------------------

  const adoptWorld = (world: World) => {
    checkpoint();
    worldRef.current = world;
    simRef.current = prewarm(world);
    setClipboard(null);
    setSelectedId(null);
    draw();
  };

  // #world=<code> in the URL loads that world (on first visit and on change)
  useEffect(() => {
    const loadFromHash = async () => {
      const m = window.location.hash.match(/^#world=(.+)$/);
      if (!m) return;
      try {
        adoptWorld(await worldFromCode(decodeURIComponent(m[1])));
      } catch {
        window.alert('Could not load the world from this link.');
      }
    };
    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    return () => window.removeEventListener('hashchange', loadFromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [exportLabel, setExportLabel] = useState('Export');
  const [shareLabel, setShareLabel] = useState('Share link');

  const shareWorld = async () => {
    const code = await worldToCode(worldRef.current);
    const url = `${window.location.origin}${window.location.pathname}#world=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareLabel('Link copied!');
      setTimeout(() => setShareLabel('Share link'), 1500);
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  const exportWorld = async () => {
    const code = await worldToCode(worldRef.current);
    try {
      await navigator.clipboard.writeText(code);
      setExportLabel('Copied!');
      setTimeout(() => setExportLabel('Export'), 1500);
    } catch {
      window.prompt('Copy this world code:', code);
    }
  };

  const importWorld = async () => {
    const code = window.prompt('Paste a world code:');
    if (!code?.trim()) return;
    try {
      adoptWorld(await worldFromCode(code));
    } catch {
      window.alert('Could not read that world code.');
    }
  };

  // ---- info panel --------------------------------------------------------

  const onParamChange = (machine: Machine, pd: ParamDef, v: ParamValue) => {
    checkpoint(`param:${machine.id}:${pd.key}`);
    machine.params = { ...machine.params, [pd.key]: v };
    setTick((t) => t + 1);
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
        <Slider
          label={`${copySize}×${copySize}`}
          min={5}
          max={45}
          step={2}
          value={copySize}
          onChange={setCopySize}
        />
        <button className={tool.kind === 'erase' ? 'active' : ''} onClick={() => setTool({ kind: 'erase' })}>
          Erase
        </button>
        <button disabled={undoRef.current.length === 0} onClick={undo} title="Ctrl+Z">
          Undo
        </button>
        <button disabled={redoRef.current.length === 0} onClick={redo} title="Ctrl+Shift+Z">
          Redo
        </button>
        <Slider
          label={`Speed: ${simSpeed}×`}
          title="Sim speed — ticks come faster, but each tick is unchanged"
          min={0.25}
          max={8}
          step={0.25}
          value={simSpeed}
          onChange={setSimSpeed}
        />
        {godMode && (
          <>
            <button className={tool.kind === 'edit' ? 'active' : ''} onClick={() => setTool({ kind: 'edit' })}>
              Edit
            </button>
            <span className="divider" />
            {MACHINE_TYPES.map((mt) => (
              <button
                key={mt.id}
                className={tool.kind === 'place' && tool.typeId === mt.id ? 'active' : ''}
                style={{ borderBottomColor: mt.bodyColor }}
                onClick={() => setTool({ kind: 'place', typeId: mt.id })}
              >
                {mt.name}
              </button>
            ))}
          </>
        )}
        <span className="spacer" />
        <label className="checkbox" title="Toggle with G">
          <input
            type="checkbox"
            checked={godMode}
            onChange={(e) => setGodModeTo(e.target.checked)}
          />
          God mode
        </label>
        <button onClick={shareWorld}>{shareLabel}</button>
        <button onClick={exportWorld}>{exportLabel}</button>
        <button onClick={importWorld}>Import</button>
        <select
          value=""
          onChange={(e) => {
            const preset = PRESETS.find((p) => p.id === e.target.value);
            if (preset) adoptWorld(preset.build(GRID_W, GRID_H));
          }}
        >
          <option value="" disabled>
            Load preset…
          </option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="main">
        <canvas
          ref={canvasRef}
          width={GRID_W * CELL}
          height={GRID_H * CELL}
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
        <div className="panel">
          <Panel
            world={worldRef.current}
            sim={simRef.current}
            tool={tool}
            hover={hover}
            selectedId={selectedId}
            godMode={godMode}
            clipboard={clipboard}
            copySize={copySize}
            onParamChange={onParamChange}
          />
        </div>
      </div>
    </div>
  );
}
