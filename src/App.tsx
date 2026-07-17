import { useEffect, useRef, useState } from 'react';
import {
  cellKey, machineCellMap, mergePumps, orientPath, parseKey, placeMachine,
} from './geom';
import { MACHINE_TYPES, TYPE_BY_ID } from './machines';
import { emptySim, placeAll, step } from './sim';
import type { SimState } from './sim';
import { worldFromCode, worldToCode } from './serialize';
import { buildStarterWorld } from './starter';
import type { Cell, Machine, ParamDef, ParamValue, World } from './types';
import {
  captureRegion, machinePlacementOk, pasteClipboard, rotateClipboard, squareTL,
} from './clipboard';
import type { Clipboard } from './clipboard';
import { CELL, GRID_H, GRID_W, drawLakeWarped, drawWorld } from './render';
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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [initial] = useState(freshWorld);
  const worldRef = useRef<World>(initial.world);
  const simRef = useRef<SimState>(initial.sim);

  const [tool, setTool] = useState<Tool>({ kind: 'pipe' });
  const [copySize, setCopySize] = useState(19); // copy square side, in fine cells (odd)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  // God mode = the designer's view: labels, fine grid, machine placement,
  // editing. Off (the default) = the player's obscured view: anonymous
  // machines + blur.
  const [godMode, setGodMode] = useState(false);
  const [blurPx, setBlurPx] = useState(3); // whole-canvas Gaussian blur outside god mode
  const [toolBlur, setToolBlur] = useState(2); // blur on the copy/erase square outside god mode, in cells
  const [warpAmp, setWarpAmp] = useState(2); // how far the square's drawn edges wander, in cells
  const [warpScale, setWarpScale] = useState(10); // feature size of the warp field, in cells
  const [lakeAmp, setLakeAmp] = useState(3); // time-varying whole-map warp amplitude, in cells
  const [lakeScale, setLakeScale] = useState(15); // lake ripple feature size, in cells
  const [lakeSpeed, setLakeSpeed] = useState(1); // ripple renewals per second
  const [placeRotation, setPlaceRotation] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [, setTick] = useState(0); // re-render so the info panel shows live flows

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const copySizeRef = useRef(copySize);
  copySizeRef.current = copySize;
  const toolBlurRef = useRef(toolBlur);
  toolBlurRef.current = toolBlur;
  const warpAmpRef = useRef(warpAmp);
  warpAmpRef.current = warpAmp;
  const warpScaleRef = useRef(warpScale);
  warpScaleRef.current = warpScale;
  const lakeAmpRef = useRef(lakeAmp);
  lakeAmpRef.current = lakeAmp;
  const lakeScaleRef = useRef(lakeScale);
  lakeScaleRef.current = lakeScale;
  const lakeSpeedRef = useRef(lakeSpeed);
  lakeSpeedRef.current = lakeSpeed;
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

  // Wipe the copy-sized square centered on the cursor: pumps inside it go,
  // and machines overlapping it even partially go whole.
  const eraseRegion = (anchor: Cell) => {
    const n = copySizeRef.current;
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

  // Photograph the copied region (with the tool overlay suppressed) for use
  // as the paste ghost. Reads the offscreen world canvas, so the snapshot is
  // unaffected by the lake warp.
  const snapshotRegion = (cell: Cell): HTMLCanvasElement | undefined => {
    const n = copySizeRef.current;
    const [tlx, tly] = squareTL(cell, n);
    const px = n * CELL;
    const prevHover = hoverCellRef.current;
    hoverCellRef.current = null;
    draw();
    const snap = document.createElement('canvas');
    snap.width = px;
    snap.height = px;
    snap.getContext('2d')!.drawImage(worldCanvas(), tlx * CELL, tly * CELL, px, px, 0, 0, px, px);
    hoverCellRef.current = prevHover;
    draw();
    return snap;
  };

  // ---- drawing -----------------------------------------------------------
  // The world (plus tool overlays) is rendered to an offscreen canvas; a rAF
  // loop composites it onto the visible canvas, warped through the
  // time-varying "lake" field outside god mode.

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

  const composite = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (godModeRef.current || lakeAmpRef.current <= 0) {
      cv.getContext('2d')!.drawImage(worldCanvas(), 0, 0);
    } else {
      drawLakeWarped(
        cv, worldCanvas(), performance.now() / 1000,
        lakeAmpRef.current * CELL, lakeScaleRef.current * CELL, lakeSpeedRef.current,
      );
    }
  };

  const draw = () => {
    const view: ViewState = {
      world: worldRef.current,
      sim: simRef.current,
      godMode: godModeRef.current,
      toolBlur: toolBlurRef.current,
      warpAmp: warpAmpRef.current,
      warpScale: warpScaleRef.current,
      copyCells: copySizeRef.current,
      tool: toolRef.current,
      hoverCell: hoverCellRef.current,
      drag: dragRef.current,
      clipboard: clipboardRef.current,
      selectedId: selectedIdRef.current,
      placeRotation: placeRotationRef.current,
    };
    drawWorld(worldCanvas(), view);
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

  useEffect(() => {
    const iv = setInterval(() => {
      simRef.current = step(worldRef.current, simRef.current, TICK_MS / 1000);
      setTick((t) => t + 1);
      draw();
    }, TICK_MS);
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
    let raf = requestAnimationFrame(function loop() {
      composite();
      raf = requestAnimationFrame(loop);
    });
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [godMode, clipboard, tool, copySize, toolBlur, warpAmp, warpScale, selectedId, placeRotation]);

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
      checkpoint();
      dragRef.current = { mode: 'erase', last: cell };
      eraseRegion(cell);
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
        pasteClipboard(worldRef.current, squareTL(cell, clip.size), clip);
      } else {
        const n = copySizeRef.current;
        const captured = captureRegion(worldRef.current, squareTL(cell, n), n);
        captured.snapshot = snapshotRegion(cell);
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
        <label className="slider">
          {copySize}×{copySize}
          <input
            type="range"
            min={5}
            max={45}
            step={2}
            value={copySize}
            onChange={(e) => setCopySize(Number(e.target.value))}
          />
        </label>
        <button className={tool.kind === 'erase' ? 'active' : ''} onClick={() => setTool({ kind: 'erase' })}>
          Erase
        </button>
        <button disabled={undoRef.current.length === 0} onClick={undo} title="Ctrl+Z">
          Undo
        </button>
        <button disabled={redoRef.current.length === 0} onClick={redo} title="Ctrl+Shift+Z">
          Redo
        </button>
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
        {godMode && (
          <>
            <label className="slider" title="Gaussian blur applied outside god mode">
              Blur: {blurPx.toFixed(1)}
              <input
                type="range"
                min={0}
                max={8}
                step={0.5}
                value={blurPx}
                onChange={(e) => setBlurPx(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="Blur on the copy/erase square outside god mode, in cells">
              Tool blur: {toolBlur.toFixed(1)}
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={toolBlur}
                onChange={(e) => setToolBlur(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="How far the tool square's drawn edges wander through the world-locked warp field, in cells">
              Warp: {warpAmp.toFixed(1)}
              <input
                type="range"
                min={0}
                max={5}
                step={0.25}
                value={warpAmp}
                onChange={(e) => setWarpAmp(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="Feature size of the warp field, in cells">
              Warp scale: {warpScale}
              <input
                type="range"
                min={2}
                max={30}
                step={1}
                value={warpScale}
                onChange={(e) => setWarpScale(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="Time-varying whole-map warp amplitude outside god mode, in cells">
              Lake: {lakeAmp.toFixed(1)}
              <input
                type="range"
                min={0}
                max={3}
                step={0.1}
                value={lakeAmp}
                onChange={(e) => setLakeAmp(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="Feature size of the lake ripples, in cells">
              Lake scale: {lakeScale}
              <input
                type="range"
                min={4}
                max={40}
                step={1}
                value={lakeScale}
                onChange={(e) => setLakeScale(Number(e.target.value))}
              />
            </label>
            <label className="slider" title="How often the ripple pattern renews itself, per second">
              Lake speed: {lakeSpeed.toFixed(1)}
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={lakeSpeed}
                onChange={(e) => setLakeSpeed(Number(e.target.value))}
              />
            </label>
          </>
        )}
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
        <button onClick={() => adoptWorld(buildStarterWorld(GRID_W, GRID_H))}>Reset world</button>
      </div>
      <div className="main">
        <canvas
          ref={canvasRef}
          width={GRID_W * CELL}
          height={GRID_H * CELL}
          style={{ filter: !godMode && blurPx > 0 ? `blur(${blurPx}px)` : 'none' }}
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
