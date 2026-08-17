import { fluidColor, speciesColor, tempOf, T_AMB, SCALE } from './chem';
import { CELL, COLS, ROWS, parseKey } from './world';
import type { World } from './world';

// The player's whole view is here: vein geometry, width (amount), color
// (composition ratios), flow direction, sources, organs. Composition
// numbers, temperature, and probes are god-only overlays.

export type Tool = 'draw' | 'erase' | 'probe';

export type DragState =
  | { kind: 'draw'; cells: Array<{ x: number; y: number; k: string }>; endOrganIn?: number }
  | { kind: 'erase'; keys: Set<string> }
  | null;

export interface ViewState {
  world: World;
  godMode: boolean;
  tempOverlay: boolean;
  drag: DragState;
  probes: Array<{ cellKey: string }>;
}

const laneOffsets: Array<[number, number]> = [[0, 0], [-5, -5], [5, 5], [-5, 5], [5, -5]];
const laneOff = (id: number) => laneOffsets[id % laneOffsets.length];

export function drawWorld(canvas: HTMLCanvasElement, view: ViewState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = view.world;
  const chem = w.chem;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // faint grid
  ctx.strokeStyle = '#e2e8eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= COLS; x++) {
    ctx.moveTo(x * CELL + 0.5, 0);
    ctx.lineTo(x * CELL + 0.5, ROWS * CELL);
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.moveTo(0, y * CELL + 0.5);
    ctx.lineTo(COLS * CELL, y * CELL + 0.5);
  }
  ctx.stroke();

  const ctr = (c: { x: number; y: number }, off: [number, number]): [number, number] => [
    c.x * CELL + CELL / 2 + off[0],
    c.y * CELL + CELL / 2 + off[1],
  ];
  const widthOf = (f: number) => Math.min(14, 1.6 + 6.8 * Math.sqrt(Math.max(0, f) / SCALE));

  // temperature underlay (god only): red-hot / blue-cold halos
  if (view.godMode && view.tempOverlay) {
    for (const p of w.veins.values()) {
      const off = laneOff(p.id);
      for (let i = 0; i < p.cells.length; i++) {
        const T = tempOf(chem, p.parcels[i]);
        const d = T - T_AMB;
        if (Math.abs(d) < 0.04) continue;
        const a = Math.min(0.6, Math.abs(d) * 0.45);
        ctx.strokeStyle = d > 0 ? `rgba(235,60,30,${a})` : `rgba(40,110,235,${a})`;
        ctx.lineWidth = widthOf(p.flow[i]) + 8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const [x0, y0] = ctr(p.cells[Math.max(0, i - 1)], off);
        const [x1, y1] = ctr(p.cells[i], off);
        ctx.moveTo((x0 + x1) / 2, (y0 + y1) / 2);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  // veins: dark casing under a fluid core; width ∝ √(radicals/tick)
  for (const p of w.veins.values()) {
    const off = laneOff(p.id);
    ctx.lineCap = 'round';
    for (let i = 0; i < p.cells.length; i++) {
      const [x1, y1] = ctr(p.cells[i], off);
      ctx.strokeStyle = 'rgba(40,50,58,0.9)';
      ctx.lineWidth = widthOf(p.flow[i]) + 3;
      ctx.beginPath();
      if (i > 0) {
        const [x0, y0] = ctr(p.cells[i - 1], off);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      } else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + 0.01, y1);
      }
      ctx.stroke();
    }
    for (let i = 0; i < p.cells.length; i++) {
      const [x1, y1] = ctr(p.cells[i], off);
      ctx.strokeStyle = fluidColor(chem, p.parcels[i].c) ?? '#c9d2d8';
      ctx.lineWidth = widthOf(p.flow[i]);
      ctx.beginPath();
      if (i > 0) {
        const [x0, y0] = ctr(p.cells[i - 1], off);
        ctx.moveTo((x0 + x1) / 2, (y0 + y1) / 2);
        ctx.lineTo(x1, y1);
        if (i === 1) {
          ctx.moveTo(x0, y0);
          ctx.lineTo((x0 + x1) / 2, (y0 + y1) / 2);
        }
      } else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + 0.01, y1);
      }
      ctx.stroke();
    }
    // direction chevrons — flow direction is honest physics, everyone sees it
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 2; i < p.cells.length; i += 4) {
      const [x0, y0] = ctr(p.cells[i - 1], off);
      const [x1, y1] = ctr(p.cells[i], off);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      ctx.beginPath();
      ctx.moveTo(mx + dx * 0.18, my + dy * 0.18);
      ctx.lineTo(mx - dx * 0.1 - dy * 0.16, my - dy * 0.1 + dx * 0.16);
      ctx.lineTo(mx - dx * 0.1 + dy * 0.16, my - dy * 0.1 - dx * 0.16);
      ctx.fill();
    }
  }

  // sources: chips painted with their fluid's color; names are god-only
  // (the player reads the color, not the label)
  for (const s of w.sources) {
    ctx.fillStyle = speciesColor(chem, s.spIdx);
    const x = s.x * CELL;
    const y = s.y * CELL;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, CELL - 2, CELL - 2, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (view.godMode) {
      ctx.fillStyle = '#fff';
      ctx.font = '700 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.name, x + CELL / 2, y + CELL / 2 + 0.5);
    }
  }

  // organs: parchment body + labeled ports (anatomy is visible to everyone)
  for (const o of w.organs.values()) {
    const x = (o.cx - 2) * CELL;
    const y = (o.cy - 2) * CELL;
    const wpx = 5 * CELL;
    ctx.fillStyle = '#e8ddc8';
    ctx.strokeStyle = '#7a6f58';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, wpx - 4, wpx - 4, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6a5f48';
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RADICAL', o.cx * CELL + CELL / 2, o.cy * CELL + 2);
    ctx.fillText('FILTER', o.cx * CELL + CELL / 2, o.cy * CELL + 13);
    const port = (pt: { x: number; y: number }, color: string, label: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(pt.x * CELL + 3, pt.y * CELL + 3, CELL - 6, CELL - 6, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 9px sans-serif';
      ctx.fillText(label, pt.x * CELL + CELL / 2, pt.y * CELL + CELL / 2 + 0.5);
    };
    port(o.portIn, '#4a7a52', 'in');
    port(o.portOut, '#4a5f7a', 'out');
    port(o.portSide, '#9a5f3a', 'rad');
  }

  // drag previews
  const dr = view.drag;
  if (dr?.kind === 'draw' && dr.cells.length) {
    ctx.strokeStyle = 'rgba(60,90,120,0.55)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    dr.cells.forEach((c, i) => {
      const x = c.x * CELL + CELL / 2;
      const y = c.y * CELL + CELL / 2;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  if (dr?.kind === 'erase' && dr.keys.size) {
    ctx.fillStyle = 'rgba(200,60,50,0.3)';
    for (const k of dr.keys) {
      const [x, y] = parseKey(k);
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  // probe markers (god only, like the probes themselves)
  if (view.godMode) {
    view.probes.forEach((pr, i) => {
      const [x, y] = parseKey(pr.cellKey);
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x * CELL + CELL / 2, y * CELL + CELL / 2, CELL * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#222';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x * CELL + CELL / 2 - CELL * 0.62, y * CELL + CELL / 2 - CELL * 0.55);
    });
  }
}
