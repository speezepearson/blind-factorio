import {
  CELL, DX, DY, cellKey, machineCellMap, orientPath, perimeterSegments, placeMachine,
} from './geom';
import type { PlacedMachine } from './geom';
import { TYPE_BY_ID, paleTint, totalRate } from './machines';
import { mixtureColor, wavelengthColor } from './light';
import { placeAll } from './sim';
import type { SimState } from './sim';
import { machinePlacementOk, bboxTL } from './clipboard';
import type { Clipboard } from './clipboard';
import type { Cell, ParamValue, Side, World } from './types';

export type Tool =
  | { kind: 'pipe' }
  | { kind: 'copy' }
  | { kind: 'erase' }
  | { kind: 'edit' }
  | { kind: 'place'; typeId: string };

export type DragState =
  | { mode: 'pipe'; path: Cell[]; extendId?: number } // extendId: pipeline being continued from its dangling tail
  | { mode: 'lasso'; tool: 'copy' | 'erase'; points: Array<[number, number]> } // points in map px
  | { mode: 'move'; machineId: number; grab: Cell; moved?: boolean } // grab = cursor offset from origin
  | null;

// Everything the draw code reads, gathered from the component's refs/state.
export interface ViewState {
  world: World;
  sim: SimState;
  godMode: boolean;
  copyCells: number; // the copy region side in fine cells
  tool: Tool;
  hoverCell: Cell | null;
  drag: DragState;
  clipboard: Clipboard | null;
  selectedId: number | null;
  placeRotation: number;
}

export function drawWorld(canvas: HTMLCanvasElement, view: ViewState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { world, sim } = view;
  const placed = placeAll(world);
  const occupied = machineCellMap(placed);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const edgeMid = (x: number, y: number, s: Side): [number, number] => [
    x * CELL + CELL / 2 + (DX[s] * CELL) / 2,
    y * CELL + CELL / 2 + (DY[s] * CELL) / 2,
  ];

  const drawPipeBase = (x: number, y: number, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    ctx.globalAlpha = 1;
  };

  const drawPipeSegment = (x: number, y: number, inSide: Side, outSide: Side, fluidColor: string | null, rate: number, alpha = 1) => {
    ctx.globalAlpha = alpha;
    // empty pipes: narrow faint lines; carrying pipes: the fluid's light
    // (black, if it's all invisible infrared), width ~ sqrt(rate)
    const color = fluidColor ?? '#c6c9ce';
    const [ix, iy] = edgeMid(x, y, inSide);
    const [ox, oy] = edgeMid(x, y, outSide);
    const cx = x * CELL + CELL / 2;
    const cy = y * CELL + CELL / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = fluidColor ? Math.min(CELL, Math.max(1.2, 1.6 * Math.sqrt(rate))) : 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // each pipeline is a polyline; each of its cells draws with the combined
  // light of the fluid at that point (pipelines through the same cell just
  // overdraw each other). Ghost pipes are a faint dashed route.
  for (const pl of world.pipelines) {
    if (pl.ghost) {
      ctx.setLineDash([2.5, 3.5]);
      for (const { cell: [x, y], inSide, outSide } of orientPath(pl.cells)) {
        drawPipeSegment(x, y, inSide, outSide, '#b3ada2', 0);
      }
      ctx.setLineDash([]);
      continue;
    }
    const contents = sim.pipeFluids.get(pl.id);
    orientPath(pl.cells).forEach(({ cell: [x, y], inSide, outSide }, i) => {
      drawPipeBase(x, y);
      const fm = contents?.[i];
      const rate = totalRate(fm);
      drawPipeSegment(x, y, inSide, outSide, rate > 1e-4 ? mixtureColor(fm) : null, rate);
    });
  }

  // junction nodes: a small dot glowing with the summed flow passing through
  for (const j of world.junctions) {
    const fm = sim.junctionFlows.get(j.id);
    const rate = totalRate(fm);
    ctx.beginPath();
    ctx.arc(j.cell[0] * CELL + CELL / 2, j.cell[1] * CELL + CELL / 2, 3.4, 0, 2 * Math.PI);
    ctx.fillStyle = rate > 1e-4 ? mixtureColor(fm) : '#c6c9ce';
    ctx.fill();
    ctx.strokeStyle = '#4a4640';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const drawMachine = (pm: PlacedMachine, alpha = 1, invalid = false) => {
    const hidden = !view.godMode;
    // ghost machines: an unbuilt dashed placeholder, honest in either view
    // (the player laid it down, after all)
    if (pm.machine.ghost) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#f3f1ea';
      for (const [x, y] of pm.cells) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.strokeStyle = '#a9a294';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of perimeterSegments(pm.cells, CELL)) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const cxs = pm.cells.map(([x]) => x * CELL + CELL / 2);
      const cys = pm.cells.map(([, y]) => y * CELL + CELL / 2);
      ctx.fillStyle = '#a9a294';
      ctx.font = 'italic 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        view.godMode ? `ghost ${pm.type.name}` : 'ghost',
        cxs.reduce((a, b) => a + b, 0) / cxs.length,
        cys.reduce((a, b) => a + b, 0) / cys.length,
      );
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = alpha;
    // Springs/sinks are painted exactly like the fluid they produce/want;
    // other machines with a wavelength param wear a pale tint of that light.
    // (Player mode hides all of this behind the anonymous grey.)
    const params: Record<string, ParamValue> = {};
    for (const pd of pm.type.params ?? []) params[pd.key] = pd.default;
    Object.assign(params, pm.machine.params);
    const colorDef = pm.type.params?.find((pd) => pd.kind === 'wavelength');
    const body = pm.type.fluidColor
      ? pm.type.fluidColor(params)
      : colorDef
        ? paleTint(wavelengthColor(Number(params[colorDef.key])))
        : pm.type.bodyColor;
    ctx.fillStyle = invalid ? '#e8a0a0' : hidden ? '#dcd8cf' : body;
    // label ink that stays readable on saturated/dark fluid colors
    const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(body.slice(i, i + 2), 16));
    const ink = hidden || 0.2126 * br + 0.7152 * bg + 0.0722 * bb > 120 ? '#2b2823' : '#f6f3ec';
    for (const [x, y] of pm.cells) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    // glow halo (e.g. a satisfied sink) — deliberately visible to the player
    const glow = pm.type.glow?.(sim.machineStates.get(pm.machine.id) ?? {});
    if (glow) {
      ctx.save();
      ctx.strokeStyle = glow;
      ctx.lineWidth = 6;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of perimeterSegments(pm.cells, CELL)) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      ctx.restore();
    }
    // outline the perimeter
    ctx.strokeStyle = '#4a4640';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of perimeterSegments(pm.cells, CELL)) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
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
      ctx.fillStyle = ink;
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

    // progress bar (e.g. a fabricator's build) — visible even to the player
    const prog = pm.type.progress?.(sim.machineStates.get(pm.machine.id) ?? {});
    if (prog !== null && prog !== undefined) {
      const bx0 = Math.min(...pm.cells.map(([x]) => x)) * CELL + 3;
      const bx1 = (Math.max(...pm.cells.map(([x]) => x)) + 1) * CELL - 3;
      const by = (Math.max(...pm.cells.map(([, y]) => y)) + 1) * CELL - 6;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(bx0, by, bx1 - bx0, 3);
      ctx.fillStyle = prog >= 1 ? '#3fae4a' : '#e04b3a';
      ctx.fillRect(bx0, by, (bx1 - bx0) * Math.max(0, Math.min(1, prog)), 3);
    }

    if (!hidden) {
      // machine name at footprint center
      const cxs = pm.cells.map(([x]) => x * CELL + CELL / 2);
      const cys = pm.cells.map(([, y]) => y * CELL + CELL / 2);
      ctx.fillStyle = ink;
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

  // drag preview: pipe line — god only; players draw blind, guided just by
  // the crosshair cursor
  const drag = view.drag;
  if (view.godMode && drag?.mode === 'pipe') {
    for (const { cell, inSide, outSide } of orientPath(drag.path)) {
      if (!occupied.has(cellKey(cell[0], cell[1]))) {
        drawPipeBase(cell[0], cell[1], 0.55);
        drawPipeSegment(cell[0], cell[1], inSide, outSide, null, 0, 0.55);
      }
    }
  }

  // (the copy/erase/paste selection preview is drawn by drawToolOverlay,
  // on the visible canvas, so region snapshots never capture it)
  const t = view.tool;
  const hc = view.hoverCell;

  // machine placement ghost (god mode)
  if (t.kind === 'place' && hc && !drag) {
    const ghost = placeMachine(
      { id: -1, typeId: t.typeId, origin: hc, rotation: view.placeRotation },
      TYPE_BY_ID[t.typeId],
    );
    drawMachine(ghost, 0.5, !machinePlacementOk(world, ghost));
  }

  // selection outline in edit mode
  if (t.kind === 'edit' && view.selectedId !== null) {
    const sel = placed.find((pm) => pm.machine.id === view.selectedId);
    if (sel) {
      ctx.strokeStyle = '#2f7fd1';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of perimeterSegments(sel.cells, CELL)) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    }
  }

  // hover highlight — god only, same reasoning as the pipe drag preview
  if (view.godMode && hc && t.kind === 'pipe') {
    ctx.strokeStyle = 'rgba(60,60,60,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(hc[0] * CELL + 1, hc[1] * CELL + 1, CELL - 2, CELL - 2);
  }
}

// [fill, stroke] for a selection: erase red, paste blue, fresh copy grey
const selectionColors = (tool: 'copy' | 'erase', clip: Clipboard | null): [string, string] =>
  tool === 'erase'
    ? ['rgba(214, 60, 60, 0.14)', '#d63c3c']
    : clip
      ? ['rgba(47, 127, 209, 0.16)', '#2f7fd1']
      : ['rgba(74, 70, 64, 0.13)', '#4a4640'];

// The copy/paste/erase selection preview, drawn onto the visible canvas
// after the world (so the paste-ghost snapshot never captures it).
export function drawToolOverlay(canvas: HTMLCanvasElement, view: ViewState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const t = view.tool;
  const drag = view.drag;
  const lasso = drag?.mode === 'lasso' ? drag : null;
  const hc = view.hoverCell;
  if (!lasso && !((t.kind === 'copy' || t.kind === 'erase') && hc)) return;

  // Resolve what to draw: the in-progress lasso path, or the cursor-centered
  // square / clipboard outline.
  const clip = !lasso && t.kind === 'copy' ? view.clipboard : null;
  let pts: Array<[number, number]>;
  let ghost: { tlx: number; tly: number } | null = null;
  let colors: [string, string];
  if (lasso) {
    pts = lasso.points;
    colors = selectionColors(lasso.tool, null);
  } else {
    const w = clip ? clip.w : view.copyCells;
    const h = clip ? clip.h : view.copyCells;
    const [tlx, tly] = bboxTL(hc!, w, h);
    const outline = clip
      ? clip.outline
      : ([[0, 0], [w * CELL, 0], [w * CELL, h * CELL], [0, h * CELL]] as Array<[number, number]>);
    pts = outline.map(([x, y]) => [tlx * CELL + x, tly * CELL + y] as [number, number]);
    if (clip?.snapshot) ghost = { tlx, tly };
    colors = selectionColors(t.kind as 'copy' | 'erase', clip);
  }

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
    else ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.closePath();
  ctx.fillStyle = colors[0];
  ctx.fill();
  if (ghost && clip?.snapshot) {
    // ghost of what the copied region looked like at copy time, clipped to
    // the selection outline
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(clip.snapshot, ghost.tlx * CELL, ghost.tly * CELL, clip.w * CELL, clip.h * CELL);
    ctx.restore();
  }
  ctx.strokeStyle = colors[1];
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
