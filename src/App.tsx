import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RADICALS, buildChemistry, reactParcel, tempOf } from './chem';
import type { Parcel } from './chem';
import {
  doTick, ensureHist, eraseNear, eraseSpan, extendVeinHead, extendVeinTail, organAt, snapshotWorld,
  sourceAt, tryBud, commitVein, resolveAttach, uniteVeins, veinSpanAt,
} from './world';
import type { Head, Tail, Vein, World } from './world';
import { R_SNAP, WORLD_H, WORLD_W, dist, resample, smooth } from './geom';
import type { Pt } from './geom';
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
  // god-only species-streams view: parallel per-species ribbons on the veins
  const [streams, setStreams] = useState(false);
  // God mode = the designer's view: probes, temperature, stickiness,
  // labels. Off (the default) = the player's view: color, width, and flow
  // direction are the only windows into the chemistry.
  const [godMode, setGodMode] = useState(false);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [stick, setStick] = useState({ ...chem.stick });
  const [ambient, setAmbient] = useState(chem.ambient);
  const [uiTick, setUiTick] = useState(0);

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const runningRef = useRef(running);
  runningRef.current = running;
  const tpsRef = useRef(tps);
  tpsRef.current = tps;
  const overlayRef = useRef(tempOverlay);
  overlayRef.current = tempOverlay;
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const godModeRef = useRef(godMode);
  godModeRef.current = godMode;
  const probesRef = useRef(probes);
  probesRef.current = probes;
  const dragRef = useRef<DragState>(null);
  const dragHeadRef = useRef<Head>({ type: 'open' });
  const dragExtendRef = useRef<number | null>(null); // vein whose open tail this stroke continues
  const eraseHoverRef = useRef<{ veinId: number; i0: number; i1: number } | null>(null);
  const nextProbeId = useRef(1);
  // the cursor probe: the vein node under the mouse (god mode only). Bumps
  // the ui pulse only when the hovered NODE changes, not per mouse pixel.
  const cursorRef = useRef<{ veinId: number; idx: number } | null>(null);
  const setCursorProbe = (next: { veinId: number; idx: number } | null) => {
    const cur = cursorRef.current;
    if (next?.veinId === cur?.veinId && next?.idx === cur?.idx) return;
    cursorRef.current = next;
    setUiTick((t) => t + 1);
  };

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2600);
  };

  // ---- undo/redo: whole-world snapshots per mutating gesture ----

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
        let cursorPt: Pt | null = null;
        const cp = cursorRef.current;
        if (cp && godModeRef.current) {
          const v = worldRef.current.veins.get(cp.veinId);
          if (v && cp.idx < v.pts.length) cursorPt = v.pts[cp.idx];
        }
        drawWorld(cv, {
          world: worldRef.current,
          godMode: godModeRef.current,
          tempOverlay: overlayRef.current,
          streams: streamsRef.current,
          drag: dragRef.current,
          probes: probesRef.current,
          eraseHover: eraseHoverRef.current,
          cursor: cursorPt,
          phase: worldRef.current.tick + Math.max(0, Math.min(1, acc)),
          timeMs: now,
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
      cursorRef.current = null;
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

  // ---- mouse: freehand draw / erase brush / probe / bud ----

  const ptAt = (e: { clientX: number; clientY: number }): Pt | null => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * WORLD_W;
    const y = ((e.clientY - r.top) / r.height) * WORLD_H;
    if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) return null;
    return [x, y];
  };

  const addProbe = (pt: Pt) => {
    const w = worldRef.current;
    const refs = w.nodeHash.near(pt, R_SNAP);
    if (refs.length === 0) {
      flashMsg('no vein to probe there');
      return;
    }
    // one probe per distinct vein under the click, at its nearest node
    const byVein = new Map<number, (typeof refs)[number]>();
    for (const ref of refs) {
      const cur = byVein.get(ref.vein.id);
      if (!cur || dist(ref.pt, pt) < dist(cur.pt, pt)) byVein.set(ref.vein.id, ref);
    }
    const added: Probe[] = [];
    for (const ref of byVein.values()) {
      ref.vein.probed = true;
      if (!ensureHist(w, ref.vein, ref.idx)) {
        flashMsg('probe storage is full — remove some probes');
        continue;
      }
      added.push({
        id: nextProbeId.current++,
        veinId: ref.vein.id,
        x: ref.pt[0],
        y: ref.pt[1],
        label: `(${Math.round(ref.pt[0])},${Math.round(ref.pt[1])})${byVein.size > 1 ? ' ·vein ' + ref.vein.id : ''}`,
      });
    }
    setProbes((ps) => [...ps, ...added]);
  };

  // Can the pen move from a to b without crossing a source or an organ
  // body? (Sampled every ~4px; ports are pass-approachable, bodies not.)
  const segClear = (a: Pt, b: Pt): boolean => {
    const w = worldRef.current;
    const steps = Math.max(1, Math.ceil(dist(a, b) / 4));
    for (let s = 1; s <= steps; s++) {
      const pt: Pt = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
      if (sourceAt(w, pt)) return false;
      const oc = organAt(w, pt);
      if (oc && !oc.port) return false;
    }
    return true;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const pt = ptAt(e);
    if (!pt) return;
    const w = worldRef.current;
    if (toolRef.current === 'probe') {
      if (godModeRef.current) addProbe(pt);
      return;
    }
    if (toolRef.current === 'erase') {
      // shift-click: sever the whole junction-to-junction stretch at once
      if (e.shiftKey) {
        const span = veinSpanAt(w, pt);
        if (span) {
          checkpoint();
          eraseSpan(w, span.vein.id, span.i0, span.i1);
          setProbes((ps) => ps.filter((pr) => w.nodeHash.nearest([pr.x, pr.y], R_SNAP) !== null));
          eraseHoverRef.current = null;
        }
        return;
      }
      dragRef.current = { kind: 'erase', pts: [pt] };
      return;
    }
    // draw: what does this vein grow out of?
    dragExtendRef.current = null;
    let head: Head = { type: 'open' };
    const src = sourceAt(w, pt);
    const oc = organAt(w, pt);
    if (src) {
      head = { type: 'source', spIdx: src.spIdx };
    } else if (oc?.port && oc.port.dir === 'out') {
      const key = oc.port.key;
      const taken = [...w.veins.values()].some(
        (p) => p.head.type === 'port' && p.head.organId === oc.organ.id && p.head.port === key,
      );
      if (taken) {
        flashMsg('port already has a vein');
        return;
      }
      head = { type: 'port', organId: oc.organ.id, port: key };
    } else if (oc) {
      flashMsg("can't start a vein on an organ body");
      return;
    } else {
      // an open TAIL endpoint within reach snaps: the stroke continues that
      // vein (no fork, no 50/50 split); otherwise a nearby node forks
      let bestD = R_SNAP + 1e-9;
      for (const p of w.veins.values()) {
        if (p.tail.type !== 'open') continue;
        const d = dist(p.pts[p.pts.length - 1], pt);
        if (d < bestD) {
          bestD = d;
          dragExtendRef.current = p.id;
        }
      }
      if (dragExtendRef.current === null) {
        const ref = w.nodeHash.nearest(pt, R_SNAP);
        if (ref) head = { type: 'fork', veinId: ref.vein.id, at: [ref.pt[0], ref.pt[1]] };
      }
    }
    dragHeadRef.current = head;
    dragRef.current = { kind: 'draw', pts: head.type === 'open' && dragExtendRef.current === null ? [pt] : [] };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const dr = dragRef.current;
    const pt = ptAt(e);
    // erase + shift hover: preview the junction-to-junction stretch a
    // shift-click would sever
    if (!dr && toolRef.current === 'erase') {
      if (pt && e.shiftKey) {
        const span = veinSpanAt(worldRef.current, pt);
        eraseHoverRef.current = span ? { veinId: span.vein.id, i0: span.i0, i1: span.i1 } : null;
      } else {
        eraseHoverRef.current = null;
      }
    } else if (eraseHoverRef.current) {
      eraseHoverRef.current = null;
    }
    if (godModeRef.current && !dr && pt) {
      const nref = worldRef.current.nodeHash.nearest(pt, R_SNAP);
      setCursorProbe(nref ? { veinId: nref.vein.id, idx: nref.idx } : null);
    } else {
      setCursorProbe(null);
    }
    if (!dr) return;
    if (!pt) return;
    const w = worldRef.current;
    if (dr.kind === 'erase') {
      const last = dr.pts[dr.pts.length - 1];
      if (dist(last, pt) >= 3) dr.pts.push(pt);
      return;
    }
    if (dr.endOrganIn !== undefined) return; // already terminated into an organ
    const oc = organAt(w, pt);
    if (oc?.port && oc.port.dir === 'in') {
      dr.endOrganIn = { organId: oc.organ.id, port: oc.port.key }; // the drag ends in the organ's mouth
      return;
    }
    const last = dr.pts[dr.pts.length - 1];
    if (last && dist(last, pt) < 2.5) return;
    // the pen can't pass through sources or organ bodies — route around
    if (last && !segClear(last, pt)) return;
    if (!last && (sourceAt(w, pt) || (oc && !oc.port))) return;
    dr.pts.push(pt);
  };

  // the nearest vein whose OPEN HEAD endpoint is within snap range of pt
  const openHeadNear = (w: World, pt: Pt, excludeId?: number): Vein | null => {
    let best: Vein | null = null;
    let bd = R_SNAP + 1e-9;
    for (const p of w.veins.values()) {
      if (p.id === excludeId || p.head.type !== 'open') continue;
      const d = dist(p.pts[0], pt);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  const endDrag = () => {
    const dr = dragRef.current;
    dragRef.current = null;
    const extendId = dragExtendRef.current;
    dragExtendRef.current = null;
    if (!dr) return;
    const w = worldRef.current;
    if (dr.kind === 'erase') {
      if (dr.pts.length) {
        checkpoint();
        eraseNear(w, dr.pts);
        setProbes((ps) => ps.filter((pr) => w.nodeHash.nearest([pr.x, pr.y], R_SNAP) !== null));
      }
      return;
    }
    // started on a vein's open tail: the stroke CONTINUES that vein
    const extend = extendId !== null ? w.veins.get(extendId) : undefined;
    if (extend && extend.tail.type === 'open') {
      const joinPt = extend.pts[extend.pts.length - 1];
      // seed the resample with the join point so a fast flick can't leave a
      // wide gap between the old tail and the first new node
      let pts = resample(smooth([joinPt, ...dr.pts]));
      while (pts.length && dist(pts[0], joinPt) < 8) pts.shift();
      if (pts.length === 0) return; // a bare click on the tail: nothing to add
      const last = pts[pts.length - 1];
      if (dr.endOrganIn !== undefined) {
        // the stroke terminates exactly on the in port, like a merge does
        // on its junction node — no visible gap at the membrane
        const o = w.organs.get(dr.endOrganIn.organId);
        const tp = o?.ports.find((q) => q.key === dr.endOrganIn!.port);
        if (tp) {
          pts = resample(smooth([joinPt, ...dr.pts, tp.pt]));
          while (pts.length && dist(pts[0], joinPt) < 8) pts.shift();
          while (pts.length && dist(pts[pts.length - 1], tp.pt) < 8) pts.pop();
          pts.push([tp.pt[0], tp.pt[1]]);
        }
        checkpoint();
        extendVeinTail(w, extend, pts, { type: 'organ-in', organId: dr.endOrganIn.organId, port: dr.endOrganIn.port });
        return;
      }
      // bridging into another vein's open head fuses all three into one
      const headVein = openHeadNear(w, last, extend.id);
      if (headVein) {
        // seed both ends so the bridge meets each vein at ~SEG spacing
        pts = resample(smooth([joinPt, ...dr.pts, headVein.pts[0]]));
        while (pts.length && dist(pts[0], joinPt) < 8) pts.shift();
        while (pts.length && dist(pts[pts.length - 1], headVein.pts[0]) < 8) pts.pop();
        checkpoint();
        uniteVeins(w, extend, pts, headVein);
        return;
      }
      let tail: Tail = { type: 'open' };
      const ref = w.nodeHash.nearest(last, R_SNAP);
      if (ref && ref.vein.id !== extend.id) {
        tail = { type: 'merge', veinId: ref.vein.id, at: [ref.pt[0], ref.pt[1]] };
        // the appended tail terminates exactly on the junction node — the
        // stroke can't overshoot (or stop short of) the vein it merges into
        pts = resample(smooth([joinPt, ...dr.pts, ref.pt]));
        while (pts.length && dist(pts[0], joinPt) < 8) pts.shift();
        while (pts.length && dist(pts[pts.length - 1], ref.pt) < 8) pts.pop();
        pts.push([ref.pt[0], ref.pt[1]]);
      }
      checkpoint();
      extendVeinTail(w, extend, pts, tail);
      return;
    }

    // a near-zero-movement click (e.g. half of a bud double-click) stays
    // silent; one that connected to something — a source/fork head or an
    // organ mouth — complains. Bailing this early also keeps the seeds
    // below from fabricating a vein out of a jiggled click.
    if (dr.pts.length < 2) {
      if (dr.pts.length >= 1 && (dragHeadRef.current.type !== 'open' || dr.endOrganIn !== undefined)) {
        flashMsg('vein too short');
      }
      return;
    }
    const head = dragHeadRef.current;
    // a fork sprouts from its host node exactly, and a port head from its
    // port point: seed the resample so the stroke's first node lands on the
    // anchor instead of up to R_SNAP (or PORT_R) away
    const headPt: Pt | null =
      head.type === 'fork'
        ? head.at
        : head.type === 'port'
          ? (w.organs.get(head.organId)?.ports.find((q) => q.key === head.port)?.pt ?? null)
          : null;
    const seeded = (endPt?: Pt): Pt[] => {
      const raw: Pt[] = headPt ? [headPt, ...dr.pts] : [...dr.pts];
      if (endPt) raw.push(endPt);
      return resample(smooth(raw));
    };
    let pts = seeded();
    let tail: Tail = { type: 'open' };
    let prependTo: Vein | null = null;
    if (dr.endOrganIn !== undefined) {
      tail = { type: 'organ-in', organId: dr.endOrganIn.organId, port: dr.endOrganIn.port };
      // terminate exactly on the in port, like a merge on its junction node
      const o = w.organs.get(dr.endOrganIn.organId);
      const tp = o?.ports.find((q) => q.key === dr.endOrganIn!.port);
      if (tp) {
        pts = seeded(tp.pt);
        while (pts.length && dist(pts[pts.length - 1], tp.pt) < 8) pts.pop();
        pts.push([tp.pt[0], tp.pt[1]]);
      }
    } else {
      const last = pts[pts.length - 1];
      // ending on a vein's open HEAD feeds it: the stroke becomes its new
      // upstream portion (endpoint snap beats mid-vein merge)
      const hv = openHeadNear(w, last);
      if (hv && !(head.type === 'fork' && head.veinId === hv.id)) {
        prependTo = hv;
      } else {
        const ref = w.nodeHash.nearest(last, R_SNAP);
        if (ref) {
          tail = { type: 'merge', veinId: ref.vein.id, at: [ref.pt[0], ref.pt[1]] };
          // the drawn tail terminates exactly on the junction node — the
          // stroke can't overshoot (or stop short of) the vein it merges into
          pts = seeded(ref.pt);
          while (pts.length && dist(pts[pts.length - 1], ref.pt) < 8) pts.pop();
          pts.push([ref.pt[0], ref.pt[1]]);
        }
      }
    }
    if (prependTo) {
      // seed the join end so the stroke meets the head at ~SEG spacing
      pts = seeded(prependTo.pts[0]);
      while (pts.length && dist(pts[pts.length - 1], prependTo.pts[0]) < 8) pts.pop();
      if (pts.length === 0) return;
      checkpoint();
      extendVeinHead(w, prependTo, pts, head);
      return;
    }
    if (pts.length < 2) {
      flashMsg('vein too short'); // a microscopic stroke merged on release
      return;
    }
    checkpoint();
    commitVein(w, pts, head, tail);
  };

  const onDblClick = (e: React.MouseEvent) => {
    const pt = ptAt(e);
    if (!pt) return;
    const snap = snapshotWorld(worldRef.current);
    const res = tryBud(worldRef.current, pt);
    if (res.ok) pushUndo(snap);
    flashMsg(res.msg);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!godModeRef.current) return;
    const pt = ptAt(e);
    if (pt) addProbe(pt);
  };

  // ---- world adoption (presets, import, #world= links) ----

  const adoptWorld = (world: World) => {
    checkpoint();
    worldRef.current = world;
    setProbes([]);
    setStick({ ...chem.stick });
    setAmbient(chem.ambient);
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

  const setAmbientTo = (v: number) => {
    setAmbient(v);
    chem.setAmbient(v);
  };

  // debug handle for the e2e suites (dev server only). tempOf is exposed so
  // tests read temperature through the real formula instead of duplicating
  // physics constants.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__veins = {
        world: () => worldRef.current,
        chem,
        tick: () => doTick(worldRef.current),
        tempOf: (p: Parcel) => tempOf(chem, p),
        reactParcel: (p: Parcel) => reactParcel(chem, p),
        resolveAttach: (att: { veinId: number; at: Pt }) => resolveAttach(worldRef.current, att),
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
        {godMode && (
          <button
            className={streams ? 'active' : ''}
            onClick={() => setStreams((v) => !v)}
            title="one ribbon per species, width ∝ count"
          >
            Streams
          </button>
        )}
        <button disabled={undoRef.current.length === 0} onClick={undo} title="Ctrl+Z">
          Undo
        </button>
        <button disabled={redoRef.current.length === 0} onClick={redo} title="Ctrl+Shift+Z">
          Redo
        </button>
        <span className="spacer" />
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
                min={-6}
                max={4}
                step={0.05}
                value={stick[r.id]}
                onChange={(e) => setStickFor(r.id, Number(e.target.value))}
              />
              <span className="mono">{stick[r.id].toFixed(2)}</span>
            </label>
          ))}
          {/* log-scale: ambient spans 0.05..10, and the interesting moves
              are multiplicative (halve it, double it) */}
          <label className="stick">
            T&#8734;
            <input
              type="range"
              min={Math.log10(0.05)}
              max={1}
              step="any"
              value={Math.log10(ambient)}
              onChange={(e) => setAmbientTo(Number((10 ** Number(e.target.value)).toPrecision(3)))}
            />
            <span className="mono">{ambient.toFixed(2)}</span>
          </label>
          <span className="mono dim">tick {w.tick}</span>
        </div>
      )}
      <div className="main">
        <div className="stage">
          {/* the flash floats over the canvas so it never reflows the layout
              (a toolbar reflow would move the canvas mid-gesture) */}
          {flash && <span className="flash">{flash}</span>}
          <canvas
            ref={canvasRef}
            width={WORLD_W}
            height={WORLD_H}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={() => {
              endDrag();
              eraseHoverRef.current = null;
              setCursorProbe(null);
            }}
            onDoubleClick={onDblClick}
            onContextMenu={onContextMenu}
          />
          <p className="hint">
            drag freehand from a colored <b>source</b> to lay a fed vein · start on a vein to <b>fork</b> (50/50) —
            starting on a loose end <b>extends</b> it instead · release on a vein to <b>merge</b>, on a loose start to
            <b> fuse</b>, or in an organ's <b>in</b> port to feed it · <b>double-click</b> a vein to bud an organ ·
            in erase mode, <b>shift-click</b> severs a whole stretch
            {godMode ? (
              <>
                {' '}
                · <b>right-click</b> any vein to probe it
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
              cursor={cursorRef.current}
              onRemove={(id) => setProbes((ps) => ps.filter((p) => p.id !== id))}
              onClear={() => setProbes([])}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
