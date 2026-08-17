import { useMemo } from 'react';
import type { JSX } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { HIST, resolveAttach } from './world';
import type { World } from './world';
import { speciesColor } from './chem';

export interface GraphData {
  rows: Array<Record<string, number>>;
  dead: boolean;
}

export interface Probe {
  id: number;
  veinId: number;
  cellKey: string;
  label: string;
  frozen?: GraphData;
  lastData?: GraphData;
}

const mono = { fontFamily: "'SF Mono','Cascadia Code',Menlo,monospace" };

const btn = {
  font: '600 12px/1 inherit',
  padding: '7px 11px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid #c3ced4',
  background: '#fff',
  color: '#5a6b75',
};

export function ProbePanel(props: {
  world: World;
  probes: Probe[];
  uiTick: number;
  onRemove: (id: number) => void;
  onClear: () => void;
}): JSX.Element {
  const { world, probes, onRemove, onClear } = props;

  // ---- graph data assembly ----
  const graphData = useMemo((): GraphData[] => {
    const w = world;
    const t = w.tick;
    const x0 = Math.max(0, t - HIST + 1);
    const nsp = w.chem.nsp;
    return probes.map((pr) => {
      if (pr.frozen) return pr.frozen;
      const seg = resolveAttach(w, { veinId: pr.veinId, cellKey: pr.cellKey });
      if (!seg) {
        pr.frozen = pr.lastData ?? { rows: [], dead: true };
        return pr.frozen;
      }
      pr.veinId = seg.vein.id;
      const h = seg.vein.hist[seg.idx];
      const rows: Array<Record<string, number>> = [];
      for (let tt = x0; tt <= t; tt++) {
        const base = (tt % HIST) * (nsp + 1);
        const row: Record<string, number> = { t: tt };
        const ok = !!h && !Number.isNaN(h[base + nsp]);
        // only trust slots written within the window
        if (ok && h && t - tt < HIST) {
          for (let s = 0; s < nsp; s++) row[w.chem.species[s]] = h[base + s];
          row.temp = h[base + nsp];
        }
        rows.push(row);
      }
      const data: GraphData = { rows, dead: false };
      pr.lastData = data;
      return data;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probes, props.uiTick]);

  const chem = world.chem;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#6c7d87', fontWeight: 700 }}>
          Probes
        </div>
        {probes.length > 0 &&
          <button style={btn} onClick={onClear}>clear all</button>}
      </div>
      {probes.length === 0 && (
        <div style={{ fontSize: 12, color: '#8a99a2', padding: 10, background: '#fbfcfd', border: '1px dashed #cfd8dd', borderRadius: 8 }}>
          right-click a vein cell (or use the probe tool) to chart its composition &amp; temperature here
        </div>
      )}
      {probes.map((pr, i) => {
        const gd = graphData[i];
        return (
          <div key={pr.id} style={{ background: '#fbfcfd', border: '1px solid #cfd8dd', borderRadius: 8, padding: '6px 8px 2px', marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ ...mono, fontSize: 11.5, color: '#40626f' }}>
                #{i + 1} {pr.label}{gd && gd.dead ? ' (gone)' : ''}
              </span>
              <button
                onClick={() => onRemove(pr.id)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a5372c', fontWeight: 700, fontSize: 13 }}
              >
                ✕
              </button>
            </div>
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={gd ? gd.rows : []} margin={{ top: 4, right: 2, left: -18, bottom: -6 }}>
                  <CartesianGrid stroke="#eef2f4" vertical={false} />
                  <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9 }} />
                  <YAxis yAxisId="c" tick={{ fontSize: 9 }} />
                  <YAxis yAxisId="T" orientation="right" tick={{ fontSize: 9 }} width={28} />
                  <Tooltip
                    contentStyle={{ fontSize: 10.5, fontFamily: mono.fontFamily }}
                    formatter={(v, n) => [Number(v).toFixed(3), n]}
                    labelFormatter={(v) => 'tick ' + v}
                  />
                  {chem.species.map((s, sIdx) => (
                    <Area
                      key={s}
                      yAxisId="c"
                      dataKey={s}
                      stackId="m"
                      type="monotone"
                      stroke={speciesColor(chem, sIdx)}
                      fill={speciesColor(chem, sIdx)}
                      fillOpacity={0.8}
                      strokeWidth={0.5}
                      isAnimationActive={false}
                    />
                  ))}
                  <Line
                    yAxisId="T"
                    dataKey="temp"
                    type="monotone"
                    stroke="#111"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
