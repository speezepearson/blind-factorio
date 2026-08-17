import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RADICALS, buildChemistry } from './chem';
import {
  CELL, COLS, ROWS, doTick, ensureHist, eraseCells, key, snapshotWorld, tryBud, commitVein,
} from './world';
import type { Head, Tail, World } from './world';
import { drawWorld } from './render';
import type { DragState, Tool } from './render';
import { worldFromCode, worldToCode } from './serialize';
import { PRESETS } from './presets';
import { ProbePanel } from './Probes';
import type { Probe } from './Probes';
import './App.css';

// One chemistry for the app's lifetime; worlds come and go, the radical
// table doesn't. (Stickiness on it is god-tunable and shared via codes.)
const chem = buildChemistry(DEFAULT_RADICALS);

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(null as unknown as World);
  if (!worldRef.current) worldRef.current = PRESETS[0].build(chem);

  const [tool, setTool] = useState<Tool>('draw');
  const [running, setRunning] = useState(true);
  const [tps, setTps] = useState(4);
  const [tempOverlay, setTempOverlay] = useState(false);
  // God mode = the designer's view: probes, temperature, stickiness,
  // labels. Off (the default) = the player's view: color, width, and flow
  // direction are the only windows into the chemistry.
  const [godMode, setGodMode] = useState(false);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [stick, setStick] = useState({ ...chem.stick });
  const [uiTick, setUiTick] = useState(0);

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const runningRef = useRef(running);
  runningRef.current = running;
  const tpsRef = useRef(tps);
  tpsRef.current = tps;
  const overlayRef = useRef(tempOverlay);
  overlayRef.current = tempOverlay;
  const godModeRef = useRef(godMode);
  godModeRef.current = godMode;
  const probesRef = useRef(probes);
  probesRef.current = probes;
  const dragRef = useRef<DragState>(null);
  const nextProbeId = useRef(1);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2600);
  };

  // ---- undo/redo: whole-world snapshots per mutating gesture ----
  // (Probe history is excluded from snapshots and regrows; stickiness is
  // chemistry, not world, and is deliberately not undoable.)

  const undoRef = useRef<World[]>([]);
  const redoRef = useRef<World[]>([]);
  const pushUndo = (snap: World) => {
    undoRef.current.push(snap);
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
  };
  const checkpoint = () => pushUndo(snapshotWorld(worldRef.current));
  const timeTravel = (from: React.RefObject<World[]>, to: React.RefObject<World[]>) => {
    const world = from.current.pop();
    if (!world) return;
    to.current.push(snapshotWorld(worldRef.current));
    worldRef.current = world;
    setUiTick((t) => t + 1);
  };
  const undo = () => timeTravel(undoRef, redoRef);
  const redo = () => timeTravel(redoRef, undoRef);

  // ---- sim loop: rAF with a tick accumulator ----

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (runningRef.current) {
        acc += dt * tpsRef.current;
        const budget = performance.now() + 12;
        let n = 0;
        while (acc >= 1 && n < 1200 && performance.now() < budget) {
          doTick(worldRef.current);
          acc -= 1;
          n++;
        }
        if (acc > 3) acc = 3; // don't build unpayable tick debt
      }
      const cv = canvasRef.current;
      if (cv) {
        drawWorld(cv, {
          world: worldRef.current,
          godMode: godModeRef.current,
          tempOverlay: overlayRef.current,
          drag: dragRef.current,
          probes: probesRef.current,
        });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // chart refresh pulse
  useEffect(() => {
    const iv = setInterval(() => setUiTick((t) => t + 1), 250);
    return () => clearInterval(iv);
  }, []);

  // ---- keyboard ----

  const setGodModeTo = (god: boolean) => {
    setGodMode(god);
    if (!god) {
      setTool((t) => (t === 'probe' ? 'draw' : t));
      setTempOverlay(false);
    }
  };
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
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) setGodModeTo(!godModeRef.current);
      if (e.key === ' ') {
        e.preventDefault();
        setRunning((r) => !r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- mouse: draw / erase / probe / bud ----

  const cellAt = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * COLS);
    const y = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;
    return { x, y, k: key(x, y) };
  };

  const addProbe = (c: { x: number; y: number; k: string }) => {
    const w = worldRef.current;
    const segs = w.cellSegs.get(c.k);
    if (!segs || segs.length === 0) {
      flashMsg('no vein to probe there');
      return;
    }
    const added: Probe[] = [];
    for (const s of segs) {
      s.vein.probed = true;
      ensureHist(w, s.vein, s.idx);
      added.push({
        id: nextProbeId.current++,
        veinId: s.vein.id,
        cellKey: c.k,
        label: `(${c.x},${c.y})${segs.length > 1 ? ' ·vein ' + s.vein.id : ''}`,
      });
    }
    setProbes((ps) => [...ps, ...added]);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const c = cellAt(e);
    if (!c) return;
    const w = worldRef.current;
    if (toolRef.current === 'probe') {
      if (godModeRef.current) addProbe(c);
      return;
    }
    if (toolRef.current === 'erase') {
      dragRef.current = { kind: 'erase', keys: new Set([c.k]) };
      return;
    }
    // draw: what does this vein grow out of?
    let head: Head = { type: 'open' };
    let startExcluded = false;
    const src = w.sourceMap.get(c.k);
    const oc = w.organCells.get(c.k);
    if (src) {
      head = { type: 'source', spIdx: src.spIdx };
      startExcluded = true;
    } else if (oc && (oc.role === 'out' || oc.role === 'side')) {
      const taken = [...w.veins.values()].some(
        (p) => p.head.type === 'port' && p.head.organId === oc.organ.id && p.head.port === oc.role,
      );
      if (taken) {
        flashMsg('port already has a vein');
        return;
      }
      head = { type: 'port', organId: oc.organ.id, port: oc.role };
      startExcluded = true;
    } else if (oc) {
      flashMsg("can't start a vein on an organ body");
      return;
    } else if ((w.cellSegs.get(c.k)?.length ?? 0) > 0) {
      head = { type: 'fork', veinId: w.cellSegs.get(c.k)![0].vein.id, cellKey: c.k };
      startExcluded = true;
    }
    const drag: DragState = { kind: 'draw', cells: [] };
    dragRef.current = drag;
    dragHeadRef.current = head;
    dragLastRef.current = startExcluded ? c : null;
    if (!startExcluded) drag.cells.push(c);
  };

  const dragHeadRef = useRef<Head>({ type: 'open' });
  const dragLastRef = useRef<{ x: number; y: number; k: string } | null>(null);

  const onMouseMove = (e: React.MouseEvent) => {
    const dr = dragRef.current;
    if (!dr) return;
    const c = cellAt(e);
    if (!c) return;
    const w = worldRef.current;
    if (dr.kind === 'erase') {
      dr.keys.add(c.k);
      return;
    }
    // draw: extend with L-interpolation; machines gate the path
    const cur = dr.cells.length ? dr.cells[dr.cells.length - 1] : dragLastRef.current;
    if (!cur || (cur.x === c.x && cur.y === c.y)) return;
    let { x, y } = cur;
    const stepTo = (nx: number, ny: number): boolean | 'stop' => {
      const k2 = key(nx, ny);
      const oc = w.organCells.get(k2);
      if (w.sourceMap.has(k2)) return false; // can't pass through sources
      if (oc && oc.role === 'body') return false;
      if (oc && oc.role === 'in') {
        dr.endOrganIn = oc.organ.id; // terminate into the organ's intake
        return 'stop';
      }
      if (oc) return false; // out/side ports are starts, not pass-throughs
      if (dr.cells.length >= 2) {
        const prev = dr.cells[dr.cells.length - 2];
        if (prev.x === nx && prev.y === ny) {
          dr.cells.pop(); // dragging backwards undoes the last cell
          return true;
        }
      }
      dr.cells.push({ x: nx, y: ny, k: k2 });
      return true;
    };
    while ((x !== c.x || y !== c.y) && !dr.endOrganIn) {
      if (x !== c.x) x += Math.sign(c.x - x);
      else y += Math.sign(c.y - y);
      if (stepTo(x, y) !== true) break;
    }
  };

  const endDrag = () => {
    const dr = dragRef.current;
    dragRef.current = null;
    if (!dr) return;
    const w = worldRef.current;
    if (dr.kind === 'erase') {
      if (dr.keys.size) {
        checkpoint();
        eraseCells(w, dr.keys);
        setProbes((ps) => ps.filter((pr) => (w.cellSegs.get(pr.cellKey)?.length ?? 0) > 0));
      }
      return;
    }
    let cells = dr.cells;
    let tail: Tail = { type: 'open' };
    if (dr.endOrganIn) tail = { type: 'organ-in', organId: dr.endOrganIn };
    else if (cells.length >= 2) {
      // releasing on an existing vein merges into it
      const lastC = cells[cells.length - 1];
      const segs = w.cellSegs.get(lastC.k);
      if (segs && segs.length) {
        tail = { type: 'merge', veinId: segs[0].vein.id, cellKey: lastC.k };
        cells = cells.slice(0, -1);
      }
    }
    if (cells.length < 2) {
      if (dragHeadRef.current.type !== 'open' || dr.endOrganIn) flashMsg('vein too short');
      return;
    }
    checkpoint();
    commitVein(w, cells, dragHeadRef.current, tail);
  };

  const onDblClick = (e: React.MouseEvent) => {
    const c = cellAt(e);
    if (!c) return;
    const snap = snapshotWorld(worldRef.current);
    const res = tryBud(worldRef.current, c.k);
    if (res.ok) pushUndo(snap);
    flashMsg(res.msg);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!godModeRef.current) return;
    const c = cellAt(e);
    if (c) addProbe(c);
  };

  // ---- world adoption (presets, import, #world= links) ----

  const adoptWorld = (world: World) => {
    checkpoint();
    worldRef.current = world;
    setProbes([]);
    setStick({ ...chem.stick });
    setUiTick((t) => t + 1);
  };

  useEffect(() => {
    const loadFromHash = async () => {
      const m = window.location.hash.match(/^#world=(.+)$/);
      if (!m) return;
      try {
        adoptWorld(await worldFromCode(chem, decodeURIComponent(m[1])));
      } catch {
        window.alert('Could not load the world from this link.');
      }
    };
    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    return () => window.removeEventListener('hashchange', loadFromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [shareLabel, setShareLabel] = useState('Share link');
  const [exportLabel, setExportLabel] = useState('Export');
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
      adoptWorld(await worldFromCode(chem, code));
    } catch {
      window.alert('Could not read that world code.');
    }
  };

  const setStickFor = (r: string, v: number) => {
    const next = { ...stick, [r]: v };
    setStick(next);
    chem.setStickiness(next);
  };

  // debug handle for the e2e suites (dev server only)
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__veins = {
        world: () => worldRef.current,
        chem,
        tick: () => doTick(worldRef.current),
      };
    }
  }, []);

  const w = worldRef.current;
  void uiTick; // charts + toolbar re-render on the pulse

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Veins</h1>
        <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>
          Draw
        </button>
        <button className={tool === 'erase' ? 'active' : ''} onClick={() => setTool('erase')}>
          Erase
        </button>
        {godMode && (
          <button className={tool === 'probe' ? 'active' : ''} onClick={() => setTool('probe')}>
            Probe
          </button>
        )}
        <span className="divider" />
        <button className={running ? 'active' : ''} onClick={() => setRunning((r) => !r)} title="Space">
          {running ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => doTick(worldRef.current)}>Step</button>
        <label className="slider">
          speed
          <input
            type="range"
            min={0}
            max={3}
            step={0.02}
            value={Math.log10(tps)}
            onChange={(e) => setTps(Math.max(1, Math.round(10 ** Number(e.target.value))))}
          />
          <span className="mono">{tps} t/s</span>
        </label>
        {godMode && (
          <button className={tempOverlay ? 'active' : ''} onClick={() => setTempOverlay((v) => !v)}>
            Temp
          </button>
        )}
        <button disabled={undoRef.current.length === 0} onClick={undo} title="Ctrl+Z">
          Undo
        </button>
        <button disabled={redoRef.current.length === 0} onClick={redo} title="Ctrl+Shift+Z">
          Redo
        </button>
        <span className="spacer" />
        {flash && <span className="flash">{flash}</span>}
        <label className="checkbox" title="Toggle with G">
          <input type="checkbox" checked={godMode} onChange={(e) => setGodModeTo(e.target.checked)} />
          God mode
        </label>
        <button onClick={shareWorld}>{shareLabel}</button>
        <button onClick={exportWorld}>{exportLabel}</button>
        <button onClick={importWorld}>Import</button>
        <select
          value=""
          onChange={(e) => {
            const preset = PRESETS.find((p) => p.id === e.target.value);
            if (preset) adoptWorld(preset.build(chem));
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
      {godMode && (
        <div className="stickrow">
          <span className="label">stickiness</span>
          {chem.radicals.map((r) => (
            <label key={r.id} className="stick">
              a({r.id})
              <input
                type="range"
                min={0}
                max={4}
                step={0.05}
                value={stick[r.id]}
                onChange={(e) => setStickFor(r.id, Number(e.target.value))}
              />
              <span className="mono">{stick[r.id].toFixed(2)}</span>
            </label>
          ))}
          <span className="mono dim">tick {w.tick}</span>
        </div>
      )}
      <div className="main">
        <div>
          <canvas
            ref={canvasRef}
            width={COLS * CELL}
            height={ROWS * CELL}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            onDoubleClick={onDblClick}
            onContextMenu={onContextMenu}
          />
          <p className="hint">
            drag from a colored <b>source</b> to lay a fed vein · drag from mid-vein to <b>fork</b> (50/50) · end a
            drag on a vein to <b>merge</b>, or on an organ's <b>in</b> port to feed it · <b>double-click</b> a
            straight stretch of vein to bud an organ
            {godMode ? (
              <>
                {' '}
                · <b>right-click</b> any vein cell to probe it
              </>
            ) : (
              <> · the vein's color, width, and flow are all you get — design experiments</>
            )}
          </p>
        </div>
        <div className="panel">
          {godMode ? (
            <ProbePanel
              world={w}
              probes={probes}
              uiTick={uiTick}
              onRemove={(id) => setProbes((ps) => ps.filter((p) => p.id !== id))}
              onClear={() => setProbes([])}
            />
          ) : (
            <div className="help">
              <h2>Field notes</h2>
              <p>
                Something flows in these veins. Its <b>color</b> shows the mixture's ratios — but color is a lossy
                projection, and different mixtures can look identical. Vein <b>width</b> shows how much is flowing.
              </p>
              <p>
                Fluids react when they meet. Reactions never change a stream's color — only experiments reveal
                what's bound to what.
              </p>
              <p>
                Budding an organ on a vein (double-click) grows something that transforms the flow. What, exactly?
                That's yours to find out.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
