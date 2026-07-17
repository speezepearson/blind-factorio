import {
  DX, DY, cellKey, machineCellMap, orientPath, parseKey, perimeterSegments, placeMachine,
} from './geom';
import type { PlacedMachine } from './geom';
import { SCALE, TYPE_BY_ID, paleTint, totalRate } from './machines';
import { placeAll, pumpKey } from './sim';
import type { SimState } from './sim';
import { machinePlacementOk, squareTL } from './clipboard';
import type { Clipboard } from './clipboard';
import type { Cell, Side, World } from './types';

export const GRID_W = 170;
export const GRID_H = 110;
export const CELL = 6;

// --- world-locked warp field ------------------------------------------------
// Smooth value noise anchored to map pixels. Outside god mode the tool square
// is drawn through this fixed field, so its apparent shape undulates as it
// moves across the world — purely cosmetic; the real region stays a square.

function latticeHash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = latticeHash(ix, iy, seed);
  const b = latticeHash(ix + 1, iy, seed);
  const c = latticeHash(ix, iy + 1, seed);
  const d = latticeHash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// displacement (in px) of the warp field at map-pixel (px, py)
function warpOffset(px: number, py: number, ampPx: number, scalePx: number): [number, number] {
  return [
    (valueNoise(px / scalePx, py / scalePx, 0x9e3779b9) * 2 - 1) * ampPx,
    (valueNoise(px / scalePx, py / scalePx, 0x7f4a7c15) * 2 - 1) * ampPx,
  ];
}

// Set the current path to the rect with its perimeter displaced through the
// warp field, sampled every few px so the wobble stays smooth.
function traceWarpedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  ampPx: number, scalePx: number,
): void {
  const corners: Array<[number, number]> = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      const [dx, dy] = warpOffset(px, py, ampPx, scalePx);
      if (first) {
        ctx.moveTo(px + dx, py + dy);
        first = false;
      } else ctx.lineTo(px + dx, py + dy);
    }
  }
  ctx.closePath();
}

export type Tool =
  | { kind: 'pipe' }
  | { kind: 'copy' }
  | { kind: 'erase' }
  | { kind: 'edit' }
  | { kind: 'place'; typeId: string };

export type DragState =
  | { mode: 'pipe'; path: Cell[] }
  | { mode: 'erase'; last: Cell }
  | { mode: 'move'; machineId: number; grab: Cell; moved?: boolean } // grab = cursor offset from origin
  | null;

// Everything the draw code reads, gathered from the component's refs/state.
export interface ViewState {
  world: World;
  sim: SimState;
  godMode: boolean;
  toolBlur: number; // blur radius on the copy/erase square outside god mode, in cells
  warpAmp: number; // how far the square's drawn edges wander outside god mode, in cells
  warpScale: number; // feature size of the warp field, in cells
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
  // players get no grid at all; god mode gets the fine grid plus an accent
  // line every SCALE cells (the machine-authoring pitch)
  if (view.godMode) {
    const strides: Array<[string, number]> = [['#f3f1ea', 1], ['#e0dcd2', SCALE]];
    for (const [style, stride] of strides) {
      ctx.strokeStyle = style;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= GRID_W; x += stride) {
        ctx.moveTo(x * CELL + 0.5, 0);
        ctx.lineTo(x * CELL + 0.5, GRID_H * CELL);
      }
      for (let y = 0; y <= GRID_H; y += stride) {
        ctx.moveTo(0, y * CELL + 0.5);
        ctx.lineTo(GRID_W * CELL, y * CELL + 0.5);
      }
      ctx.stroke();
    }
  }

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
    const hidden = !view.godMode;
    ctx.globalAlpha = alpha;
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
  const drag = view.drag;
  if (drag?.mode === 'pipe') {
    for (const { cell, inSide, outSide } of orientPath(drag.path)) {
      if (!occupied.has(cellKey(cell[0], cell[1]))) {
        drawPumpBase(cell[0], cell[1], 0.55);
        drawPumpArrow(cell[0], cell[1], inSide, outSide, null, 0, 0.55);
      }
    }
  }

  // copy/paste and erase previews — the true cursor-centered square, but
  // outside god mode its outline is warped through the world-locked noise
  // field and blurred, so its exact position and edges can't be pinned down
  const t = view.tool;
  const hc = view.hoverCell;
  if ((t.kind === 'copy' || t.kind === 'erase') && hc) {
    const clip = t.kind === 'copy' ? view.clipboard : null;
    const n = clip ? clip.size : view.copyCells;
    const [tlx, tly] = squareTL(hc, n);
    const [fill, line] =
      t.kind === 'erase'
        ? ['rgba(214, 60, 60, 0.14)', '#d63c3c']
        : clip
          ? ['rgba(47, 127, 209, 0.16)', '#2f7fd1']
          : ['rgba(74, 70, 64, 0.13)', '#4a4640'];
    ctx.save();
    if (!view.godMode && view.toolBlur > 0) ctx.filter = `blur(${view.toolBlur * CELL}px)`;
    const ampPx = view.godMode ? 0 : view.warpAmp * CELL;
    if (ampPx > 0) {
      traceWarpedRect(ctx, tlx * CELL, tly * CELL, n * CELL, n * CELL, ampPx, view.warpScale * CELL);
    } else {
      ctx.beginPath();
      ctx.rect(tlx * CELL + 0.5, tly * CELL + 0.5, n * CELL, n * CELL);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    if (clip?.snapshot) {
      // ghost of what the copied region looked like at copy time, clipped to
      // the (possibly warped) square
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(clip.snapshot, tlx * CELL, tly * CELL, n * CELL, n * CELL);
      ctx.restore();
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

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

  // hover highlight
  if (hc && t.kind === 'pipe') {
    ctx.strokeStyle = 'rgba(60,60,60,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(hc[0] * CELL + 1, hc[1] * CELL + 1, CELL - 2, CELL - 2);
  }
}
