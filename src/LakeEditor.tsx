import { lakeIsStill } from './warp';
import type { LakeLayer } from './warp';

const LAKE_FIELDS: Array<{ key: keyof LakeLayer; label: string; min: number; max: number; step: number }> = [
  { key: 'waveDir', label: 'dir °', min: 0, max: 360, step: 5 },
  { key: 'waveSpeed', label: 'speed c/s', min: 0, max: 10, step: 0.5 },
  { key: 'magnitude', label: 'magnitude c', min: 0, max: 5, step: 0.25 },
  { key: 'wavelength', label: 'wavelength c', min: 2, max: 60, step: 1 },
  { key: 'timeScale', label: 'time scale /s', min: 0, max: 3, step: 0.1 },
];

export function LakeEditor({ layers, onChange }: { layers: LakeLayer[]; onChange: (layers: LakeLayer[]) => void }) {
  return (
    <details className="lake-editor">
      <summary>
        Lake ripple layers ({layers.length}
        {lakeIsStill(layers) ? ', still' : ''})
      </summary>
      <table>
        <thead>
          <tr>
            {LAKE_FIELDS.map((f) => (
              <th key={f.key}>{f.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {layers.map((layer, i) => (
            <tr key={i}>
              {LAKE_FIELDS.map((f) => (
                <td key={f.key}>
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={layer[f.key]}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (!Number.isFinite(v)) return;
                      onChange(layers.map((l, j) => (j === i ? { ...l, [f.key]: v } : l)));
                    }}
                  />
                </td>
              ))}
              <td>
                <button
                  title="Remove this layer"
                  onClick={() => onChange(layers.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          onChange([
            ...layers,
            { waveDir: 0, waveSpeed: 1, magnitude: 1, wavelength: 12, timeScale: 1 },
          ])
        }
      >
        + Add layer
      </button>
    </details>
  );
}
